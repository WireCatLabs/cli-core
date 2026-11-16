import { zonedMoment } from "@wirecat/cli-base/query"
import { REPORT_FORMAT } from "../background/report/schema.js"
import { SECTION_CAPS } from "../background/report/view.js"
import { dayIn } from "../domain/moment.js"
import { taskAccount } from "../services/task-rules.js"
import { type CopyViewer, viewerSql } from "../store/sqlite/copy-viewer.js"
import type { ListedActivity } from "../store/sqlite/crm-activities.js"
import type { CrmChange, CrmChangeKind } from "../store/sqlite/crm-changes.js"
import type { MessageStore } from "../store/store.js"
import type { AccountKey } from "../store/types.js"
import { crmStatus, SYNC_FAILED } from "./sync.js"

const HOUR = 3_600_000
const STALE_HOURS = 24

const WORDS = {
  en: {
    won: "won",
    lost: "lost",
    newDeal: "new",
    newOwner: "new owner",
    contacts: "new contacts",
    hidden: "Part of the CRM copy is hidden from this profile: see the command's note",
  },
  ru: {
    won: "выиграна",
    lost: "проиграна",
    newDeal: "новая",
    newOwner: "новый ответственный",
    contacts: "новые контакты",
    hidden: "Часть копии CRM скрыта от этого профиля: см. примечание команды",
  },
} as const

export interface CrmDigestOptions {
  /** The window, both ends inclusive, epoch ms. */
  since: number
  until: number
  now: number
  /** The owner's zone: the end of today. */
  zone: string
  /** The owner's language, `ru` or `en`, for the few words the digest writes itself. */
  language: string
  /** The profile's name, for the sync's age. */
  profile: string
  /** A profile that may read only part of the copy (SEC-197). */
  viewer?: CopyViewer
  /** The viewer's rule hid rows it should not have: the summary says so. */
  hidden?: boolean
}

type Item = Record<string, unknown> & { type: string; refs: string[] }

const iso = (at: number | null) => (at === null ? null : new Date(at).toISOString())
/** The last moment of `now`'s day in `zone`. */
const endOfDay = (now: number, zone: string) => {
  const day = dayIn(now, zone)
  return zonedMoment(day, zone, { start: 0, end: day.length }, { end: true })
}

/**
 * A CRM account's morning digest as a `wirecat.report/1` document: one `crm` section. Deals won and lost come first
 * and are never pushed out; then overdue CRM tasks, those due today, stage moves, new deals, owner changes, new
 * contacts as one count, and the tasks the stage rules opened. Each kind is read with its own small limit and counted
 * in SQL, so `more` counts every row left out. Only an activity's subject is shown, never its text. `health` names a
 * last sync that failed or one older than a day.
 */
