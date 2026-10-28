import { PRESET_NAMES, type PresetName, presetMatches } from "./presets.js"
import { type DomainAge, registrableOf, type Signal, scoreGroup } from "./score.js"
import type { Listed } from "./source.js"

export const SUGGEST_RULE =
  "suggest is skip when a group has at least 20 emails, at least 80% of them list or bulk mail " +
  "(List-Id, List-Unsubscribe or Precedence: bulk) and the owner never sent mail to its sender"

export interface ProbeGroup {
  /** The sender; for a list, the first sender seen. */
  from: string | null
  listId: string | null
  emails: number
  bytes: number
  /** Share of emails not read; null when the source does not say. */
  unread: number | null
  /** Share of emails marked as list or bulk mail. */
  bulk: number
  firstYear: number
  lastYear: number
  /** The owner sent mail to one of the group's senders. */
  replied: boolean
  suggest: "skip" | null
  /** How much the group looks like spam, a scam or a robot: the sum of its signals' weights (SCORE_RULE). */
  score: number
  signals: Signal[]
}

export interface Probe {
  emails: number
  bytes: number
  /** Mail the owner sent: not grouped, but its recipients tell who was replied to. */
  sent: number
  /** Emails whose headers could not be read: not grouped. */
  withoutHeaders: number
  groups: number
  items: ProbeGroup[]
  /** How much mail each built-in preset would match: proposals the owner may turn into rules. */
  presets: { preset: PresetName; emails: number; groups: number; bytes: number }[]
}

const share = (part: number, whole: number) => Math.round((part / whole) * 100) / 100

const isSent = (item: Listed) => item.labels?.includes("Sent") || /(^|\/)sent\b/i.test(item.folder ?? "")

/** A list's mail is one group whoever sends it; other mail is grouped by sender. */
export const groupKey = (headers: { from?: string; listId?: string }): string =>
  headers.listId === undefined ? `from:${headers.from}` : `list:${headers.listId}`

/** Groups mail by List-Id when it has one, else by sender address; largest groups first. */
export const probeMail = (items: Listed[], limit: number, ages: ReadonlyMap<string, DomainAge> = new Map()): Probe => {
  const sent = items.filter(isSent)
  const recipients = new Set(sent.flatMap((item) => item.headers?.to ?? []))
  const groups = new Map<string, Listed[]>()
  let withoutHeaders = 0
  for (const item of items) {
    if (isSent(item)) continue
    const headers = item.headers
    if (headers === undefined || (headers.from === undefined && headers.listId === undefined)) {
      withoutHeaders++
      continue
    }
    const key = groupKey(headers)
    const group = groups.get(key)
    if (group) group.push(item)
    else groups.set(key, [item])
  }
  const all = [...groups.values()].map((group): ProbeGroup => {
    const senders = new Set(group.flatMap((item) => (item.headers?.from === undefined ? [] : [item.headers.from])))
    const known = group.filter((item) => item.seen !== undefined)
    const years = group.map((item) => new Date(item.receivedAt).getUTCFullYear())
    const bulk = share(group.filter((item) => item.headers?.bulk).length, group.length)
    const replied = [...senders].some((sender) => recipients.has(sender))
    return {
      from: [...senders][0] ?? null,
      listId: group[0]?.headers?.listId ?? null,
      emails: group.length,
      bytes: group.reduce((sum, item) => sum + (item.size ?? 0), 0),
      unread: known.length ? share(known.filter((item) => !item.seen).length, known.length) : null,
      bulk,
      firstYear: years.reduce((a, b) => Math.min(a, b)),
      lastYear: years.reduce((a, b) => Math.max(a, b)),
      replied,
      suggest: group.length >= 20 && bulk >= 0.8 && !replied ? "skip" : null,
      ...scoreGroup(group, { replied, bulk, ages }),
    }
  })
  const presets = PRESET_NAMES.map((preset) => {
    const hit = [...groups.values()].filter((group) => {
      const replied = group.some((item) => item.headers?.from !== undefined && recipients.has(item.headers.from))
      return presetMatches(preset, { ...(group[0] as Listed), replied })
    })
    return {
      preset,
      emails: hit.reduce((sum, group) => sum + group.length, 0),
      groups: hit.length,
      bytes: hit.reduce((sum, group) => sum + group.reduce((total, item) => total + (item.size ?? 0), 0), 0),
    }
  }).filter(({ emails }) => emails > 0)
  all.sort((a, b) => b.emails - a.emails || b.bytes - a.bytes)
  return {
    emails: items.length,
    bytes: items.reduce((sum, item) => sum + (item.size ?? 0), 0),
    sent: sent.length,
    withoutHeaders,
    groups: all.length,
    items: all.slice(0, limit),
    presets,
  }
}

/** The sender domains of the groups worth asking a registry about: not a big mailbox provider, never replied to. */
export const domainsToAge = (groups: ProbeGroup[], skip: ReadonlySet<string>): string[] => [
  ...new Set(
    groups.flatMap((group) => {
      if (group.replied || group.from === null) return []
      const domain = registrableOf(group.from)
      return skip.has(domain) ? [] : [domain]
    }),
  ),
]
