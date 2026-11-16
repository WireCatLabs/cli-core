import { createHash } from "node:crypto"
import {
  chmodSync,
  constants,
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
} from "node:fs"
import { open } from "node:fs/promises"
import { join, resolve, sep } from "node:path"
import { CliError, isCliError, resolvePaths } from "@wirecat/cli-base"
import { annotate } from "@wirecat/cli-base/commands"
import type { NextStep } from "@wirecat/cli-base/standards"
import type { Command } from "commander"
import * as v from "valibot"
import { extractText, importEngine, MAX_TEXT_CHARS } from "../../attachments/extract.js"
import { attachmentMaxBytes } from "../../attachments/limits.js"
import { answerEntity } from "../../cli/answer-entity.js"
import { environmentOf, outputFor, runBudgetOf } from "../../cli/context.js"
import { FETCH, REMOTE_READ } from "../../cli/effects.js"
import { itemOf, listOf } from "../../cli/envelope.js"
import { commandLevel } from "../../cli/search-left-out.js"
import { lineOf } from "../../cli/steps.js"
import { normalCrmUserId } from "../../domain/crm.js"
import { safeName } from "../../files/safe-name.js"
import type { AppIdentity } from "../../ports/app.js"
import { crmIdentityId } from "../../store/sqlite/crm-rows.js"
import type { CrmFileLimits, CrmFileRow } from "../../store/store.js"
import { parseCrmFileId } from "../files.js"
import { foreignContacts, foreignContactsPathFor } from "../foreign-contacts.js"
import type { CrmCallContext, CrmFileOwner, CrmFiles, CrmGap, CrmOpenableFile, CrmSource } from "../source.js"
import type { CrmRun, CrmWithin } from "./index.js"
import { integer } from "./records.js"

const MB = 1024 * 1024
const PAGE = 500
const DAY = 24 * 60 * 60 * 1000
/** `files download`'s own cap, and the most `--max-size` takes: Bitrix24's own largest file. */
export const DOWNLOAD_MB = 100
export const MOST_DOWNLOAD_MB = 2048
/** The text `files download` answers; the store keeps it all. */
const SHOWN_TEXT = 4000
/** Where `files sync` is in its round, a sync state `config` never sets. */
export const FILES_ROUND = "crm:files-round"
export const FILES_DOWNLOAD_KEY = "files.download"

const SKIP_REASONS = ["too-large", "run-files", "run-mb", "deadline", "disk-full", "unavailable"] as const
type SkipReason = (typeof SKIP_REASONS)[number]

const crmFile = v.strictObject({
  id: v.string(),
  name: v.string(),
  size: v.nullable(v.number()),
  mime: v.nullable(v.string()),
  created_at: v.nullable(v.string()),
  owner: v.strictObject({ kind: v.string(), id: v.string() }),
  source: v.string(),
  downloaded: v.boolean(),
  path: v.nullable(v.string()),
  untrusted: v.array(v.string()),
})
const crmFileDownload = v.strictObject({
  ...crmFile.entries,
  text_status: v.string(),
  text: v.nullable(v.string()),
  text_truncated: v.boolean(),
})
const crmFilesSync = v.strictObject({
  owners: v.number(),
  downloaded: v.array(
    v.strictObject({ id: v.string(), name: v.string(), size: v.number(), path: v.string(), text_status: v.string() }),
  ),
  skipped: v.array(
    v.strictObject({
      id: v.string(),
      name: v.string(),
      size: v.nullable(v.number()),
      reason: v.picklist(SKIP_REASONS),
      step: v.string(),
    }),
  ),
  complete: v.boolean(),
  stopped: v.optional(v.picklist(SKIP_REASONS)),
  untrusted: v.array(v.string()),
})

const OWNER_FLAGS = [
  ["deal", "--deal <id>"],
  ["lead", "--lead <id>"],
  ["person", "--person <id>"],
  ["organization", "--organization <id>"],
] as const

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString())
const segment = (text: string) => text.replace(/[^\w.-]+/gu, "_")

