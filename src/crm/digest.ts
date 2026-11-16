import { zonedMoment } from "@wirecat/cli-base/query"
import { REPORT_FORMAT } from "../background/report/schema.js"
import { SECTION_CAPS } from "../background/report/view.js"
import { dayIn } from "../domain/moment.js"
import { taskAccount } from "../services/task-rules.js"
import type { CrmChange, CrmChangeKind } from "../store/sqlite/crm-changes.js"
import type { MessageStore } from "../store/store.js"
import type { AccountKey } from "../store/types.js"
import { crmStatus } from "./sync.js"

const HOUR = 3_600_000
const STALE_HOURS = 24
/** More than a section shows, so its `more` counts what was left out. */
const READ = 200

const WORDS = {
  en: { won: "won", lost: "lost", newDeal: "new", newOwner: "new owner", contacts: "new contacts" },
  ru: {
    won: "выиграна",
    lost: "проиграна",
    newDeal: "новая",
    newOwner: "новый ответственный",
    contacts: "новые контакты",
  },
} as const

export interface CrmDigestOptions {
  since: number
  until: number
  now: number
  /** The owner's zone: the end of today, and the days a won or lost deal is counted on. */
  zone: string
  /** The owner's language, `ru` or `en`, for the few words the digest writes itself. */
  language: string
  /** The profile's name, for the sync's age. */
  profile: string
}

type Item = Record<string, unknown> & { type: string; refs: string[] }

const iso = (at: number | null) => (at === null ? null : new Date(at).toISOString())
/** The last moment of `now`'s day in `zone`. */
const endOfDay = (now: number, zone: string) => {
  const day = dayIn(now, zone)
  return zonedMoment(day, zone, { start: 0, end: day.length }, { end: true })
}

/**
 * A CRM account's morning digest as a `wirecat.report/1` document: one `crm` section, overdue CRM tasks first, then
 * those due today, deals won and lost, stage moves, new deals and owner changes, new contacts as one count, and the
 * tasks the stage rules opened, capped with `more`. `health` names a sync older than a day.
 */
export const crmDigest = async (
  store: MessageStore,
  account: AccountKey,
  options: CrmDigestOptions,
): Promise<Record<string, unknown>> => {
  const { since, until, now, zone } = options
  const words = options.language === "ru" ? WORDS.ru : WORDS.en
  const tasksOf = async (filter: { overdueAt?: number; due?: { since: number; until: number } }) =>
    (await store.crm.activitiesOn(account))
      ? (await store.crm.activities(account, { status: "open", ...filter, limit: READ, offset: 0 })).items
      : []
  const overdue = await tasksOf({ overdueAt: now })
  const today = await tasksOf({ due: { since: now, until: endOfDay(now, zone) } })
  const task =
    (high: boolean) =>
    (one: Awaited<ReturnType<typeof tasksOf>>[number]): Item => {
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
  const changes = (
    await store.crm.changes(account, {
      since,
      until,
      zone,
      changes: ["won", "lost", "moved", "created", "owner_changed", "person_added"],
      limit: READ,
      offset: 0,
    })
  ).items
  const of = (kind: CrmChangeKind) => changes.filter(({ change }) => change === kind)
  const fact = (change: CrmChange, detail: string): Item => ({
    type: "fact",
    topic: change.title ?? change.externalId,
    detail,
    time: iso(change.at),
    channel: "crm",
    refs: change.ref ? [change.ref] : [],
  })
  const won = of("won").map(
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
  const people = of("person_added").length
  const opened = await store.tasks.find({
    where: {
      sql:
        "t.source = 'rule' AND t.source_kind IN ('deal', 'lead') AND t.created_at >= ? " +
        "AND t.project_id IN (SELECT id FROM projects WHERE name = ?)",
      params: [since, taskAccount(account)],
    },
  })
  const items: Item[] = [
    ...overdue.map(task(true)),
    ...today.map(task(false)),
    ...won,
    ...of("lost").map((change) => fact(change, change.reason ? `${words.lost}: ${change.reason}` : words.lost)),
    ...of("moved").map((change) => fact(change, `${change.from ?? "?"} → ${change.to ?? "?"}`)),
    ...of("created").map((change) => fact(change, words.newDeal)),
    ...of("owner_changed").map((change) => fact(change, words.newOwner)),
    ...(people ? [{ type: "fact", topic: words.contacts, detail: String(people), count: people, refs: [] }] : []),
    ...opened.items.map(
      (one): Item => ({
        type: "task",
        topic: one.title,
        due: one.dueAt ?? null,
        channel: "crm",
        refs: [one.ref],
      }),
    ),
  ]
  const cap = SECTION_CAPS.crm
  const status = await crmStatus(store, account, { profile: options.profile, now })
  const synced = status.items.reduce((most, one) => Math.max(most, one.updated_at ? Date.parse(one.updated_at) : 0), 0)
  const stale = (now - synced) / HOUR
  return {
    format: REPORT_FORMAT,
    kind: "morning-digest",
    date: dayIn(now, zone),
    summary: null,
    sections: items.length ? [{ kind: "crm", items: items.slice(0, cap), more: Math.max(0, items.length - cap) }] : [],
    // A copy never synced has no age to name; its empty section says enough.
    health:
      synced > 0 && stale > STALE_HOURS
        ? [{ source: account.provider, account: account.account, stale_hours: Math.floor(stale), refs: [] }]
        : [],
    scope: {
      from: new Date(since).toISOString(),
      to: new Date(until).toISOString(),
      sources: [{ kind: "crm", accounts: 1 }],
      counts: { chats: 0, mail: 0, tasks: opened.items.length, meetings: 0 },
    },
  }
}
