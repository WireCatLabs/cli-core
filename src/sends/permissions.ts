import { CliError } from "@wirecat/cli-base"
import type { AccountAction, ChatAction, SendKind } from "./journal.js"

/** What a profile may do with one command path — the standard's "Permissions". */
export const LEVELS = ["deny", "readonly", "ask", "allow"] as const

export type Level = (typeof LEVELS)[number]

/** A command path, dotted: `messages`, `messages.delete`, `chats.members.remove`. */
export type PermissionKey = string

/** The deletions nobody gets back: the word that skips their question is `--allow-dangerous`, never `--yes`. */
const DANGEROUS = new Set(["messages.delete", "bot.messages.delete", "topics.delete", "chats.delete", "chats.clear"])

/** Deleting has its own word for "yes": the flag a person has to mean, not a habit (max-cli `NEED-238`). */
export const skipFlagFor = (key: string): "--allow-dangerous" | "--yes" =>
  DANGEROUS.has(key) ? "--allow-dangerous" : "--yes"

/** Only what cannot be undone asks; the tool is meant to work without questions (owner, NEED-460). */
export const DEFAULT_PERMISSIONS: Readonly<Record<PermissionKey, Level>> = {
  "messages.delete": "ask",
  "account.sessions.end": "ask",
  "bot.messages.delete": "ask",
  "topics.enable": "ask",
  "topics.delete": "ask",
  "chats.delete": "ask",
  "chats.clear": "ask",
  // NEED-568: a rule writes to people with nobody typing a command; it waits for the owner's own allow.
  "replies.send": "deny",
  // NEED-1662: an agent that changes settings, schedules or recipients could lift its own limits; the owner opts in.
  "mcp.authority": "deny",
  // NEED-1663: writes no level stopped before, so MCP could not offer them; over MCP `ask` goes ahead.
  "store.backup": "ask",
  "store.restore": "ask",
  "store.migrate": "ask",
  "store.repair": "ask",
  "store.reset": "ask",
  "store.clear": "ask",
  "store.decrypt": "ask",
  "store.copies.delete": "ask",
  "server.start": "ask",
  "server.stop": "ask",
  "server.restart": "ask",
  "models.download": "ask",
  "images.models.download": "ask",
  "schedule.run": "ask",
  "schedule.exec": "ask",
  "doctor.reports.create": "ask",
}

/** Commands under a housekeeping word, or store maintenance, that still have a key of their own: their path. */
const KEYED_UNDER_HOUSEKEEPING = new Set(
  Object.keys(DEFAULT_PERMISSIONS).filter((key) => /^(store|server|models|images|schedule|doctor)\./.test(key)),
)

/** Lets an MCP server offer the commands that change what a later run may do (`grantsAuthority`). */
export const AUTHORITY_KEY: PermissionKey = "mcp.authority"

/** Whether these levels let an agent run a command that changes what a later run may do; `ask` does, as for any write. */
export const authorityAllowed = (levels: Readonly<Record<PermissionKey, Level>>): boolean => {
  const { level } = levelFor(levels, AUTHORITY_KEY)
  return level === "allow" || level === "ask"
}

/** Lets an MCP server offer `bot api`, whose calls skip the send guard and the bot's recipient list (NEED-1679). */
export const BOT_API_KEY: PermissionKey = "bot.api"

export const isBotApi = (path: readonly string[]): boolean => path[0] === "bot" && path[1] === "api"

/**
 * Deny by default for an MCP server only: the key stays out of `DEFAULT_PERMISSIONS` because the command line's
 * `bot api` is checked per operation (`bot.api.<operation>`), and a default there would deny it for the owner too.
 * A broader `bot: allow` does not lift it; `ask` goes ahead over MCP, as for any write.
 */
export const botApiAllowed = (levels: Readonly<Record<PermissionKey, Level>>): boolean => {
  const { level } = levelFor(levels, BOT_API_KEY, { ...DEFAULT_PERMISSIONS, [BOT_API_KEY]: "deny" })
  return level === "allow" || level === "ask"
}