/** The account's own folder of downloads: what the disk cap counts and drops. */
const accountFolder = (app: AppIdentity, run: CrmRun) =>
  join(
    resolvePaths({ appName: app.appName, prefix: app.envPrefix, env: run.env ?? process.env }).state,
    "crm",
    "files",
    segment(`${run.account.provider}-${run.account.account}`),
  )

/** Each folder from `top` down to `folder` is the OS user's alone, whatever the umask or an earlier run left. */
const ownFolder = (top: string, folder: string) => {
  mkdirSync(folder, { recursive: true, mode: 0o700 })
  for (let at = resolve(folder); at.startsWith(resolve(top)); at = resolve(at, "..")) {
    chmodSync(at, 0o700)
    if (at === resolve(top)) break
  }
}

class TooLarge extends Error {}
class Taken extends Error {}

const errnoOf = (error: unknown) => (error as NodeJS.ErrnoException | undefined)?.code

/** The whole part file becomes `target` only if no file is there: a hard link, or a copy where links are refused. */
const placeNew = (part: string, target: string) => {
  try {
    linkSync(part, target)
  } catch (error) {
    if (errnoOf(error) === "EEXIST") throw new Taken()
    try {
      copyFileSync(part, target, constants.COPYFILE_EXCL)
    } catch (copying) {
      if (errnoOf(copying) === "EEXIST") throw new Taken()
      throw copying
    }
  }
  rmSync(part, { force: true })
}

/**
 * Streams into a part file beside the target and moves it there once whole; any stop leaves no part behind. With
 * `exclusive`, a file that appeared at the target meanwhile is never replaced.
 */
const saveStream = async (
  stream: ReadableStream<Uint8Array>,
  target: string,
  { cap, signal, exclusive }: { cap: number; signal?: AbortSignal; exclusive: boolean },
) => {
  const part = `${target}.part-${process.pid}`
  const handle = await open(part, "wx", 0o600)
  const hash = createHash("sha256")
  const reader = stream.getReader()
  let bytes = 0
  try {
    for (;;) {
      if (signal?.aborted) throw signal.reason ?? new Error("aborted")
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > cap) throw new TooLarge()
      hash.update(value)
      await handle.write(value)
    }
    await handle.close()
    if (exclusive) placeNew(part, target)
    else renameSync(part, target)
    chmodSync(target, 0o600)
    return { bytes, sha256: hash.digest("hex") }
  } catch (error) {
    await reader.cancel().catch(() => {})
    await handle.close().catch(() => {})
    rmSync(part, { force: true })
    throw error
  }
}

const tooLarge = (id: string, size: number | null, capMb: number, flag: boolean) =>
  new CliError(
    "validation_error",
    `${id} is ${size === null ? "larger than" : `${Math.ceil(size / MB)} MB, over`} the ${capMb} MB a download takes` +
      (flag ? `: --max-size raises it up to ${MOST_DOWNLOAD_MB}` : ""),
    { reason: "crm.file-too-large", limit: capMb, ...(size === null ? {} : { total: size }) },
  )

export interface CrmFileContext {
  app: AppIdentity
  run: CrmRun
  now: () => number
  signal?: AbortSignal
}

/** The CRM's answer for one record; `null` from the source is `not_found`. */
const listed = async (
  { run }: CrmFileContext,
  owner: CrmFileOwner,
  gaps: Pick<CrmGap, "kind" | "message" | "scope">[] = [],
): Promise<CrmFiles> => {
  const source = run.source()
  if (!source.files) throw new CliError("configuration_error", "this CRM does not list its records' files")
  const context: CrmCallContext = { spend: () => {}, gap: (gap) => gaps.push(gap) }
  const found = await source.files(owner, context)
  if (!found) throw new CliError("not_found", `the CRM has no ${owner.kind} ${owner.id}, or this sign-in cannot see it`)
  return found
}