export const crmDigest = async (
  store: MessageStore,
  account: AccountKey,
  options: CrmDigestOptions,
): Promise<Record<string, unknown>> => {
  const { since, until, now, zone, viewer } = options
  const words = options.language === "ru" ? WORDS.ru : WORDS.en
  const cap = SECTION_CAPS.crm
  const window = { since, until, ...(viewer ? { viewer } : {}) }
  const counts = await store.crm.changeCounts(account, window)
  const changesOf = async (kind: CrmChangeKind) =>
    counts[kind] ? (await store.crm.changes(account, { ...window, changes: [kind], limit: cap, offset: 0 })).items : []
  const activitiesOn = await store.crm.activitiesOn(account)
  const tasks = async (filter: { overdueAt?: number; due?: { since: number; until: number } }) => {
    if (!activitiesOn) return { items: [] as ListedActivity[], count: 0 }
    const wanted = { status: "open" as const, ...filter, ...(viewer ? { viewer } : {}) }
    return {
      items: (await store.crm.activities(account, { ...wanted, limit: cap, offset: 0 })).items,
      count: await store.crm.activityCount(account, wanted),
    }
  }
  const overdue = await tasks({ overdueAt: now })
  const today = await tasks({ due: { since: now, until: endOfDay(now, zone) } })
  const task =
    (high: boolean) =>
    (one: ListedActivity): Item => {
      const on = one.on.find((target) => target.ref !== null)
      return {
        type: "task",
        topic: one.subject || one.kind,
        who: on?.title ?? null,
        due: iso(one.dueAt),
        priority: high ? "high" : "normal",
        channel: "crm",
        refs: on?.ref ? [on.ref] : [],
      }
    }
  const fact = (change: CrmChange, detail: string): Item => ({
    type: "fact",
    topic: change.title ?? change.externalId,
    detail,
    time: iso(change.at),
    channel: "crm",
    refs: change.ref ? [change.ref] : [],
  })
  const won = (await changesOf("won")).map(
    (change): Item =>
      change.amount !== null && change.currency !== null
        ? {
            type: "money",
            who: change.title ?? change.externalId,
            topic: words.won,
            amount: { value: Number(change.amount), currency: change.currency, direction: "in" },
            channel: "crm",
            refs: change.ref ? [change.ref] : [],
          }
        : fact(change, words.won),
  )
  const lost = (await changesOf("lost")).map((change) =>
    fact(change, change.reason ? `${words.lost}: ${change.reason}` : words.lost),
  )
  const people = counts.person_added
  const seen = viewerSql("d", viewer)
  const opened = await store.tasks.find({
    where: {
      sql:
        "t.source = 'rule' AND t.source_kind IN ('deal', 'lead') AND t.created_at BETWEEN ? AND ? " +
        "AND t.project_id IN (SELECT id FROM projects WHERE name = ?) " +
        // A rule task names its deal or lead: a viewer reads it only on one of its own.
        `AND (EXISTS (SELECT 1 FROM deals d WHERE 'deal:' || d.id = t.source_group AND ${seen.sql}) ` +
        `OR EXISTS (SELECT 1 FROM leads d WHERE 'lead:' || d.id = t.source_group AND ${seen.sql}))`,
      params: [since, until, taskAccount(account), ...seen.params, ...seen.params],
    },
    limit: cap,
  })
  const rest: Item[] = [
    ...overdue.items.map(task(true)),
    ...today.items.map(task(false)),
    ...(await changesOf("moved")).map((change) => fact(change, `${change.from ?? "?"} → ${change.to ?? "?"}`)),
    ...(await changesOf("created")).map((change) => fact(change, words.newDeal)),
    ...(await changesOf("owner_changed")).map((change) => fact(change, words.newOwner)),
    ...(people ? [{ type: "fact", topic: words.contacts, detail: String(people), count: people, refs: [] }] : []),
    ...opened.items.map(
      (one): Item => ({ type: "task", topic: one.title, due: one.dueAt ?? null, channel: "crm", refs: [one.ref] }),
    ),
  ]
  const closed = [...won, ...lost]
  const shown = [...closed.slice(0, cap), ...rest.slice(0, Math.max(0, cap - closed.length))]
  const total =
    counts.won +
    counts.lost +
    overdue.count +
    today.count +
    counts.moved +
    counts.created +
    counts.owner_changed +
    (people ? 1 : 0) +
    opened.items.length +
    (opened.hasMore ? 1 : 0)
  return {
    format: REPORT_FORMAT,
    kind: "morning-digest",
    date: dayIn(now, zone),
    summary: options.hidden ? words.hidden : null,
    sections: shown.length ? [{ kind: "crm", items: shown.map(masked), more: Math.max(0, total - shown.length) }] : [],
    health: await healthOf(store, account, options),
    scope: {
      from: new Date(since).toISOString(),
      to: new Date(until).toISOString(),
      sources: [{ kind: "crm", accounts: 1 }],
      counts: { chats: 0, mail: 0, tasks: opened.items.length, meetings: 0 },
    },
  }
}

const EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/gu
/** Nine digits or more, or a `+` and seven: a phone, never a date or an amount. */
const PHONE = /\+?\d[\d\s().-]{5,}\d/g
const maskText = (text: string) =>
  text.replace(EMAIL, "[e-mail]").replace(PHONE, (found) => {
    const digits = found.replace(/\D/g, "").length
    return digits >= 9 || (found.startsWith("+") && digits >= 7) ? "[phone]" : found
  })

/** A digest goes to messengers: no CRM text in it carries a phone number or an e-mail address. */
const masked = (item: Item): Item =>
  Object.fromEntries(
    Object.entries(item).map(([key, value]) => [
      key,
      typeof value === "string" && key !== "due" && key !== "time" ? maskText(value) : value,
    ]),
  ) as Item

/** A last sync that failed, else a copy whose oldest kind is more than a day old; a copy never synced is neither. */
const healthOf = async (store: MessageStore, account: AccountKey, { now, profile }: CrmDigestOptions) => {
  const named = { source: account.provider, account: account.account, refs: [] }
  const failed = (await store.sync.syncState(account, SYNC_FAILED))?.value
  if (failed) {
    const at = Number((JSON.parse(failed) as { at?: unknown }).at)
    return [{ ...named, reason: "sync-failed", ...(Number.isFinite(at) ? { since: iso(at) } : {}), stale_hours: 0 }]
  }
  const status = await crmStatus(store, account, { profile, now })
  const synced = status.items.map((one) => (one.updated_at ? Date.parse(one.updated_at) : 0)).filter((at) => at > 0)
  if (!synced.length) return []
  const stale = (now - synced.reduce((oldest, at) => Math.min(oldest, at), now)) / HOUR
  return stale > STALE_HOURS ? [{ ...named, stale_hours: Math.floor(stale) }] : []
}