/** The resources at the top of the command tree, which `readOnly` and `allow` turn read-only as a whole. */
export const RESOURCES = [
  "messages",
  "drafts",
  "reactions",
  "polls",
  "topics",
  "chats",
  "contacts",
  "account",
  "bot",
  "conversations",
  "tags",
  "mentions",
  "search",
  "searches",
  "tasks",
  "replies",
  "attachments",
  "stats",
  "store",
  "metadata",
  "mcp",
  "server",
  "models",
  "schedule",
  "doctor",
  "images",
] as const

/**
 * Layers come nearest first. A key a nearer layer sets hides that key and every key under it in the
 * farther layers, so a profile's `messages: readonly` is not undone by `messages.delete: allow` in
 * `defaults` — the nearest section wins, as it does for every other setting (NEED-573).
 */
export const layerPermissions = (layers: readonly [string, Readonly<Record<PermissionKey, Level>> | undefined][]) => {
  const levels: Record<PermissionKey, Level> = {}
  const sources: Record<PermissionKey, string> = {}
  for (const [from, layer] of layers) {
    const nearer = Object.keys(levels)
    for (const [key, level] of Object.entries(layer ?? {})) {
      if (nearer.some((named) => key === named || key.startsWith(`${named}.`))) continue
      levels[key] = level
      sources[key] = from
    }
  }
  return { levels, sources }
}

/**
 * The owner's first-run answer, held among a profile's levels: no key of any profile goes above it. Only `setup`
 * at a terminal writes it, so an agent cannot lift it with `config set`.
 */
export const CEILING_KEY = "*"

const ALLOWED = { level: "allow", key: null } as const

const ORDER: Record<Level, number> = { deny: 0, readonly: 1, ask: 2, allow: 3 }

const nearest = (levels: Readonly<Record<PermissionKey, Level>>, key: PermissionKey) => {
  for (let parts = key.split("."); parts.length > 0; parts = parts.slice(0, -1)) {
    const named = parts.join(".")
    const level = levels[named]
    if (level) return { level, key: named, depth: parts.length }
  }
  return undefined
}

/**
 * The most specific key the owner set wins. A built-in default (`DEFAULT_PERMISSIONS`) only ever
 * tightens: against a broader key of the owner's, the stricter of the two holds — so
 * `messages: readonly` still stops a deletion, and `messages: allow` does not drop its question.
 * A path nothing names is allowed.
 */
export const levelFor = (
  permissions: Readonly<Record<PermissionKey, Level>>,
  key: PermissionKey,
  defaults: Readonly<Record<PermissionKey, Level>> = DEFAULT_PERMISSIONS,
): { level: Level; key: PermissionKey | null } => {
  const found = profileLevel(permissions, key, defaults)
  const ceiling = permissions[CEILING_KEY]
  return ceiling && ORDER[ceiling] < ORDER[found.level] ? { level: ceiling, key: CEILING_KEY } : found
}

const profileLevel = (
  permissions: Readonly<Record<PermissionKey, Level>>,
  key: PermissionKey,
  defaults: Readonly<Record<PermissionKey, Level>>,
): { level: Level; key: PermissionKey | null } => {
  const own = nearest(permissions, key)
  const builtIn = nearest(defaults, key)
  if (!builtIn || (own && own.depth >= builtIn.depth)) return own ? { level: own.level, key: own.key } : ALLOWED
  if (!own || ORDER[builtIn.level] <= ORDER[own.level]) return { level: builtIn.level, key: builtIn.key }
  return { level: own.level, key: own.key }
}

const CHAT_KEYS: Partial<Record<ChatAction, PermissionKey>> = {
  settings: "chats.update",
  "requests.accept": "chats.requests.confirm",
  "requests.decline": "chats.requests.reject",
  "link.create": "chats.links.create",
  "link.reset": "chats.links.reset",
  "link.revoke": "chats.links.remove",
  "link.update": "chats.links.update",
}