const quotaOf = (context: CrmFileContext) => {
  const { run, app, now } = context
  return foreignContacts(
    run.source(),
    async () => {
      const self = run.source().self
      return foreignContactsPathFor(app, run.account, run.env, self ? String(await self()) : undefined)
    },
    { now },
  )
}

/**
 * Whether `need` more bytes of the file `own` fit under the cap, its own earlier copy not counted, once the oldest
 * other saved files whose text is stored are dropped; a scan is never dropped. Only with `drop` are they dropped:
 * before a download it only asks, so a download that fails costs no file.
 */
const roomFor = async (
  { run }: CrmFileContext,
  folder: string,
  {
    need,
    capBytes,
    own,
    target,
    drop,
  }: { need: number; capBytes: number; own: string; target: string | null; drop: boolean },
) => {
  const files = run.store.crmFiles
  const prefix = `${folder}${sep}`
  const earlier = await files.get(run.account, own)
  let total =
    (await files.storedBytes(run.account, prefix)) - (earlier?.localPath?.startsWith(prefix) ? (earlier.size ?? 0) : 0)
  if (total + need <= capBytes) return true
  // Never the file itself, by its id or its path: a stale row may name the path this download just wrote.
  const droppable = (await files.droppable(run.account, prefix)).filter(
    (one) => one.externalId !== own && one.localPath !== target,
  )
  // Nothing is dropped for a file that would not fit even then.
  if (total - droppable.reduce((sum, one) => sum + (one.size ?? 0), 0) + need > capBytes) return false
  if (!drop) return true
  for (const one of droppable) {
    if (one.localPath) rmSync(one.localPath, { force: true })
    await files.forgetFile(run.account, one.externalId)
    total -= one.size ?? 0
    if (total + need <= capBytes) return true
  }
  return false
}

const diskFull = (limits: CrmFileLimits, folder: string, setting: string) =>
  new CliError(
    "validation_error",
    `the CRM files folder ${folder} is at its ${limits.max_total_mb} MB even after dropping every file whose text is ` +
      `kept; raise ${setting} or free files there`,
    { reason: "crm.files-disk-full", limit: limits.max_total_mb, path: folder },
  )

/**
 * Where a file goes: its own name, or with the provider's id in front when another file holds that name, as an
 * activity's and a field's contract.pdf of one record do. Under `--dir` the folder is the owner's: a file there that
 * is not this one's earlier copy is never overwritten.
 */
const targetOf = (
  folder: string,
  file: CrmOpenableFile,
  earlier: string | null,
  held: ReadonlySet<string>,
  capped: boolean,
) => {
  const providerId = segment(parseCrmFileId(file.id).providerId)
  const name = safeName(file.name) ?? `file-${providerId}`
  // A path another row names is taken even when its file is gone: that row would drop or report this file.
  const free = (path: string) => path === earlier || (!held.has(path) && !existsSync(path))
  for (const candidate of [join(folder, name), join(folder, `${providerId}-${name}`)])
    if (free(candidate)) return candidate
  if (capped)
    for (let at = 2; ; at += 1) {
      const candidate = join(folder, `${providerId}-${at}-${name}`)
      if (free(candidate)) return candidate
    }
  throw new CliError("conflict", `${folder} already holds ${name} and ${providerId}-${name}: choose another --dir`, {
    reason: "crm.file-exists",
    path: folder,
  })
}

export interface Downloaded {
  row: CrmFileRow
  textStatus: string
}

/**
 * One file saved and read: under the account's folder (folders 700, file 600) or `dir`, its text through
 * `extractText`, its row stored. A cut-off or refused download keeps no part, and no error names the link.
 */
