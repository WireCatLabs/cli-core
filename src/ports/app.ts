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

/** The variable that locks this process read-only, when it is set to anything but "0". */
export const readOnlyLockOf = (app: AppIdentity, env: NodeJS.ProcessEnv): string | undefined => {
  const name = envName(app, "READ_ONLY")
  const value = env[name]
  return value === undefined || value.trim() === "" || value === "0" ? undefined : name
}

export const MESSENGER_CHANGE_REFUSAL = "send, react, change chats or change the account"

/** The one wording for a write `<PREFIX>_READ_ONLY` stops: `what` finishes "it cannot …". */
export const readOnlyRefusal = (lock: string, what: string): CliError =>
  new CliError("permission_error", `this process is read-only (${lock}) — it cannot ${what}`)
