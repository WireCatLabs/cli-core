import type { CommandInfo } from "@wirecat/cli-base/commands"
import { writes } from "@wirecat/cli-base/standards"
import {
  AUTHORITY_KEY,
  authorityAllowed,
  BOT_API_KEY,
  botApiAllowed,
  CEILING_KEY,
  isBotApi,
  keyForCommand,
  type Level,
  levelFor,
  type PermissionKey,
  readKeysForCommand,
} from "../sends/permissions.js"
import { changesMessenger } from "./effects.js"
import type { CommandPermissions } from "./permission-keys.js"

export type AvailabilityCommand = Pick<CommandInfo, "path" | "effects" | "lifetime" | "reaches">
export interface DiscoveredCommand extends CommandInfo {
  availability?: CommandAvailability
  commands: readonly DiscoveredCommand[]
}

export interface CommandAvailability {
  available: boolean
  reason?: string
  /** The permission key the profile judges this command by; absent when no key governs it. */
  permission?: string
  /** The profile's level for that key, so a caller sees `readonly` and `ask` before it runs anything. */
  level?: Level
}

/** Discovery and execution use the same permission decision. */
export const commandAvailability = (
  info: AvailabilityCommand,
  levels: Readonly<Record<PermissionKey, Level>>,
  keyOf?: (path: readonly string[]) => PermissionKey | null | undefined,
  authority?: (path: readonly string[]) => boolean,
  readOnly = false,
  mcp = true,
  declared?: CommandPermissions,
  /** Whether a command only fetches into the store (`fetchesOnlyAt`): setup's "read only" answer lets it run. */
  fetches?: (path: readonly string[]) => boolean,
): CommandAvailability => {
  const declaredKey = declared?.keyOf(info.path)
  const key = declared ? declaredKey : (keyOf?.(info.path) ?? keyForCommand(info.path))
  const { level, key: named } = key ? levelFor(levels, key, declared?.defaults) : { level: "allow" as const, key: null }
  const judged = { ...(key ? { permission: key } : {}), level }
  const blocked = (reason: string, permission?: string): CommandAvailability => ({
    available: false,
    reason,
    ...judged,
    ...(permission && permission !== judged.permission
      ? { permission, level: levelFor(levels, permission).level }
      : {}),
  })
  // As `refuseByCommandPermissions` judges it before the run: a keyed write to the service, or undeclared effects.
  const declaredChange = Boolean(declaredKey) && (info.effects === undefined || info.effects.remote === "write")
  if (readOnly && (changesMessenger(info) || declaredChange || authority?.(info.path)))
    return blocked("the read-only lock blocks this change")
  if (mcp && authority?.(info.path) && !authorityAllowed(levels))
    return blocked(`the profile keeps ${AUTHORITY_KEY} off`, AUTHORITY_KEY)
  if (mcp && isBotApi(info.path) && !botApiAllowed(levels))
    return blocked(`the profile requires ${BOT_API_KEY}: allow`, BOT_API_KEY)
  if (level === "deny") return blocked(`the profile denies ${key}`)
  if (level === "readonly" && writes(info.effects) && !(named === CEILING_KEY && fetches?.(info.path) === true))
    return blocked(`${key} is readonly in this profile`)
  const denied = (declared ? [] : readKeysForCommand(info.path)).find((read) => levelFor(levels, read).level === "deny")
  return denied ? blocked(`the profile denies ${denied}`, denied) : { available: true, ...judged }
}