export const downloadCrmFile = async (
  context: CrmFileContext,
  file: CrmOpenableFile,
  assignee: string | null,
  {
    capBytes,
    capMb,
    flag,
    dir,
    limits,
  }: { capBytes: number; capMb: number; flag: boolean; dir?: string; limits: CrmFileLimits },
): Promise<Downloaded> => {
  const { run, app, now, signal } = context
  if (file.size !== null && file.size > capBytes) throw tooLarge(file.id, file.size, capMb, flag)
  const top = accountFolder(app, run)
  const folder = dir ? resolve(dir) : join(top, segment(`${file.owner.kind}-${file.owner.id}`))
  const setting = `crm.${run.account.provider}:${run.account.account}.files.max_total_mb`
  const capped = dir === undefined
  const room = (need: number, target: string | null, drop: boolean) =>
    roomFor(context, top, { need, capBytes: limits.max_total_mb * MB, own: file.id, target, drop })
  if (capped && !(await room(file.size ?? 0, null, false))) throw diskFull(limits, top, setting)
  if (capped) ownFolder(join(top, ".."), folder)
  else mkdirSync(folder, { recursive: true, mode: 0o700 })
  const earlier = await run.store.crmFiles.get(run.account, file.id)
  const held = new Set(await run.store.crmFiles.savedPaths(run.account))
  if (earlier?.localPath) held.delete(earlier.localPath)
  const target = targetOf(folder, file, earlier?.localPath ?? null, held, capped)
  // Cut off before the row is saved: nothing of this download stays, and an earlier row naming the path forgets it.
  const discard = async () => {
    rmSync(target, { force: true })
    if (earlier?.localPath === target) await run.store.crmFiles.forgetFile(run.account, file.id)
  }
  let saved: { bytes: number; sha256: string }
  try {
    saved = await saveStream(await file.open(signal), target, {
      cap: capBytes,
      ...(signal ? { signal } : {}),
      exclusive: !capped && target !== earlier?.localPath,
    })
  } catch (error) {
    if (error instanceof TooLarge) throw tooLarge(file.id, file.size, capMb, flag)
    if (error instanceof Taken)
      throw new CliError("conflict", `a file appeared at the name ${file.id} was to take in ${folder}; run it again`, {
        reason: "crm.file-exists",
        path: folder,
      })
    if (signal?.aborted)
      throw new CliError(
        "timeout",
        `the download of ${file.id} was cut off at the time limit and nothing was kept: run it again with a longer ` +
          "--timeout, such as --timeout 10m",
        { reason: "crm.file-unavailable" },
      )
    // The adapter's error may carry the tokened link: only its code passes on.
    throw new CliError(
      isCliError(error) ? error.code : "provider_error",
      `the CRM did not give the file ${file.id}, and nothing was kept`,
      { reason: "crm.file-unavailable" },
    )
  }
  if (capped && !(await room(saved.bytes, target, true))) {
    await discard()
    throw diskFull(limits, top, setting)
  }
  let bytes: Buffer
  try {
    bytes = readFileSync(target)
  } catch {
    await discard()
    // The error would name the local path; the file was removed under the download.
    throw new CliError("not_found", `the saved copy of ${file.id} was removed before its text was read; run it again`, {
      reason: "crm.file-unavailable",
    })
  }
  const cutOff = async () => {
    await discard()
    return new CliError(
      "cancelled",
      `the time limit stopped reading the text of ${file.id}, and nothing was kept: run it again with a longer ` +
        "--timeout, such as --timeout 10m",
      { reason: "crm.file-unavailable" },
    )
  }
  let extraction: Awaited<ReturnType<typeof extractText>> | { status: "too-large" }
  try {
    extraction =
      saved.bytes > attachmentMaxBytes(run.env ?? process.env)
        ? { status: "too-large" }
        : await extractText(
            bytes,
            { kind: "file", name: file.name, mime: file.mime, path: target },
            importEngine,
            signal,
            run.env ?? process.env,
          )
  } catch (error) {
    if (signal?.aborted) throw await cutOff()
    await discard()
    throw error
  }
  // A reading stopped by the time limit says nothing of the file: it is not kept as unreadable.
  if (signal?.aborted) throw await cutOff()
  const self = run.source().self ? String(await run.source().self?.()) : null
  const row: CrmFileRow = {
    externalId: file.id,
    ownerKind: file.owner.kind,
    ownerId: file.owner.id,
    ownerAssignee: assignee === null ? null : crmIdentityId(run.account, normalCrmUserId(assignee), "user"),
    source: file.source,
    name: file.name,
    mime: file.mime,
    size: saved.bytes,
    externalCreatedAt: file.created,
    localPath: target,
    contentSha256: saved.sha256,
    text: extraction.status === "extracted" ? extraction.text.slice(0, MAX_TEXT_CHARS) : null,
    extraction: extraction.status,
    extractionError: extraction.status === "unreadable" ? extraction.error : null,
    downloadedBy: self,
    downloadedAt: now(),
  }
  await run.store.crmFiles.save(run.account, row)
  // The copy an earlier download left in the account's folder is the CLI's own; this one replaces it.
  if (earlier?.localPath && earlier.localPath !== target && earlier.localPath.startsWith(`${top}${sep}`))
    rmSync(earlier.localPath, { force: true })
  return { row, textStatus: extraction.status }
}

