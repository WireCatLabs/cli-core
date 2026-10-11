import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Readable } from "node:stream"
import { CliError } from "@wirecat/cli-base"
import type { Id, Message } from "../../domain/models.js"
import { checkFor, type PasswordCheck, passes, seal } from "../../sealed.js"
import type { AccountKey } from "../../store/store.js"

const FORMAT = "cli-messaging-export"
const MANIFEST = "manifest.json"

export interface ExportedChat {
  title: string | null
  /** This machine's time the last run read up to; the next run takes what changed after it. */
  mark: string
  files: string[]
  messages: number
  deleted: number
}

export interface ExportManifest {
  format: typeof FORMAT
  version: 1
  provider: string
  account: Id
  /** Every run sealed with a password; the manifest then names no chat, so it reads without one. */
  encrypted?: true
  /** With `encrypted`: tells a later run whether its password is the one the folder was sealed with. */
  password?: PasswordCheck
  chats: Record<Id, ExportedChat>
}

/**
 * The folder's manifest, or a fresh one where the folder is new or empty. A folder holding anything
 * else is refused, and so is one exported from another account: adding to it would mix two.
 */
export const openFolder = (dir: string, key: AccountKey, encrypted: boolean): ExportManifest => {
  const fresh: ExportManifest = {
    format: FORMAT,
    version: 1,
    provider: key.provider,
    account: key.account,
    ...(encrypted ? { encrypted: true } : {}),
    chats: {},
  }
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    return fresh
  }
  const path = join(dir, MANIFEST)
  if (!existsSync(path)) {
    if (readdirSync(dir).length > 0) {
      throw new CliError("validation_error", `${dir} holds other files and no ${MANIFEST} — export into a new folder`)
    }
    return fresh
  }
  const found = JSON.parse(readFileSync(path, "utf8")) as Partial<ExportManifest>
  if (found.format !== FORMAT || found.version !== 1 || typeof found.chats !== "object" || found.chats === null) {
    throw new CliError("validation_error", `${path} is not an export manifest this version reads`)
  }
  if (found.provider !== key.provider || found.account !== key.account) {
    throw new CliError(
      "validation_error",
      `${dir} was exported from ${found.provider} account ${found.account}, not this one — export into a new folder`,
    )
  }
  if ((found.encrypted === true) !== encrypted) {
    throw new CliError(
      "validation_error",
      found.encrypted
        ? `${dir} is encrypted — add to it with --encrypt`
        : `${dir} is not encrypted — --encrypt needs a new folder`,
    )
  }
  return found as ExportManifest
}

/** Messages first, oldest first, then one `{ id, chatId, deleted: true }` per deletion — never the deleted text. */
export const linesOf = (chatId: Id, { messages, deleted }: { messages: Message[]; deleted: Id[] }): string[] => [
  ...messages.map((message) => JSON.stringify(message)),
  ...deleted.map((id) => JSON.stringify({ id, chatId, deleted: true })),
]

const stampOf = (mark: string) => mark.replace(/[^\dTZ]/g, "")

/** An encrypted run is one file for every chat: a key costs half a second to derive, per file. */
export const runFileFor = (mark: string): string => `run-${stampOf(mark)}.jsonl.sealed`

/**
 * The password for an encrypted folder: the one it was first sealed with, or refused. A folder whose
 * runs need different passwords would be found out only on the day it is opened.
 */
export const admitPassword = async (manifest: ExportManifest, password: string): Promise<void> => {
  if (manifest.password === undefined) {
    manifest.password = await checkFor(password)
    return
  }
  if (!(await passes(password, manifest.password))) {
    throw new CliError("validation_error", "not the password this folder was sealed with — nothing was written")
  }
}

/** Seals the run as its lines come, chat by chat, never all in memory; a run with no line leaves no file. */
export const sealRun = async (
  dir: string,
  name: string,
  lines: AsyncIterable<string>,
  password: string,
): Promise<number> => {
  let count = 0
  const counted = async function* () {
    for await (const line of lines) {
      count += 1
      yield `${line}\n`
    }
  }
  await seal(() => Readable.from(counted()), join(dir, name), password)
  if (count === 0) rmSync(join(dir, name))
  return count
}

const safe = (chatId: Id) => chatId.replace(/[^\w-]/g, "_")

/**
 * Messages first, oldest first, then one `{ id, deleted: true }` per deletion — never the deleted
 * text. Named by the run's mark: a file left by a run stopped before its manifest is not in the way.
 */
export const writeChanges = (
  dir: string,
  chatId: Id,
  mark: string,
  { messages, deleted }: { messages: Message[]; deleted: Id[] },
): string => {
  const name = `${safe(chatId)}-${stampOf(mark)}.jsonl`
  const lines = linesOf(chatId, { messages, deleted })
  try {
    writeFileSync(join(dir, name), `${lines.join("\n")}\n`, { flag: "wx", mode: 0o600 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new CliError("validation_error", `${join(dir, name)} exists — two exports into one folder at once`)
    }
    throw error
  }
  return name
}

/** Written last and replaced whole, so a run stopped halfway leaves the previous manifest, and repeats. */
export const saveManifest = (dir: string, manifest: ExportManifest): void => {
  const next = join(dir, `.${MANIFEST}.next`)
  writeFileSync(next, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 })
  renameSync(next, join(dir, MANIFEST))
}
