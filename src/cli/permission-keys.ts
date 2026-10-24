import type { Command } from "commander"
import { canonicalPermissionKey } from "../sends/permission-aliases.js"
import { CEILING_KEY, keyForCommand, type PermissionKey, WRITE_KEYS } from "../sends/permissions.js"

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
    key = canonicalPermissionKey(key)
    for (let parts = key.split("."); parts.length > 0; parts = parts.slice(0, -1)) known.add(parts.join("."))
  }
  for (const one of everyCommand(rootOf(command))) {
    const key = keyOf(one)
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
