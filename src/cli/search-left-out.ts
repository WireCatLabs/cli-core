import type { Command } from "commander"
import type { AppIdentity } from "../ports/app.js"
import { type Level, levelFor, type PermissionKey } from "../sends/permissions.js"
import { environmentOf, withAgentLevels } from "./context.js"
import { settingsFor } from "./settings.js"

/** The list command whose level guards each kind a shared `search all` reads. */
const LIST_KEYS = {
  deal: "deals.list",
  lead: "leads.list",
  // No command lists business data across its types yet; the key is the lane's own, so a profile can turn it off.
  business: "business.list",
  messages: "messages.list",
  mail: "mail.list",
  notes: "notes.list",
  events: "events.list",
  meetings: "meetings.list",
} as const satisfies Record<string, PermissionKey>

export type SearchedKind = keyof typeof LIST_KEYS

export interface LeftOut<K extends SearchedKind> {
  kind: K
  key: PermissionKey
  /** `deal left out: profile work denies deals.list` */
  why: string
}

/**
 * The kinds whose list `permissions` deny, for a CLI with levels of its own, such as memo's: `by` names who denies in
 * `why` (`memo's permissions`).
 */
export const deniedKindsOf = <K extends SearchedKind>(
  permissions: Readonly<Record<PermissionKey, Level>>,
  kinds: readonly K[],
  by: string,
  defaults?: Readonly<Record<PermissionKey, Level>>,
): LeftOut<K>[] =>
  kinds
    .map((kind) => ({ kind, key: LIST_KEYS[kind] as PermissionKey }))
    .filter(({ key }) => levelFor(permissions, key, defaults).level === "deny")
    .map((one) => ({ ...one, why: `${one.kind} left out: ${by} denies ${one.key}` }))

/**
 * The kinds whose list the profile denies, so `search all` leaves them out rather than show their titles and excerpts
 * under another key (SEC-144). Levels as the run judged the command: the profile's, `--permission`, and an MCP
 * server's own stricter ones.
 */
export const deniedKinds = <K extends SearchedKind>(
  command: Command,
  app: AppIdentity,
  kinds: readonly K[],
): LeftOut<K>[] => {
  const environment = environmentOf(command)
  const resolve = environment.resolveSettings ?? settingsFor(app).resolveSettings
  const { permissions, profile } = resolve(withAgentLevels(command, command.optsWithGlobals()), {
    env: environment.env ?? process.env,
    needsProfile: false,
    readOnly: true,
  })
  return deniedKindsOf(permissions, kinds, `profile ${profile}`, environment.permissionDefaults)
}