const itemOfFile = (file: CrmOpenableFile | CrmFileRow, saved: Omit<CrmFileRow, "text"> | undefined) => {
  const listed = "owner" in file
  return {
    id: listed ? file.id : file.externalId,
    name: file.name,
    size: file.size,
    mime: file.mime,
    created_at: iso(listed ? file.created : file.externalCreatedAt),
    owner: listed ? { kind: file.owner.kind, id: file.owner.id } : { kind: file.ownerKind, id: file.ownerId },
    source: file.source,
    downloaded: saved !== undefined && saved.localPath !== null,
    path: saved?.localPath ?? null,
    untrusted: ["name", "mime", "path"],
  }
}

export interface CrmFileCommandOptions {
  within: CrmWithin
  example: (command: Command, ...lines: string[]) => Command
  app: AppIdentity
  /** The CRM has leads: `--lead` is offered. True when absent. */
  leads?: boolean
  now: () => number
}

/** `files list`, `files download` and `files sync` (NEED-2701 C, NEED-2708 B). */
export const addCrmFileCommands = (program: Command, options: CrmFileCommandOptions): void => {
  const { within, example, app, now } = options
  const kinds = OWNER_FLAGS.filter(([kind]) => kind !== "lead" || options.leads !== false)
  const contextOf = (run: CrmRun, command: Command): CrmFileContext => {
    const { signal } = environmentOf(command)
    return { app, run, now, ...(signal ? { signal } : {}) }
  }
  const group = annotate(program.command("files"), { effects: REMOTE_READ }).description(
    "the files of the CRM's deals, leads, contacts and companies: listed live, downloaded on demand, their text " +
      "found by search all",
  )

  const list = example(
    answerEntity(
      annotate(group.command("list"), { effects: REMOTE_READ, offline: false }),
      "crm_file",
      crmFile,
    ).description(
      "one record's files, read live from the CRM, with the path of each already downloaded; another user's " +
        "record counts toward the day's limit when the CRM sets one",
    ),
    "files list --deal 12",
    "files list --person 42 --json",
  )
  for (const [, flag] of kinds) list.option(flag, `the ${flag.slice(2, flag.indexOf(" "))} whose files to list`)
  list.action(async (opts: Partial<Record<(typeof kinds)[number][0], string>>, command: Command) => {
    const given = kinds.filter(([kind]) => opts[kind] !== undefined)
    const [chosen] = given
    if (given.length !== 1 || !chosen)
      throw new CliError("validation_error", `name one record: ${kinds.map(([, flag]) => flag).join(", ")}`, {
        reason: "ref.malformed",
      })
    const owner: CrmFileOwner = { kind: chosen[0], id: String(opts[chosen[0]]).trim() }
    await within(command, async (run) => {
      const context = contextOf(run, command)
      const gaps: Pick<CrmGap, "kind" | "message" | "scope">[] = []
      const found = await listed(context, owner, gaps)
      await quotaOf(context).spend(owner.kind, { externalId: owner.id, assignee: found.assignee })
      const saved = new Map(
        (await run.store.crmFiles.ofOwner(run.account, owner.kind, owner.id)).map((one) => [one.externalId, one]),
      )
      for (const gap of gaps) outputFor(command).renderer.note(gap.message)
      const items = found.files.map((file) => itemOfFile(file, saved.get(file.id)))
      return listOf("files list", {
        items,
        limit: Math.max(1, items.length),
        page: 1,
        has_more: false,
        ...(gaps.length
          ? {
              meta: {
                complete: false,
                issues: gaps.map((gap) => ({
                  code: "permission_error" as const,
                  reason: "crm.scope-missing",
                  source: `crm:files${gap.scope ? `/${gap.scope}` : ""}`,
                })),
              },
            }
          : {}),
      })
    })
  })

  example(
    answerEntity(
      annotate(group.command("download"), { effects: FETCH, offline: false }),
      "crm_file_download",
      crmFileDownload,
    )
      .description(
        `save one file under the state folder (or --dir) and read its text, which search all then finds; ` +
          `${DOWNLOAD_MB} MB at most unless --max-size; another user's record counts toward the day's limit`,
      )
      .argument("<file>", "the file's id, as files list prints it")
      .option("--max-size <MB>", `the largest file to take, up to ${MOST_DOWNLOAD_MB}`, integer(MOST_DOWNLOAD_MB))
      .option("--dir <folder>", "save it here instead, as the owner's own copy: not counted, never dropped"),
    "files download deal:12:record:345",
    "files download deal:12:document:7 --max-size 500 --dir ~/Contracts",
  ).action(async (given: string, opts: { maxSize?: number; dir?: string }, command: Command) => {
    const id = given.trim().replace(/^crmfile:/u, "")
    const { owner } = parseCrmFileId(id)
    const capMb = opts.maxSize ?? DOWNLOAD_MB
    await within(command, async (run) => {
      const context = contextOf(run, command)
      const found = await listed(context, owner)
      // Spent before the id is looked up: a made-up id on a colleague's record still costs its slot.
      await quotaOf(context).spend(owner.kind, { externalId: owner.id, assignee: found.assignee })
      const file = found.files.find((one) => one.id === id)
      if (!file) throw new CliError("not_found", `${owner.kind} ${owner.id} has no file ${id}; files list names them`)
      const done = await downloadCrmFile(context, file, found.assignee, {
        capBytes: capMb * MB,
        capMb,
        flag: capMb < MOST_DOWNLOAD_MB,
        limits: await run.store.crmFiles.limits(run.account),
        ...(opts.dir === undefined ? {} : { dir: opts.dir }),
      })
      const text = done.row.text
      return itemOf({
        ...itemOfFile(file, done.row),
        size: done.row.size,
        text_status: done.textStatus,
        text: text === null ? null : text.slice(0, SHOWN_TEXT),
        text_truncated: text !== null && text.length > SHOWN_TEXT,
        untrusted: ["name", "mime", "path", "text"],
      })
    })
  })

  example(
    answerEntity(
      annotate(group.command("sync"), { effects: FETCH, offline: false, cooperative: true, partial: true }),
      "crm_files_sync",
      crmFilesSync,
    ).description(
      "download the files of your own deals and leads that changed lately, newest first, within the account's " +
        "files.* limits; stops at its deadline and the next run goes on. Never another user's files. Run it on a " +
        `schedule: ${app.command} schedule command crm-files --every 1h -- files sync`,
    ),
    "files sync",
  ).action(async (_opts: unknown, command: Command) => {
    const level = commandLevel(command, app, FILES_DOWNLOAD_KEY)
    if (level === "deny" || level === "readonly")
      throw new CliError("permission_error", `files sync downloads files, which ${FILES_DOWNLOAD_KEY} ${level}s`, {
        reason: "crm.files-denied",
        permission: FILES_DOWNLOAD_KEY,
      })
    const budget = runBudgetOf(command)
    await within(command, async (run) => {
      const report = await syncFiles(contextOf(run, command), () => budget.take() !== null)
      const next: NextStep[] | undefined = report.complete
        ? undefined
        : [
            {
              kind: "command",
              step: "crm.files-sync",
              command: "files sync",
              args: {},
              why: "the run stopped at a limit; the next run goes on from there",
              safe_to_auto_execute: true,
            },
          ]
      return itemOf(
        {
          ...report,
          skipped: report.skipped.map((one) => ({ ...one, step: lineOf(command, `files download ${one.id}`) })),
          untrusted: ["downloaded.name", "downloaded.path", "skipped.name"],
        },
        { ...(report.complete ? {} : { meta: { complete: false } }), ...(next ? { next } : {}) },
      )
    })
  })
}

