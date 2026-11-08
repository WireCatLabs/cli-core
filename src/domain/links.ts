import { parseReference } from "./references.js"

/**
 * What a WireCat link opens. A link only opens a screen in WireCat Desktop: no kind performs an action, a proposal
 * link shows the proposal and the owner presses Confirm or Reject there.
 */
export type LinkTarget =
  | { type: "message"; provider: string; account: string; chat: string; message: string }
  | { type: "chat"; provider: string; account: string; chat: string }
  | { type: "task"; id: string }
  | { type: "tasks"; filter: "overdue" | "today" | "tomorrow" }
  | { type: "tasks"; filter: "new"; since: string }
  /** A review id as `memo review` shows it (`17070`, `fact:512`): not a reference, so it is one encoded part. */
  | { type: "proposal"; id: string }
  | { type: "digest"; date: string }
  | { type: "sync"; tool: string; account?: string }

export type LinkForm = "web" | "app"

export interface LinkConfig {
  /** The bounce page: the path goes after its `#`, so the host never sees it. */
  base: string
  enabled: boolean
}

export const LINK_VERSION = "v1"
export const DEFAULT_LINK_CONFIG: LinkConfig = { base: "https://wirecat.dev/o", enabled: true }
const APP_PREFIX = "wirecat://open"
const MAX_PATH = 512
const MAX_SEGMENTS = 6
const TASK_FILTERS = ["overdue", "today", "tomorrow"] as const
const DATE = /^\d{4}-\d{2}-\d{2}$/
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/

const isMoment = (text: string, pattern: RegExp) => pattern.test(text) && !Number.isNaN(Date.parse(text))

const partsOf = (target: LinkTarget): string[] => {
  switch (target.type) {
    case "message":
      return ["msg", target.provider, target.account, target.chat, target.message]
    case "chat":
      return ["chat", target.provider, target.account, target.chat]
    case "task":
      return ["task", target.id]
    case "tasks":
      return target.filter === "new" ? ["tasks", "new", target.since] : ["tasks", target.filter]
    case "proposal":
      return ["proposal", target.id]
    case "digest":
      return ["digest", target.date]
    case "sync":
      return target.account === undefined ? ["sync", target.tool] : ["sync", target.tool, target.account]
  }
}

/** The path after the version, `msg/max/1001/-2002/3003`: each part percent-encoded, so no id can add a part. */
const pathOf = (target: LinkTarget) => partsOf(target).map(encodeURIComponent).join("/")

const targetOfParts = (parts: string[]): LinkTarget | null => {
  const [kind, ...rest] = parts
  const [a = "", b = "", c = "", d = ""] = rest
  switch (kind) {
    case "msg":
      return rest.length === 4 ? { type: "message", provider: a, account: b, chat: c, message: d } : null
    case "chat":
      return rest.length === 3 ? { type: "chat", provider: a, account: b, chat: c } : null
    case "task":
      return rest.length === 1 ? { type: "task", id: a } : null
    case "tasks":
      if (rest.length === 1 && (TASK_FILTERS as readonly string[]).includes(a))
        return { type: "tasks", filter: a as (typeof TASK_FILTERS)[number] }
      return rest.length === 2 && a === "new" && (isMoment(b, DATE) || isMoment(b, DATE_TIME))
        ? { type: "tasks", filter: "new", since: b }
        : null
    case "proposal":
      return rest.length === 1 ? { type: "proposal", id: a } : null
    case "digest":
      return rest.length === 1 && isMoment(a, DATE) ? { type: "digest", date: a } : null
    case "sync":
      return rest.length === 1 || rest.length === 2
        ? { type: "sync", tool: a, ...(rest.length === 2 ? { account: b } : {}) }
        : null
    default:
      return null
  }
}

/** A path after the version, or `null`: an empty part or one that does not decode is not a WireCat link. */
const targetOfPath = (path: string): LinkTarget | null => {
  const raw = path.split("/")
  if (raw.some((part) => part === "")) return null
  try {
    return targetOfParts(raw.map(decodeURIComponent))
  } catch {
    return null
  }
}

