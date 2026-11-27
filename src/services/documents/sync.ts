import { createHash } from "node:crypto"
import { CliError, isCliError } from "@wirecat/cli-base"
import { deadlineMargin } from "../../background/budget.js"
import { catalogFiles } from "../../documents/catalog.js"
import {
  feedOf,
  type IndexedSource,
  type PictureWriter,
  type SourceContent,
  type SourceFile,
  type SourceSkip,
} from "../../documents/model.js"
import { inScope } from "../../documents/scope.js"
import { changedSince, planDocuments, scopeHash, type WalkStop } from "./plan.js"
import type { SyncOptions } from "./ports.js"
import { isPicture as readsAsPicture } from "./scans.js"

const MAX_PICTURE_BYTES = 250 * 1024 * 1024
const SAVE_EVERY_MS = 2000
const SAVE_EVERY_ITEMS = 25
const SETTLE_MS = 10_000
const DAY_MS = 24 * 60 * 60 * 1000
export const KEEP_VERSIONS_FOR_DAYS = 365
const isPicture = (file: SourceFile) => file.mime.startsWith("image/") && file.canDownload
const describe = (ms: number) =>
  ms % DAY_MS === 0
    ? `${ms / DAY_MS} days`
    : ms % 3_600_000 === 0
      ? `${ms / 3_600_000} hours`
      : ms % 60_000 === 0
        ? `${ms / 60_000} minutes`
        : `${ms} ms`