const ACCOUNT_KEYS: Record<AccountAction, PermissionKey> = {
  "contact-add": "contacts.add",
  "contact-remove": "contacts.remove",
  "contact-import": "contacts.import",
  "contact-rename": "contacts.rename",
  "contact-block": "contacts.block",
  "contact-unblock": "contacts.unblock",
  profile: "account.update",
  "folder-create": "chats.folders.create",
  "folder-update": "chats.folders.update",
  "folder-delete": "chats.folders.delete",
  "folder-order": "chats.folders.order",
  "folder-join": "chats.folders.join",
  "sessions-end": "account.sessions.end",
  "chat-mute": "chats.mute",
  "chat-unmute": "chats.unmute",
  "chat-archive": "chats.archive",
  "chat-unarchive": "chats.unarchive",
  "chat-pin": "chats.pin",
  "chat-unpin": "chats.unpin",
  "chat-mark-unread": "chats.mark-unread",
  "message-star": "messages.star",
  "message-unstar": "messages.unstar",
  privacy: "account.privacy.set",
}

const KIND_KEYS: Record<Exclude<SendKind, "chat" | "account">, PermissionKey> = {
  message: "messages.send",
  forward: "messages.forward",
  edit: "messages.edit",
  pin: "messages.pin",
  reaction: "reactions",
  read: "chats.mark-read",
  delete: "messages.delete",
}

/** The command path a guarded write belongs to, when the caller did not name it. */
export const keyForWrite = (kind: SendKind, action?: string): PermissionKey => {
  if (kind === "chat") return CHAT_KEYS[action as ChatAction] ?? `chats.${action ?? "update"}`
  if (kind === "account") {
    const key = ACCOUNT_KEYS[action as AccountAction]
    if (!key) throw new Error(`an account change without a known action: ${action}`)
    return key
  }
  return KIND_KEYS[kind]
}

/** `keyForWrite` read backwards, as far as a command's key says it: an unpin is a `pin`, a chat change names its action. */
export const writeOfKey = (key: PermissionKey): { kind?: SendKind; action?: ChatAction | AccountAction } => {
  const account = Object.entries(ACCOUNT_KEYS).find(([, named]) => named === key)?.[0]
  if (account) return { kind: "account", action: account as AccountAction }
  const kind = Object.entries(KIND_KEYS).find(([, named]) => named === key || key.startsWith(`${named}.`))?.[0]
  if (kind) return { kind: kind as SendKind }
  if (key === "messages.unpin") return { kind: "pin" }
  if (key.startsWith("chats.")) {
    const action = Object.entries(CHAT_KEYS).find(([, named]) => named === key)?.[0] ?? key.slice("chats.".length)
    return { kind: "chat", action: action as ChatAction }
  }
  return {}
}

/** Write keys written out where a write is checked; `permission-keys.test.ts` keeps this list whole. */
const NAMED_WRITE_KEYS = [
  "drafts",
  "store.gaps.repair",
  "messages.sync-first",
  "messages.server-search",
  "messages.press",
  "chats.start",
  "chats.app",
  "stats.messages.counters.sync",
  "stats.messages.show.sync-first",
  "stats.messages.top.sync-first",
  "stats.contacts.top.sync-first",
  "account.sessions.list",
  "attachments.extract",
  "attachments.move",
  "attachments.update",
  "bot.callbacks.answer",
  "bot.chats.action",
  "bot.chats.admins.add",
  "bot.chats.admins.remove",
  "bot.chats.leave",
  "bot.chats.members.remove",
  "bot.chats.moderate",
  "bot.messages.delete",
  "bot.messages.edit",
  "bot.messages.pin",
  "bot.messages.send",
  "bot.messages.unpin",
  "chats.admins.add",
  "chats.admins.remove",
  "chats.links.create",
  "chats.links.reset",
  "chats.links.remove",
  "chats.links.update",
  "chats.members.add",
  "chats.members.remove",
  "chats.moderate",
  "conversations.embeddings",
  "conversations.links",
  "polls.close",
  "polls.create",
  "polls.vote",
  "searches.clear",
  "searches.create",
  "searches.delete",
  "contacts.aliases.set",
  "contacts.aliases.remove",
  "contacts.notes.add",
  "contacts.notes.edit",
  "contacts.notes.remove",
  "tags.rebuild",
  "metadata.sync",
  "mentions.rebuild",
  "mentions.confirm",
  "mentions.reject",
  "tags.add",
  "tags.remove",
  "tasks.add",
  "tasks.claim",
  "tasks.close",
  "tasks.duplicates.defer",
  "tasks.duplicates.reject",
  "tasks.link",
  "tasks.merge",
  "tasks.update",
  "tasks.release",
  "tasks.scan",
  "tasks.unmerge",
  "topics.create",
  "topics.edit",
  "topics.enable",
]

