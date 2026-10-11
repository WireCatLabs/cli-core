import { CliError } from "@wirecat/cli-base"
import {
  fromOldSettings,
  LEVELS,
  type Level,
  layerPermissions,
  levelFor,
  PERMISSIONS,
  type Permission,
  RESOURCES,
} from "../sends/permissions.js"
import type { Config, ProfileKind } from "./settings.js"

type Scope = Record<string, unknown>
type Levels = Record<string, Level>
const LEGACY = ["readOnly", "allow", "mcpTools"] as const
const KINDS: ProfileKind[] = ["personal", "bot"]

export interface PermissionMigration {
  config: Config
  changed: boolean
  changes: { scope: string; removed: string[]; permissions: Levels }[]
}

const scopes = (config: Config): Map<string, Scope> =>
  new Map([
    ...(config.defaults ? [["defaults", config.defaults] as const] : []),
    ...Object.entries(config.profiles).map(([name, scope]) => [`profiles.${name}`, scope] as const),
    ...KINDS.flatMap((kind) => [
      ...(config[kind]?.defaults ? [[`${kind}.defaults`, config[kind]?.defaults as Scope] as const] : []),
      ...Object.entries(config[kind]?.profiles ?? {}).map(
        ([name, scope]) => [`${kind}.profiles.${name}`, scope] as const,
      ),
    ]),
  ])
const levels = (scope: Scope | undefined): Levels => (scope?.permissions ?? {}) as Levels
const effective = (config: Config, kind: ProfileKind, profile?: string): Levels => {
  const own = (profiles: Record<string, Scope> | undefined) =>
    profile === undefined || !Object.hasOwn(profiles ?? {}, profile) ? undefined : profiles?.[profile]
  const layers: (Scope | undefined)[] = [
    own(config[kind]?.profiles),
    own(config.profiles),
    config[kind]?.defaults,
    config.defaults,
  ]
  const nearest = (key: string) => layers.findIndex((scope) => scope?.[key] !== undefined)
  const readOnly = layers[nearest("readOnly")]?.readOnly === true
  const allow = layers[nearest("allow")]?.allow as Permission[] | undefined
  const old = fromOldSettings(readOnly, allow, { bot: kind === "bot" })
  const oldAt = nearest(readOnly ? "readOnly" : "allow")
  return layerPermissions(
    layers.flatMap((scope, at): [string, Levels][] => [
      ["", levels(scope)],
      ...(at === oldAt ? [["", old] as [string, Levels]] : []),
    ]),
  ).levels
}

