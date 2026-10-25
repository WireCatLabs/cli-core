import { CliError } from "@wirecat/cli-base"
import type { Command } from "commander"
import { CEILING_KEY, keyForCommand, type PermissionKey, WRITE_KEYS } from "../sends/permissions.js"
import { type ConfigIssue, issueMessage, permissionIssues, publicIssue } from "./config-issues.js"
import type { Settings } from "./settings.js"

export type PermissionKeyOf = (command: Command) => PermissionKey | null | undefined

const pathOf = (command: Command): string[] => {
  const words: string[] = []
  for (let at: Command | null = command; at?.parent; at = at.parent) words.unshift(at.name())
  return words
}

const rootOf = (command: Command): Command => {
  let at = command
  while (at.parent) at = at.parent
  return at
}

const everyCommand = (command: Command): Command[] => [command, ...command.commands.flatMap(everyCommand)]

/**
 * The keys `permissions` may name: every command of the program, every write key, and each of their
 * parents. A key outside it is a typo that would otherwise do nothing (BUG-137).
 */
export const knownPermissionKeys = (
  command: Command,
  keyOf: PermissionKeyOf = (one) => keyForCommand(pathOf(one)),
  extra: readonly PermissionKey[] = [],
): Set<PermissionKey> => {
  const known = new Set<PermissionKey>()
  const add = (key: PermissionKey) => {
    for (let parts = key.split("."); parts.length > 0; parts = parts.slice(0, -1)) known.add(parts.join("."))
  }
  for (const one of everyCommand(rootOf(command))) {
    const own = keyOf(one)
    const key = own === undefined ? keyForCommand(pathOf(one)) : own
    if (key) add(key)
  }
  for (const key of [...WRITE_KEYS, ...extra]) add(key)
  return known
}

/** The known keys one level under the unknown key's parent, to name in the refusal. */
export const knownBeside = (key: PermissionKey, known: ReadonlySet<PermissionKey>): PermissionKey[] => {
  const parent = key.split(".").slice(0, -1).join(".")
  const depth = parent === "" ? 1 : parent.split(".").length + 1
  return [...known]
    .filter((one) => one.split(".").length === depth && (parent === "" || one.startsWith(`${parent}.`)))
    .sort()
}

export const unknownPermissionKeys = (
  levels: Readonly<Record<PermissionKey, unknown>>,
  known: ReadonlySet<PermissionKey>,
): PermissionKey[] => Object.keys(levels).filter((key) => key !== CEILING_KEY && !known.has(key))

/** Every unknown permission key saved in the file, in every section and profile, with the unset that removes it. */
export const unknownPermissionIssues = (
  command: Command,
  settings: Pick<Settings, "configPath" | "savedPermissions" | "permissions" | "permissionSources" | "profile">,
  tool: string,
  keyOf?: PermissionKeyOf,
): ConfigIssue[] => {
  const saved =
    settings.savedPermissions ??
    Object.keys(settings.permissions)
      .filter((key) => key !== CEILING_KEY && settings.permissionSources[key] !== "flag")
      .map((key) => ({ key, at: ["profiles", settings.profile, "permissions", key] }))
  return permissionIssues(saved, knownPermissionKeys(command, keyOf), { file: settings.configPath, tool }).map(
    publicIssue,
  )
}

/**
 * A saved key no command checks would do nothing, so the command refuses to run and names the unset that removes
 * it. A `--permission` key is checked too: it is no file's, so the flag is the fix.
 */
export const refuseUnknownPermissionKeys = (
  command: Command,
  settings: Pick<Settings, "configPath" | "savedPermissions" | "permissions" | "permissionSources" | "profile">,
  tool: string,
  keyOf?: PermissionKeyOf,
): void => {
  const issues = unknownPermissionIssues(command, settings, tool, keyOf)
  if (issues.length > 0) throw new CliError("configuration_error", issueMessage(issues), { permission: issues[0]?.key })
  const flagged = Object.keys(settings.permissions).filter((key) => settings.permissionSources[key] === "flag")
  const [key] = unknownPermissionKeys(
    Object.fromEntries(flagged.map((one) => [one, true])),
    knownPermissionKeys(command, keyOf),
  )
  if (key !== undefined)
    throw new CliError("validation_error", `--permission ${key} names no command`, { permission: key })
}
