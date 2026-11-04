import { calendarKey, weekKey } from "../domain/calendar.js"
import type { Saved } from "../services/message-resolution.js"
import { prepareLucene } from "../services/messages-search.js"
import type { AccountKey, MessageStore } from "../store/store.js"

export const MAIL_STATS_BY = ["day", "week", "sender"] as const
export type MailStatsBy = (typeof MAIL_STATS_BY)[number]

export interface MailStatsRequest {
  by: MailStatsBy
  /** The query of `search mail`; every stored email when unset. */
  text?: string
  /** Only these mailboxes; every stored one when neither this nor `mailAccount` is given. */
  accounts?: AccountKey[]
  /** Only this mailbox, by its address. */
  mailAccount?: string
  exact?: boolean
  /** Where calendar days and weeks start; the system timezone when unset, as for search. */
  timezone?: string
  /** Rows kept: the busiest senders, or the latest days and weeks, oldest first. */
  limit: number
}

export interface MailStatsRow {
  /** `YYYY-MM-DD` (a week by its Monday), or the sender's address. */
  key: string
  name: string | null
  received: number
  sent: number
}

export interface MailStats {
  by: MailStatsBy
  received: number
  sent: number
  rows: MailStatsRow[]
  hasMore: boolean
  timezone: string
}

/**
 * Stored mail the `search mail` query matches, received and sent, per calendar day, week or sender; counts only.
 * `--by sender` counts received mail: the sender of sent mail is the owner. Reads the store, records no search.
 */
export const mailStats = async (
  store: MessageStore,
  runAs: AccountKey,
  { by, text, accounts, mailAccount, exact, timezone, limit }: MailStatsRequest,
  saved: Saved = {},
): Promise<MailStats> => {
  const prepared = await prepareLucene(
    store,
    runAs,
    {
      kind: "mail",
      limit: 1,
      ...(text?.trim() ? { text } : {}),
      ...(accounts === undefined ? {} : { accounts }),
      ...(mailAccount === undefined ? {} : { mailAccount }),
      ...(exact ? { exact: true } : {}),
      ...(timezone === undefined ? {} : { timezone }),
    },
    saved,
  )
  const mailboxes = prepared.scopeAccounts.filter(({ provider }) => provider === "email")
  const groups = mailboxes.length
    ? await store.queries.countQuery(
        { ...prepared.execution, accounts: mailboxes, corpus: "mail" },
        by === "sender" ? "sender_direction" : "time_direction",
      )
    : []
  const received = groups.filter(({ outgoing }) => !outgoing).reduce((sum, { count }) => sum + count, 0)
  const sent = groups.filter(({ outgoing }) => outgoing).reduce((sum, { count }) => sum + count, 0)
  let rows: MailStatsRow[]
  if (by === "sender")
    rows = groups
      .filter(({ outgoing }) => !outgoing)
      .map(({ id, name, count }) => ({ key: id ?? "unknown", name, received: count, sent: 0 }))
      .sort((a, b) => b.received - a.received || a.key.localeCompare(b.key))
  else {
    const day = calendarKey(prepared.timezone, "day")
    const keyOf = by === "week" ? (at: number) => weekKey(day(at)) : day
    const totals = new Map<string, MailStatsRow>()
    for (const { id, outgoing, count } of groups) {
      const key = keyOf(Number(id))
      const row = totals.get(key) ?? { key, name: null, received: 0, sent: 0 }
      if (outgoing) row.sent += count
      else row.received += count
      totals.set(key, row)
    }
    rows = [...totals.values()].sort((a, b) => a.key.localeCompare(b.key))
  }
  return {
    by,
    received,
    sent,
    rows: by === "sender" ? rows.slice(0, limit) : rows.slice(-limit),
    hasMore: rows.length > limit,
    timezone: prepared.timezone,
  }
}

/** The `mail_counts` entity: what a command answers as its `item`. */
export const mailStatsItem = ({ by, received, sent, rows }: MailStats) => ({
  by,
  received,
  sent,
  rows: rows.map(({ key, name, received, sent }) => ({ key, name, received, sent })),
})
