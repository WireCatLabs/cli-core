import { createHash } from "node:crypto"
import { CliError, isCliError } from "@wirecat/cli-base"
import { catalogFiles } from "../../documents/catalog.js"
import type { IndexedSource, PictureWriter, SourceContent, SourceFile, SourceSkip } from "../../documents/model.js"
import { within } from "../../documents/scope.js"
import { changedSince, planDocuments, scopeHash } from "./plan.js"
import type { SyncOptions } from "./ports.js"

const MAX_PICTURE_BYTES = 25 * 1024 * 1024
const SAVE_EVERY_MS = 2000
const SAVE_EVERY_ITEMS = 25
const isPicture = (file: SourceFile) => file.mime.startsWith("image/") && file.canDownload
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
    rescan = false,
    pictures = false,
    assertHeld,
    errorOf,
    skipReason,
    storeVersion: VERSION,
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
    coverage: "selected folders only; unsupported files are reported",
    ...(profile.picture_search ? { pictures: 0 } : {}),
  }
  let writer: PictureWriter | undefined
  let flush: (() => void) | undefined
  try {
    if (profile.roots.length && (!source || (await source.identity()) !== profile.principal))
      throw new CliError("authentication_error", "signed-in source account does not match this profile", {
        reason: "profile.wrong-account",
      })
    const state = statePort.read()
    if (state.principal !== principal)
      throw new CliError("configuration_error", "sync state belongs to another source account")
    const currentScope = scopeHash(profile.roots)
    const abandoned =
      state.pending && (state.pending.scope !== currentScope || rescan) ? state.pending.jobs.map((job) => job.id) : []
    if (state.pending?.scope !== currentScope || rescan) delete state.pending
    if (rescan) {
      delete state.cursor
      statePort.removeWalk()
    }
    if (!state.pending) {
      state.pending = await planDocuments(
        options,
        source,
        state,
        profile.roots,
        limit,
        profile.picture_search ?? false,
        abandoned,
        {
          read: (scope) => statePort.readWalk(scope),
          save: (walk) => statePort.saveWalk(walk),
        },
      )
      state.skipped = state.pending.skipped
      statePort.save(state)
      statePort.removeWalk()
    }
    const pending = state.pending
    if (!pending) throw new CliError("invalid_response", "could not prepare a sync batch")
    if (index.catalog) await index.catalog.import(profile.principal, catalogFiles(state, profile.roots))
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
    let modelMissing = false
    const savePictureOf = async (file: M) => {
      const entry = state.documents[file.id] as IndexedSource<M>
      if (!profile.picture_search || !isPicture(file) || modelMissing) return
      if ((file.size ?? 0) > MAX_PICTURE_BYTES) {
        entry.picture = "too-large"
        result.pictures_too_large = (result.pictures_too_large ?? 0) + 1
        return
      }
      if (!source) throw new CliError("configuration_error", "a pending picture requires source sign-in")
      if (!writer) {
        try {
          writer = await index.openPictures()
        } catch (error) {
          if (!isCliError(error) || error.code !== "not_found") throw error
          modelMissing = true
          result.pictures_skipped = error.message
          return
        }
      }
      const bytes = await source.bytes(file.id)
      if (bytes.length > MAX_PICTURE_BYTES) {
        entry.picture = "too-large"
        result.pictures_too_large = (result.pictures_too_large ?? 0) + 1
        return
      }
      if ((await writer.save(entry.reference, bytes)) === "saved") result.pictures = (result.pictures ?? 0) + 1
      entry.picture = "saved"
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
          await index.remove(profile.principal, job.id)
          statePort.removeSnapshot(job.id)
          delete state.documents[job.id]
          result.removed++
        } else if (job.file && skipReason(job.file)) {
          await saveNamesOnly(job.file, skipReason(job.file) as string)
          await savePictureOf(job.file)
        } else {
          if (!source) throw new CliError("configuration_error", "a pending save requires source sign-in")
          const content = await source.content(job.id, limit)
          if (!within(content.metadata, profile.roots, pending.folders)) {
            await index.remove(profile.principal, job.id)
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
            state.documents[job.id] = { metadata: content.metadata, hash, reference, tabs: content.tabs.length }
            if (previous?.hash === hash) result.unchanged++
            else result.saved++
          }
        }
        pending.jobs = pending.jobs.filter((item) => item !== job)
        progress()
      } catch (error) {
        const safe = errorOf(error)
        if (safe.code === "cancelled") throw safe
        if (job.kind === "save" && (safe.code === "not_found" || safe.code === "validation_error")) {
          const skipped: SourceSkip<M> = {
            id: job.id,
            reason: safe.message,
            ...(job.file ? { file: job.file } : {}),
            ...(safe.details.text_limit ? { textLimit: limit } : {}),
            ...(safe.details.store_refused_in ? { storeRefusedIn: VERSION } : {}),
          }
          if (job.file && safe.code === "validation_error") await saveNamesOnly(job.file, skipped.reason)
          else {
            await index.remove(profile.principal, job.id)
            statePort.removeSnapshot(job.id)
            delete state.documents[job.id]
          }
          state.skipped = state.skipped.filter((item) => item.id !== job.id)
          state.skipped.push(skipped)
          result.skipped.push({ id: skipped.id, reason: skipped.reason })
          pending.jobs = pending.jobs.filter((item) => item !== job)
          progress()
          continue
        }
        result.errors.push({ id: job.id, code: safe.code, message: safe.message })
      }
    }
    flush()
    result.pending = pending.jobs.length
    if (!pending.jobs.length) {
      state.cursor = pending.cursor
      state.scope = pending.scope
      state.folders = pending.folders
      delete state.pending
      state.lastSync = new Date(now()).toISOString()
      statePort.save(state)
    }
    return result
  } finally {
    flush?.()
    await writer?.close()
  }
}