const hashText = (text: string) => createHash("sha256").update(text).digest("hex")
export interface SyncResult {
  saved: number
  names_only: number
  removed: number
  unchanged: number
  pictures?: number
  pictures_too_large?: number
  pictures_skipped?: string
  pending: number
  skipped: { id: string; reason: string }[]
  errors: { id: string; code: string; message: string }[]
  coverage: string
  /** The pass is done: the folder walk finished and no operation is left for another sync. */
  complete: boolean
  /** Why this call stopped before the pass's end: its entry bound (`maxEntries`) or its request budget. */
  stopped?: WalkStop
  /** A folder walk still under way; the next sync goes on from where this one stopped. */
  walk?: { folders_left: number; entries: number; listed: number }
  /** This call started a full walk on its own: the source's `rescanEveryMs` had passed since the last one. */
  rescan?: { why: string; every_ms: number; last_full_walk: string | null }
}
export const syncDocuments = async <M extends SourceFile>(options: SyncOptions<M>): Promise<SyncResult> => {
  const {
    source,
    index,
    state: statePort,
    principal,
    roots,
    textLimit: limit,
    max,
    signal,
    rescan: asked = false,
    pictures = false,
    assertHeld,
    errorOf,
    skipReason,
    storeVersion: VERSION,
    query,
    scans,
  } = options
  if (![max, limit, options.maxEntries].every((value) => Number.isSafeInteger(value) && value > 0))
    throw new CliError("validation_error", "sync limits must be positive whole numbers")
  const profile = { principal, roots, picture_search: pictures }
  const now = options.now ?? Date.now
  const lock = { assertHeld }
  if (signal?.aborted) throw new CliError("cancelled", "sync was cancelled")
  const result: SyncResult = {
    saved: 0,
    names_only: 0,
    removed: 0,
    unchanged: 0,
    pending: 0,
    skipped: [],
    errors: [],
    complete: true,
    coverage:
      query?.mode === "include"
        ? "selected folders and the files a saved query finds; unsupported files are reported"
        : query?.mode === "exclude"
          ? "selected folders only, without the files a saved query keeps out; unsupported files are reported"
          : "selected folders only; unsupported files are reported",
    ...(profile.picture_search ? { pictures: 0 } : {}),
  }
  let writer: PictureWriter | undefined
  let flush: (() => void) | undefined
  try {
    if (
      (profile.roots.length || query?.mode === "include") &&
      (!source || (await source.identity()) !== profile.principal)
    )
      throw new CliError("authentication_error", "signed-in source account does not match this profile", {
        reason: "profile.wrong-account",
      })
    const state = statePort.read()
    if (state.principal !== principal)
      throw new CliError("configuration_error", "sync state belongs to another source account")
    if (options.profile !== undefined) await index.registerProfile?.(options.profile, principal)
    const currentScope = scopeHash(profile.roots, query, options.isDocument !== undefined)
    // Only a source whose feed misses something asks for it, and only between walks: the walk it starts drops the
    // cursor, so the calls that go on with that walk are not due again.
    const every = source ? feedOf(source)?.rescanEveryMs : undefined
    if (every !== undefined && !(Number.isSafeInteger(every) && every > 0))
      throw new CliError("configuration_error", "a source's rescanEveryMs must be a positive whole number")
    const sinceWalk = now() - (state.fullWalkAt ? Date.parse(state.fullWalkAt) : Number.NaN)
    // A walk recorded in the future (a clock set back, a state copied from another machine) would hold it off for good.
    const due =
      !asked &&
      every !== undefined &&
      state.cursor !== undefined &&
      state.scope === currentScope &&
      !(sinceWalk >= 0 && sinceWalk < every)
    if (due)
      result.rescan = {
        why:
          state.fullWalkAt === undefined
            ? "no full walk of the chosen folders is recorded; the source's changes miss some edits, such as a restore"
            : `the last full walk finished ${describe(every)} or more ago; the source's changes miss some edits, ` +
              "such as a restore",
        every_ms: every,
        last_full_walk: state.fullWalkAt ?? null,
      }
    const rescan = asked || due
    if (state.pending && (state.pending.scope !== currentScope || rescan)) {
      // Work the new plan cannot see: a file saved to the index before its state was.
      for (const job of state.pending.jobs)
        if (!state.documents[job.id]) {
          await index.remove(profile.principal, job.id, "unsynced")
          statePort.removeSnapshot(job.id)
        }
      delete state.pending
      // Saved at once: a call the walk cuts short would otherwise find the old batch again and repeat these removals.
      statePort.save(state)
    }
    // A rescan starts the walk over, a saved one included; the cursor is dropped on disk, so the syncs after it
    // continue the walk until it ends.
    if (rescan) {
      delete state.cursor
      statePort.removeWalk()
      statePort.save(state)
    }
    if (!state.pending) {
      const plan = await planDocuments(options, source, state, profile.roots, limit, profile.picture_search ?? false, {
        read: (scope) => statePort.readWalk(scope),
        save: (walk) => statePort.saveWalk(walk),
      })
      if ("walk" in plan) {
        result.complete = false
        result.stopped = plan.walk.stopped
        result.walk = { folders_left: plan.walk.folders_left, entries: plan.walk.entries, listed: plan.walk.listed }
        result.skipped = state.skipped.map(({ id, reason }) => ({ id, reason }))
        return result
      }
      state.pending = plan.pending
      state.skipped = state.pending.skipped
      statePort.save(state)
      statePort.removeWalk()
    }
    const pending = state.pending
    if (!pending) throw new CliError("invalid_response", "could not prepare a sync batch")
    if (index.catalog) await index.catalog.import(profile.principal, catalogFiles(state, profile.roots, query))
    result.skipped = state.skipped.map(({ id, reason }) => ({ id, reason }))
    const saveNamesOnly = async (file: M, reason: string) => {
      const doc: SourceContent<M> = { metadata: file, markdown: "", text: "", tabs: [], notRead: reason }
      const hash = hashText("")
      const previous = state.documents[file.id]
      const reference = await index.save(profile.principal, doc, hash)
      statePort.saveSnapshot(doc)
      state.documents[file.id] = { metadata: file, hash, reference, tabs: 0, notRead: reason }
      if (previous?.notRead === reason && !changedSince(previous.metadata, file)) result.unchanged++
      else result.names_only++
    }
    // A call that has listed nothing makes one request, or a short run never moves.
    const ask = () => {
      const taken = options.budget?.take() ?? null
      return taken === "deadline" && options.budget?.first?.() ? null : taken
    }
    let modelMissing = false
    /** A stop when the budget refuses the download: the file stays pending and the next call fetches it. */
    const savePictureOf = async (file: M): Promise<WalkStop | null> => {
      const entry = state.documents[file.id] as IndexedSource<M>
      if (!profile.picture_search || !isPicture(file) || modelMissing) return null
      if ((file.size ?? 0) > MAX_PICTURE_BYTES) {
        entry.picture = "too-large"
        result.pictures_too_large = (result.pictures_too_large ?? 0) + 1
        return null
      }
      if (!source) throw new CliError("configuration_error", "a pending picture requires source sign-in")
      if (!writer) {
        try {
          writer = await index.openPictures()
        } catch (error) {
          if (!isCliError(error) || error.code !== "not_found") throw error
          modelMissing = true
          result.pictures_skipped = error.message
          return null
        }
      }
      const stop = ask()
      if (stop) return stop
      const bytes = await source.bytes(file.id, file)
      if (bytes.length > MAX_PICTURE_BYTES) {
        entry.picture = "too-large"
        result.pictures_too_large = (result.pictures_too_large ?? 0) + 1
        return null
      }
      if ((await writer.save(entry.reference, bytes)) === "saved") result.pictures = (result.pictures ?? 0) + 1
      entry.picture = "saved"
      return null
    }
    // Saving the whole state after every file grows with the profile; a batch at a time keeps it bounded.
    let unsaved = 0
    let savedAt = now()
    flush = () => {
      if (unsaved) statePort.save(state)
      unsaved = 0
      savedAt = now()
    }
    const progress = () => {
      if (++unsaved >= SAVE_EVERY_ITEMS || now() - savedAt >= SAVE_EVERY_MS) flush?.()
    }
    const jobs = [...pending.jobs].slice(0, max)
    for (const job of jobs) {
      if (signal?.aborted) throw new CliError("cancelled", "sync was cancelled; pending operations are retained")
      lock.assertHeld()
      try {
        if (job.kind === "remove") {
          await index.remove(profile.principal, job.id, job.reason ?? "unavailable")
          statePort.removeSnapshot(job.id)
          delete state.documents[job.id]
          result.removed++
        } else if (job.file && skipReason(job.file)) {
          await saveNamesOnly(job.file, skipReason(job.file) as string)
          const stop = await savePictureOf(job.file)
          if (stop) {
            result.stopped = stop
            break
          }
        } else {
          if (!source) throw new CliError("configuration_error", "a pending save requires source sign-in")
          const picture = scans?.extractor !== undefined && job.file !== undefined && readsAsPicture(job.file)
          // A picture past this sync's OCR page limit is refused without a download, so it takes none of the budget.
          const stop = picture && scans?.full?.() ? null : ask()
          if (stop) {
            result.stopped = stop
            break
          }
          // A scan's text comes from OCR of its bytes, one more download, taken from the budget as a read is.
          const scanned = async (file: M): Promise<SourceContent<M>> => {
            const reader = scans as NonNullable<typeof scans>
            const text = (await reader.read(() => source.bytes(file.id, file), file)).slice(0, limit)
            return { metadata: file, markdown: text, text, tabs: [] }
          }
          let content: SourceContent<M>
          let ocr: string | undefined
          if (picture && job.file) {
            content = await scanned(job.file)
            ocr = scans.extractor
          } else
            try {
              content = await source.content(job.id, limit, job.file)
            } catch (error) {
              if (!scans || !job.file || errorOf(error).details.reason !== "document.needs-ocr") throw error
              const again = scans.full?.() ? null : ask()
              if (again) {
                result.stopped = again
                break
              }
              content = await scanned(job.file)
              ocr = scans.extractor
            }
          const listed =
            query?.mode === "include" && (pending.matched?.includes(job.id) ?? query.matches(content.metadata))
          if (!listed && !inScope(content.metadata, profile.roots, pending.folders, new Set(), query)) {
            await index.remove(profile.principal, job.id, "unsynced")
            statePort.removeSnapshot(job.id)
            delete state.documents[job.id]
            result.removed++
          } else {
            const hash = hashText(content.text)
            const previous = state.documents[job.id]
            const reference = await index.save(profile.principal, content, hash).catch((error: unknown) => {
              if (!isCliError(error) || error.code !== "validation_error") throw error
              throw new CliError("validation_error", `the local store refused this text: ${error.message}`, {
                reason: "store.refused",
                store_refused_in: VERSION,
              })
            })
            statePort.saveSnapshot(content)
            state.documents[job.id] = {
              metadata: content.metadata,
              hash,
              reference,
              tabs: content.tabs.length,
              ...(ocr ? { ocr } : {}),
            }
            if (previous?.hash === hash) result.unchanged++
            else result.saved++
            if (ocr && readsAsPicture(content.metadata)) {
              const stop = await savePictureOf(content.metadata)
              if (stop) {
                result.stopped = stop
                break
              }
            }
          }
        }
        pending.jobs = pending.jobs.filter((item) => item !== job)
        progress()
      } catch (error) {
        const safe = errorOf(error)
        if (safe.code === "cancelled") throw safe
        // A file the sign-in may not read is skipped as a gone one is: retried on every sync, it would hold the pass,
        // and the change cursor with it, for good.
        const kept = job.kind === "save" ? state.documents[job.id] : undefined
        // Text OCR read once stays when reading it again fails, OCR was turned off or its program removed: only an
        // edit of the file makes that text old.
        if (kept?.ocr && job.file && safe.code === "validation_error" && !changedSince(kept.metadata, job.file)) {
          // The new reading was tried: trying it on every sync would spend the page limit on a file it cannot read.
          if (scans?.extractor && safe.details.reason !== "document.scan-later") kept.ocr = scans.extractor
          pending.jobs = pending.jobs.filter((item) => item !== job)
          progress()
          continue
        }
        if (
          job.kind === "save" &&
          (safe.code === "not_found" || safe.code === "permission_error" || safe.code === "validation_error")
        ) {
          const skipped: SourceSkip<M> = {
            id: job.id,
            reason: safe.message,
            ...(job.file ? { file: job.file } : {}),
            ...(safe.details.text_limit ? { textLimit: limit } : {}),
            ...(safe.details.store_refused_in ? { storeRefusedIn: VERSION } : {}),
          }
          let stop: WalkStop | null = null
          if (job.file && safe.code === "validation_error") {
            await saveNamesOnly(job.file, skipped.reason)
            // A picture OCR could not read is still found by what it shows.
            stop = await savePictureOf(job.file)
          } else {
            // A 404 or a refusal says the sign-in cannot read it now, not that it is gone: its text stays.
            await index.remove(profile.principal, job.id, "unavailable")
            statePort.removeSnapshot(job.id)
            delete state.documents[job.id]
          }
          state.skipped = state.skipped.filter((item) => item.id !== job.id)
          state.skipped.push(skipped)
          result.skipped.push({ id: skipped.id, reason: skipped.reason })
          if (stop) {
            result.stopped = stop
            break
          }
          pending.jobs = pending.jobs.filter((item) => item !== job)
          progress()
          continue
        }
        result.errors.push({ id: job.id, code: safe.code, message: safe.message })
      }
    }
    flush()
    result.pending = pending.jobs.length
    result.complete = !pending.jobs.length
    if (!pending.jobs.length) {
      if (!state.cursor || state.scope !== pending.scope) state.fullWalkAt = new Date(now()).toISOString()
      state.cursor = pending.cursor
      state.scope = pending.scope
      state.folders = pending.folders
      if (pending.matched) state.matched = pending.matched
      else delete state.matched
      delete state.pending
      state.lastSync = new Date(now()).toISOString()
      statePort.save(state)
      const days = options.keepVersionsForDays ?? KEEP_VERSIONS_FOR_DAYS
      await index.prune?.(profile.principal, new Date(now() - days * DAY_MS).toISOString())
    }
    // A reader that cannot write finds the text by its words only once it is indexed; a search that can write does it
    // itself, so what this bound leaves, or a failure here, is indexed by the next one. Skipped after a stop, and kept
    // inside the run's deadline less its margin, so the partial answer and its next step still reach the caller.
    // Real time: `now` may be fixed.
    const settleFrom = Date.now()
    const settleUntil = Math.min(
      settleFrom + SETTLE_MS,
      options.deadline ? options.deadline.endsAt - deadlineMargin(options.deadline) : Number.POSITIVE_INFINITY,
    )
    if (!result.stopped && !options.budget?.stopped && settleUntil > settleFrom)
      await index
        .settle?.({ until: () => signal?.aborted === true || Date.now() >= settleUntil })
        .catch(() => undefined)
    return result
  } finally {
    flush?.()
    await writer?.close()
  }
}
