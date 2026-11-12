import { readFileSync } from "node:fs"
import { CliError } from "@wirecat/cli-base"
import type { AppErrors } from "../errors/reasons.js"

/** Who a messenger CLI is: the word people type, where its files live, what its variables start with. */
export interface AppIdentity {
  /** `tg`, `max` — in usage lines and in every message that tells somebody what to type. */
  command: string
  /** `tg-cli` — the directory name under the OS conventions, and the keyring service. */
  appName: string
  /** `TG` gives `TG_PROFILE`, `TG_TIMEOUT`, `TG_CONFIG_DIR`… */
  envPrefix: string
  description: string
  version: string
  /** Where a problem report goes — a new-issue page. `doctor reports create` names it. */
  issues?: string
  /** The language of the transcript a person reads: its day headings and the word for "you". `ru-RU` when unset. */
  locale?: string
  /**
   * ISO 639-1 codes of the languages its content is mostly in (`["ru"]`). The first run pre-ticks the ones search
   * can stem in place of English and the system's language; the person still confirms, since the choice is shared.
   */
  contentLanguages?: readonly string[]
  /**
   * `false` for a CLI that is not a messenger — notes, files, a calendar. The shared help, `config`, `commands info`
   * and MCP text then name its own commands and leave out chats, messages and senders. Unset means a messenger, so
   * tg, max and wa print what they always did.
   */
  messenger?: boolean
  /** A CLI that is not a messenger yet sends to people, as mail does: it keeps the hourly limit, `sends_per_hour`. */
  sends?: true
  /**
   * How long one request to the provider usually takes, in ms: a sync's budget is the deadline, less its margin,
   * divided by it (`requestsFor`). 2 s when unset.
   */
  requestMs?: number
  /** Error reasons and detail keys of its own — max's `max_code`, tg's `migrated_chat_id` — kept in every error it prints. */
  errors?: AppErrors
}

export const envName = (app: AppIdentity, name: string): string => `${app.envPrefix}_${name}`

const locking = (value: string | undefined) => value !== undefined && value.trim() !== "" && value !== "0"

/** Where a process's ancestry is read from: injectable, so a test can give its own process tree. */
interface Ancestry {
  read?: (path: string) => string
  from?: number
  uid?: number
  cache?: Map<string, string[][] | null>
}

const ancestries = new Map<string, string[][] | null>()

/** A file's text, or undefined when reading it is denied; any other failure throws. */
const readable = (read: (path: string) => string, path: string): string | undefined => {
  try {
    return read(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EACCES") return undefined
    throw error
  }
}

/**
 * The starting environments of the processes this one descends from, nearest first, up to the first one another user
 * owns or one whose environment is hidden. A process's starting environment (`/proc/<pid>/environ`) is fixed, so an agent that runs `MEMO_READ_ONLY=0
 * memo …` or `env -u` under a locked run cannot change what is read here. Null when /proc cannot be read, or an
 * ancestor ended mid-walk: the caller fails closed. Linux only; elsewhere an empty list, and the variables alone decide.
 */
const ancestorEnvironments = ({
  read = (path: string) => readFileSync(path, "utf8"),
  from = process.ppid,
  uid = process.getuid?.() ?? -1,
  cache = ancestries,
}: Ancestry = {}): string[][] | null => {
  if (process.platform !== "linux") return []
  const key = `${from}:${uid}`
  const known = cache.get(key)
  if (known !== undefined) return known
  let found: string[][] | null = []
  try {
    // A sandbox's own process list (codex's) starts at pid 1, which is then the agent's own helper.
    for (let pid = from, depth = 0; pid >= 1 && depth < 64; depth++) {
      const status = read(`/proc/${pid}/status`)
      const field = (name: string) => new RegExp(`^${name}:\\s*(\\d+)`, "m").exec(status)?.[1]
      if (Number(field("Uid")) !== uid) break
      const environ = readable(read, `/proc/${pid}/environ`)
      // The user's own service manager (systemd --user) hides its environment; nothing an agent starts is above it.
      if (environ === undefined) break
      found.push(environ.split("\0"))
      pid = Number(field("PPid"))
    }
  } catch {
    found = null
  }
  cache.set(key, found)
  return found
}

const valuesOf = (environments: string[][], name: string) =>
  environments.flatMap((environ) =>
    environ.filter((entry) => entry.startsWith(`${name}=`)).map((entry) => entry.slice(name.length + 1)),
  )

/** Whether a process this one descends from was started with the lock, or its ancestry cannot be read. */
export const lockedByAncestor = (name: string, ancestry: Ancestry = {}): boolean => {
  const environments = ancestorEnvironments(ancestry)
  return environments === null || valuesOf(environments, name).some(locking)
}

/**
 * The value the farthest ancestor that sets `name` was started with: the scheduled run sets it on the agent it starts,
 * and nothing the agent runs can change an ancestor above itself. The variable itself where no ancestor sets it, as
 * off Linux.
 */
export const ancestorValue = (name: string, env: NodeJS.ProcessEnv, ancestry: Ancestry = {}): string | undefined =>
  valuesOf(ancestorEnvironments(ancestry) ?? [], name).at(-1) ?? env[name]

/** The variable that locks this process read-only: set to anything but "0" here or in any process it descends from. */
export const readOnlyLockOf = (app: AppIdentity, env: NodeJS.ProcessEnv): string | undefined => {
  const name = envName(app, "READ_ONLY")
  return locking(env[name]) || lockedByAncestor(name) ? name : undefined
}

/** The holder a scheduled run was started for (`schedule agent --on-new-mail`): the only mark that run may move. */
export const mailHolderVariable = (app: AppIdentity): string => envName(app, "MAIL_HOLDER")

export const MESSENGER_CHANGE_REFUSAL = "send, react, change chats or change the account"

/** The one wording for a write `<PREFIX>_READ_ONLY` stops: `what` finishes "it cannot …". */
export const readOnlyRefusal = (lock: string, what: string): CliError =>
  new CliError("permission_error", `this process is read-only (${lock}) — it cannot ${what}`)