/** Every key a write is checked against that a command path may not spell out. */
export const WRITE_KEYS: readonly PermissionKey[] = [
  ...new Set([
    ...NAMED_WRITE_KEYS,
    ...Object.keys(DEFAULT_PERMISSIONS),
    ...Object.values(KIND_KEYS),
    ...Object.values(ACCOUNT_KEYS),
    ...(Object.values(CHAT_KEYS) as PermissionKey[]),
  ]),
]

/** Commands that look after the tool and its files and never show a message: no level stops them. */
const HOUSEKEEPING = new Set([
  "help",
  "guide",
  "config",
  "session",
  "doctor",
  "commands",
  "complete",
  "upgrade",
  "skill",
  "models",
  "server",
  // What a schedule runs is checked by its own key when it runs; an agent runs read-only.
  "schedule",
  "runs",
  "sends",
  "recipients",
  "flood",
  "mcp",
  // Its commands read the rules or flip the pause switch; what a rule sends is checked as `replies.send`.
  "replies",
])

/** Under `bot`: its token, its names, its lists and its MCP server. */
const BOT_HOUSEKEEPING = new Set(["auth", "list", "sends", "recipients", "mcp"])

const STORE_MAINTENANCE = new Set(["info", "check", "copies"])

/** Commands outside `messages` that print what people wrote, so `deny messages` reaches them too. */
const SHOW_MESSAGES = new Set(["inbox", "review", "watch", "serve", "store", "conversations"])

export const readKeysForCommand = (path: readonly string[]): PermissionKey[] => {
  if (path[0] === "bot") return readKeysForCommand(path.slice(1)).map((key) => `bot.${key}`)
  const key = keyForCommand(path)
  if (!key) return []
  if (path[0] === "attachments" && path[1] === "download") return [key, "messages", "chats"]
  if (path[0] === "attachments" && (path[1] === "extract" || path[1] === "show")) return [key, "messages"]
  if (path[0] === "store" && path[1] === "gaps" && path[2] === "repair") return [key, "messages"]
  // Checked as `messages` before they had keys of their own: `deny messages` keeps stopping them.
  if (path[0] === "store" && ["reset", "clear", "decrypt"].includes(path[1] ?? "")) return [key, "messages"]
  // A search shows what people wrote, so `deny messages` reaches every leaf that reads messages.
  if (path[0] === "search") {
    if (path[1] === "notes") return [key]
    if (path[1] === "topics") return [key, "topics"]
    if (path[1] === "conversations") return [key, "messages", "conversations"]
    return [key, "messages"]
  }
  if (path[0] !== "stats") return [key]
  const resource = path[1] === "charts" ? "chats" : path[1]
  return [
    ...new Set([
      key,
      "messages",
      ...(["chats", "contacts", "tasks"].includes(resource ?? "") ? [resource as string] : []),
    ]),
  ]
}

/**
 * The key a command path is checked against: `null` for housekeeping, which no level stops, and
 * `undefined` for a path this package does not know — a CLI's own command, which its CLI maps.
 */