interface Round {
  /** Deals and leads changed after this were not fetched by a complete round yet. */
  after: number | null
  /** The round in progress: when it started, and the records it finished. */
  started: number | null
  done: string[]
  /** Runs each file was unavailable in, until it is given up. */
  tries?: Record<string, number>
}

/** Runs a file may be unavailable in before the round closes without it. */
const MOST_TRIES = 3

const roundOf = async (run: CrmRun): Promise<Round> => {
  try {
    const found = JSON.parse(
      (await run.store.sync.syncState(run.account, FILES_ROUND))?.value ?? "null",
    ) as Round | null
    if (found && Array.isArray(found.done)) return found
  } catch {}
  return { after: null, started: null, done: [] }
}

export interface FilesSyncReport {
  owners: number
  downloaded: { id: string; name: string; size: number; path: string; text_status: string }[]
  skipped: { id: string; name: string; size: number | null; reason: SkipReason }[]
  complete: boolean
  stopped?: SkipReason
}

/**
 * One `files sync` run: the files of the sign-in's own deals and leads changed since the last complete round, and at
 * most `files.days` back, newest first, under the run's limits. It stops at the first run limit and saves its place.
 */
export const syncFiles = async (
  context: CrmFileContext,
  outOfTime: () => boolean,
  deadline: (ms: number) => AbortSignal = (ms) => AbortSignal.timeout(ms),
): Promise<FilesSyncReport> => {
  const { run, now } = context
  const source: CrmSource = run.source()
  if (!source.self)
    throw new CliError("configuration_error", "this CRM names no user for the sign-in, so no deal is yours")
  const self = normalCrmUserId(String(await source.self()))
  const limits = await run.store.crmFiles.limits(run.account)
  const started = now()
  const ends = started + limits.run_minutes * 60_000
  const round = await roundOf(run)
  const roundStart = round.started ?? started
  const since = Math.max(round.after ?? 0, roundStart - limits.days * DAY)
  const assignee = crmIdentityId(run.account, self, "user")
  const candidates: { kind: "deal" | "lead"; id: string; updated: number }[] = []
  for (const kind of ["deal", "lead"] as const)
    for (let offset = 0; ; offset += PAGE) {
      const found = await run.store.deals.list({
        kind,
        account: run.account,
        owner: assignee,
        updated: { since },
        limit: PAGE,
        offset,
      })
      for (const one of found.items)
        candidates.push({ kind, id: one.externalId ?? "", updated: Date.parse(one.updatedAt) })
      if (!found.hasMore) break
    }
  const owners = candidates
    .filter((one) => one.id && !round.done.includes(`${one.kind}:${one.id}`))
    .sort((a, b) => b.updated - a.updated)
  const report: FilesSyncReport = { owners: owners.length, downloaded: [], skipped: [], complete: true }
  const done = [...round.done]
  // A record whose file could not be had is not done: the next run asks again, so the round stays open.
  let retry = false
  const tries: Record<string, number> = { ...(round.tries ?? {}) }
  let runBytes = 0
  const stop = (reason: SkipReason, file: CrmOpenableFile) => {
    report.skipped.push({ id: file.id, name: file.name, size: file.size, reason })
    report.stopped = reason
    report.complete = false
  }
  outer: for (const owner of owners) {
    if (now() >= ends || outOfTime()) {
      report.stopped = "deadline"
      report.complete = false
      break
    }
    const found = await source.files?.({ kind: owner.kind, id: owner.id }, { spend: () => {}, gap: () => {} })
    // The copy may be behind the CRM: a deal given to a colleague since the last sync is theirs, and so are its files.
    if (!found || found.assignee === null || normalCrmUserId(found.assignee) !== self) {
      done.push(`${owner.kind}:${owner.id}`)
      continue
    }
    const files = [...found.files].sort((a, b) => (b.created ?? 0) - (a.created ?? 0))
    let available = true
    for (const file of files) {
      if (await run.store.crmFiles.get(run.account, file.id)) continue
      const fileCap = limits.max_file_mb * MB
      if (file.size !== null && file.size > fileCap) {
        report.skipped.push({ id: file.id, name: file.name, size: file.size, reason: "too-large" })
        continue
      }
      if (report.downloaded.length >= limits.max_files) {
        stop("run-files", file)
        break outer
      }
      const left = limits.max_run_mb * MB - runBytes
      if (file.size !== null && file.size > left) {
        stop("run-mb", file)
        break outer
      }
      if (now() >= ends || outOfTime()) {
        stop("deadline", file)
        break outer
      }
      const remaining = deadline(Math.max(1, ends - now()))
      const signal = context.signal ? AbortSignal.any([context.signal, remaining]) : remaining
      try {
        const saved = await downloadCrmFile({ ...context, signal }, file, found.assignee, {
          capBytes: Math.min(fileCap, left),
          capMb: limits.max_file_mb,
          flag: false,
          limits,
        })
        delete tries[file.id]
        runBytes += saved.row.size ?? 0
        report.downloaded.push({
          id: file.id,
          name: file.name,
          size: saved.row.size ?? 0,
          path: saved.row.localPath ?? "",
          text_status: saved.textStatus,
        })
      } catch (error) {
        const reason = isCliError(error) ? error.details.reason : undefined
        if (reason === "crm.files-disk-full") {
          stop("disk-full", file)
          break outer
        }
        if (reason === "crm.file-too-large") {
          // An unknown size stopped at the cap: the file or what is left of the run.
          if (left < fileCap) {
            stop("run-mb", file)
            break outer
          }
          report.skipped.push({ id: file.id, name: file.name, size: file.size, reason: "too-large" })
          continue
        }
        if (signal.aborted || (isCliError(error) && error.code === "timeout")) {
          stop("deadline", file)
          break outer
        }
        report.skipped.push({ id: file.id, name: file.name, size: file.size, reason: "unavailable" })
        tries[file.id] = (tries[file.id] ?? 0) + 1
        // A file the CRM keeps refusing is given up, so the round can close.
        if ((tries[file.id] ?? 0) < MOST_TRIES) available = false
      }
    }
    if (available) done.push(`${owner.kind}:${owner.id}`)
    else retry = true
  }
  const next: Round =
    report.complete && !retry
      ? { after: roundStart, started: null, done: [] }
      : { after: round.after, started: roundStart, done, tries }
  await run.store.sync.setSyncState(run.account, FILES_ROUND, JSON.stringify(next))
  return report
}
