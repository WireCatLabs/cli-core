import type { CommandInfo } from "@wirecat/cli-base/commands"
import { writes } from "@wirecat/cli-base/standards"
import {
  AUTHORITY_KEY,
  authorityAllowed,
  BOT_API_KEY,
  botApiAllowed,
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
  permission?: string
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
): CommandAvailability => {
  const blocked = (reason: string, permission?: string): CommandAvailability => ({
    available: false,
    reason,
    ...(permission ? { permission } : {}),
  })
  const declaredKey = declared?.keyOf(info.path)
  // As `refuseByCommandPermissions` judges it before the run: a keyed write to the service.
  const declaredChange = Boolean(declaredKey) && info.effects?.remote === "write"
  if (readOnly && (changesMessenger(info) || declaredChange || authority?.(info.path)))
    return blocked("the read-only lock blocks this change")
  if (mcp && authority?.(info.path) && !authorityAllowed(levels))
    return blocked(`the profile keeps ${AUTHORITY_KEY} off`, AUTHORITY_KEY)
  if (mcp && isBotApi(info.path) && !botApiAllowed(levels))
    return blocked(`the profile requires ${BOT_API_KEY}: allow`, BOT_API_KEY)
  const key = declared ? declaredKey : (keyOf?.(info.path) ?? keyForCommand(info.path))
  const level = key ? levelFor(levels, key, declared?.defaults).level : "allow"
  if (level === "deny") return blocked(`the profile denies ${key}`, key ?? undefined)
  if (level === "readonly" && writes(info.effects))
    return blocked(`${key} is readonly in this profile`, key ?? undefined)
  const denied = (declared ? [] : readKeysForCommand(info.path)).find((read) => levelFor(levels, read).level === "deny")
  return denied ? blocked(`the profile denies ${denied}`, denied) : { available: true }
}