/** Input is a schema-validated configuration; legacy fields are checked before any transformation. */
const migrateLegacyPermissionConfig = (input: Config): PermissionMigration => {
  const before = scopes(input)
  for (const [name, scope] of before) {
    if (scope.readOnly !== undefined && typeof scope.readOnly !== "boolean")
      throw invalid(`${name}.readOnly must be true or false`)
    if (
      scope.allow !== undefined &&
      (!Array.isArray(scope.allow) || !scope.allow.every((word) => PERMISSIONS.includes(word)))
    )
      throw invalid(`${name}.allow must be a list of known actions`)
    if (
      scope.mcpTools !== undefined &&
      (!Array.isArray(scope.mcpTools) || !scope.mcpTools.every((word) => typeof word === "string"))
    )
      throw invalid(`${name}.mcpTools must be a list`)
    if (
      scope.permissions !== undefined &&
      (scope.permissions === null ||
        typeof scope.permissions !== "object" ||
        Array.isArray(scope.permissions) ||
        !Object.values(scope.permissions).every((level) => LEVELS.includes(level)))
    )
      throw invalid(`${name}.permissions must contain permission levels`)
  }
  if (![...before.values()].some((scope) => LEGACY.some((key) => Object.hasOwn(scope, key))))
    return { config: input, changed: false, changes: [] }
  const next = structuredClone(input)
  for (const scope of scopes(next).values()) for (const key of LEGACY) delete scope[key]
  const names = [
    ...new Set([...Object.keys(input.profiles), ...KINDS.flatMap((kind) => Object.keys(input[kind]?.profiles ?? {}))]),
  ].sort()
  const allMaps = KINDS.flatMap((kind) => [
    effective(input, kind),
    ...names.map((name) => effective(input, kind, name)),
  ])
  const keys = [...new Set([...RESOURCES, ...allMaps.flatMap((map) => Object.keys(map))])].sort(
    (a, b) => a.split(".").length - b.split(".").length || a.localeCompare(b),
  )
  const root = {
    ...effective({ profiles: {}, defaults: input.defaults }, "personal"),
    ...effective({ profiles: {}, defaults: input.defaults }, "bot"),
  }
  next.defaults ??= {}
  next.defaults.permissions = root
  const restore = (kind: ProfileKind, name?: string) => {
    const wanted = effective(input, kind, name)
    for (const key of keys.filter((key) =>
      kind === "bot" ? key === "bot" || key.startsWith("bot.") : key !== "bot" && !key.startsWith("bot."),
    )) {
      const target = levelFor(wanted, key).level
      if (levelFor(effective(next, kind, name), key).level === target) continue
      next[kind] ??= {}
      const section = next[kind]
      let scope: Scope
      if (name === undefined) {
        section.defaults ??= {}
        scope = section.defaults
      } else {
        scope = Object.hasOwn(section.profiles ?? {}, name) ? (section.profiles?.[name] ?? {}) : {}
        section.profiles = { ...section.profiles, [name]: scope }
      }
      scope.permissions = { ...levels(scope), [key]: target }
    }
  }
  // A replacement allow-list must not inherit a permitted child from translated broader defaults.
  for (const kind of KINDS) {
    restore(kind)
    for (const name of names) restore(kind, name)
  }
  const after = scopes(next)
  const changes = [...new Set([...before.keys(), ...after.keys()])].flatMap((scope) => {
    const removed = LEGACY.filter((key) => Object.hasOwn(before.get(scope) ?? {}, key))
    const permissions = levels(after.get(scope))
    return removed.length > 0 || JSON.stringify(levels(before.get(scope))) !== JSON.stringify(permissions)
      ? [{ scope, removed, permissions }]
      : []
  })
  return { config: next, changed: true, changes }
}
const invalid = (message: string) => new CliError("configuration_error", message)

export const migratePermissionConfig = (input: Config): PermissionMigration => {
  const renamed = structuredClone(input)
  const changes: PermissionMigration["changes"] = []
  const replacements = {
    "messages.stats": "stats.messages.show",
    "chats.stats": "stats.chats.show",
    "tasks.stats": "stats.tasks.show",
    "messages.search": "search.messages",
    "conversations.search": "search.conversations",
    "topics.search": "search.topics",
  }
  for (const [name, scope] of scopes(renamed)) {
    if (!scope.permissions || typeof scope.permissions !== "object" || Array.isArray(scope.permissions)) continue
    const permissions = scope.permissions as Levels
    let changed = false
    for (const prefix of ["", "bot."]) {
      for (const [from, to] of Object.entries(replacements)) {
        const source = `${prefix}${from}`
        for (const old of Object.keys(permissions)) {
          if (old !== source && !old.startsWith(`${source}.`)) continue
          const next = `${prefix}${to}${old.slice(source.length)}`
          if (Object.hasOwn(permissions, next) && permissions[next] !== permissions[old])
            throw invalid(`${name}.permissions has conflicting ${old} and ${next} — keep one level before migrating`)
          permissions[next] = permissions[old] as Level
          delete permissions[old]
          changed = true
        }
      }
    }
    if (changed) changes.push({ scope: name, removed: [], permissions: { ...permissions } })
  }
  const legacy = migrateLegacyPermissionConfig(renamed)
  return {
    config: legacy.config,
    changed: changes.length > 0 || legacy.changed,
    changes: [...changes, ...legacy.changes],
  }
}

export const hasPermissionConfig = (input: Config): boolean =>
  [...scopes(input).values()].some((scope) => Object.hasOwn(scope, "permissions"))