export const keyForCommand = (path: readonly string[]): PermissionKey | null | undefined => {
  if (path.length === 0) return null
  const [top, next] = path
  if (top === "bot") {
    if (next === undefined || BOT_HOUSEKEEPING.has(next)) return null
    const inner = keyForCommand(path.slice(1))
    return `bot.${inner ?? path.slice(1).join(".")}`
  }
  if (KEYED_UNDER_HOUSEKEEPING.has(path.join("."))) return path.join(".")
  if (top === undefined || HOUSEKEEPING.has(top) || (top === "search" && next === "runs")) return null
  // A model is housekeeping wherever it is listed.
  if (top === "images" && next === "models") return null
  if (top === "attachments" && (next === "check" || next === "jobs")) return null
  if (top === "attachments" && next === "download") return "messages"
  if (top === "store" && next !== undefined && STORE_MAINTENANCE.has(next)) return null
  // The agent's answers write only to the local store: their own key, so read-only messages can still link (phase 4 A10).
  if (top === "conversations" && next === "links")
    return path[2] === "rebuild" ? "conversations.links.rebuild" : "conversations.links"
  // Vectors are written to the local store only, and the text never leaves the machine (phase 5 E10).
  if (
    (top === "conversations" && (next === "embeddings" || next === "embed")) ||
    (top === "images" && next === "embed") ||
    (top === "conversations" && next === "rebuild")
  )
    return "conversations.embeddings"
  // Which files a message has, and where they are saved, tells as much as a message does; so does who
  // shared which document link, and when.
  if ((top === "attachments" && next === "list") || (top === "chats" && next === "documents")) return "messages"
  // A mention is a piece of a message's text: reading one is reading messages; rebuilding writes only derived rows.
  if (top === "mentions")
    return next === "rebuild" || next === "confirm" || next === "reject" ? `mentions.${next}` : "messages"
  if (top === "store" && (next === "gaps" || next === "jobs")) return path.join(".")
  if (SHOW_MESSAGES.has(top) || (top === "contacts" && (next === "context" || next === "prepare" || next === "events")))
    return "messages"
  if ((RESOURCES as readonly string[]).includes(top)) return path.join(".")
  return undefined
}

/** A messenger's key starts with one of its resources, so a misspelled resource is refused by its shape alone. */
export const RESOURCE_KEY = new RegExp(`^(${RESOURCES.join("|")})(\\.[a-z][a-z-]*)*$`)

/**
 * A key of a CLI that declares its own commands (`commandPermissions`): any command path. Which paths exist is
 * checked against the program, not here. Past the first word a key may hold capitals, as Google's method ids do
 * (`api.calendar.calendarList.list`).
 */
export const COMMAND_PATH_KEY = /^[a-z][a-z-]*(\.[a-zA-Z][a-zA-Z-]*)*$/

/** Startup overrides are a nearer layer than the saved profile, and never write that profile. */
export const permissionOverrides = (
  entries: readonly string[] = [],
  shape: RegExp = RESOURCE_KEY,
): Record<PermissionKey, Level> => {
  const levels: Record<PermissionKey, Level> = {}
  const example = shape === RESOURCE_KEY ? "messages.send=allow" : "api=readonly"
  for (const entry of entries) {
    const [key = "", level = "", extra] = entry.split("=")
    if (!shape.test(key) || !(LEVELS as readonly string[]).includes(level) || extra !== undefined)
      throw new CliError(
        "validation_error",
        `--permission takes a command path and level, e.g. ${example} (deny, readonly, ask, allow)`,
      )
    levels[key] = level as Level
  }
  return levels
}

/** No startup flag grants access: an override may narrow the profile's level, never lift it or a key under it. */
export const assertOverridesTighten = (
  overrides: Readonly<Record<PermissionKey, Level>>,
  profile: Readonly<Record<PermissionKey, Level>>,
  defaults: Readonly<Record<PermissionKey, Level>> = DEFAULT_PERMISSIONS,
): void => {
  for (const [key, level] of Object.entries(overrides)) {
    const under = Object.keys(profile).filter((named) => named.startsWith(`${key}.`))
    const lifted = [key, ...under].find((named) => ORDER[level] > ORDER[levelFor(profile, named, defaults).level])
    if (lifted !== undefined)
      throw new CliError(
        "validation_error",
        `--permission ${key}=${level} would loosen ${lifted} from ${levelFor(profile, lifted, defaults).level}; ` +
          "it only tightens — change the profile's permissions to loosen it",
        { key, lifted },
      )
  }
}

export const assertRetentionEvidenceRead = (permissions: Readonly<Record<string, Level>>): void => {
  for (const permission of ["stats.chats.retention", "chats"]) {
    if (levelFor(permissions, permission).level === "deny")
      throw new CliError("permission_error", `profile denies ${permission}`, { permission })
  }
}