/** `/v1/msg/max/1001/-2002/3003`, the part both forms share. */
export const formatLink = (target: LinkTarget): string => `/${LINK_VERSION}/${pathOf(target)}`

/**
 * The target of a link in either form (`https://…#/v1/…`, `wirecat://open/v1/…`) or of its bare path (`/v1/…`), or
 * `null` for anything else: another version, an unknown kind, a part too many or empty, a path over 512 characters.
 */
export const parseLink = (text: string): LinkTarget | null => {
  const link = text.trim()
  const path = link.startsWith(`${APP_PREFIX}/`)
    ? link.slice(APP_PREFIX.length)
    : link.startsWith("https://") && link.includes("#")
      ? link.slice(link.indexOf("#") + 1)
      : link
  if (path.length > MAX_PATH || !path.startsWith(`/${LINK_VERSION}/`)) return null
  // A later version may add extras as a query; a v1 reader ignores them rather than refusing the link.
  const rest = (path.split("?")[0] as string).slice(LINK_VERSION.length + 2)
  if (rest.split("/").length + 1 > MAX_SEGMENTS) return null
  return targetOfPath(rest)
}

const LINK_ONLY = new Set(["tasks", "proposal", "digest", "sync"])
const FROM_REFERENCE = new Set(["message", "chat", "task"])

/**
 * The target a ref names, or `null` when it names nothing a link opens. A store reference (`msg:`, `chat:`, `task:`)
 * is read by its own grammar; the kinds that are no reference are written as their path with a colon after the
 * kind: `proposal:fact%3A512`, `tasks:overdue`, `tasks:new/2026-11-07T08%3A00%3A00Z`, `digest:2026-11-08`,
 * `sync:telegram/1001`.
 */
export const linkTargetOf = (ref: string): LinkTarget | null => {
  const text = ref.trim()
  const colon = text.indexOf(":")
  if (colon < 0) return null
  const kind = text.slice(0, colon)
  if (LINK_ONLY.has(kind)) return targetOfPath(`${kind}/${text.slice(colon + 1)}`)
  try {
    const reference = parseReference(text)
    return FROM_REFERENCE.has(reference.type) ? (reference as LinkTarget) : null
  } catch {
    return null
  }
}

/** The `links` section of the shared config, with the default for what is missing or not a usable value. */
export const linkConfigOf = (section: unknown): LinkConfig => {
  const value = section && typeof section === "object" ? (section as Record<string, unknown>) : {}
  const base =
    typeof value.base === "string" && /^https:\/\/[^\s#?]+$/.test(value.base)
      ? value.base.replace(/\/+$/, "")
      : DEFAULT_LINK_CONFIG.base
  return { base, enabled: typeof value.enabled === "boolean" ? value.enabled : DEFAULT_LINK_CONFIG.enabled }
}

/**
 * The one way to build a WireCat link: the web form for messages and mail (an https page that hands it to the app),
 * the app form for a desktop terminal. `null` when links are off (`links.enabled: false`, or `WIRECAT_LINKS=off` for
 * one run) or the ref names nothing a link opens; the caller then leaves the link out.
 */
export const linkFor = (
  ref: LinkTarget | string,
  {
    form,
    config = DEFAULT_LINK_CONFIG,
    env = process.env,
  }: { form: LinkForm; config?: LinkConfig; env?: NodeJS.ProcessEnv },
): string | null => {
  if (!config.enabled || env.WIRECAT_LINKS === "off") return null
  const target = typeof ref === "string" ? linkTargetOf(ref) : ref
  if (target === null) return null
  const path = formatLink(target)
  if (path.length > MAX_PATH || parseLink(path) === null) return null
  return form === "app" ? `${APP_PREFIX}${path}` : `${config.base}#${path}`
}
