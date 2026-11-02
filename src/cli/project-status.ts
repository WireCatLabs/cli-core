import type { Missing, NextStep } from "@wirecat/cli-base/standards"
import * as v from "valibot"
import type { ProjectStatus, StatusChatSummary, StatusItem } from "../services/project-status/index.js"
import type { RowShape } from "./compact.js"
import { snakeKeys } from "./envelope.js"
import { heldPhrase } from "./messenger/search-answers.js"
import { STATUS_SIGNAL_ROWS } from "./project-status-rows.js"

export interface ProjectStatusHints {
  /** The step that syncs a chat held in part back to `since` (`YYYY-MM-DD`); null when no command here can. */
  sync: (chat: StatusChatSummary, since: string) => NextStep | null
  /** The step that reads a chat's stored messages from `since`; null when no command here can. */
  read: (chat: StatusChatSummary, since: string) => NextStep | null
  /** The command line a step runs, for the text form. */
  line: (step: NextStep) => string
}

const day = (at: string | number) => new Date(at).toISOString().slice(0, 10)
const listKey = (signal: string) => signal.replaceAll("-", "_")

const SECTIONS = {
  signals: "status.signal",
  money: "status.money",
  chats: "status.chat",
  out_of_scope: "status.out-of-scope",
  failed: "status.failed",
}

/** The `project_status` answer drawn by `--compact`: each signal's list with that signal's row. */
export const projectStatusRow = (signals: readonly { id: string }[]): RowShape => ({
  columns: [],
  sections: {
    ...SECTIONS,
    ...Object.fromEntries(signals.map(({ id }) => [listKey(id), `status.${id}`])),
  },
})

const statusItem = v.looseObject({
  signal: v.string(),
  ref: v.nullable(v.string()),
  chat: v.nullable(v.string()),
  chat_title: v.nullable(v.string()),
  at: v.nullable(v.string()),
  who: v.nullable(v.strictObject({ ref: v.nullable(v.string()), name: v.nullable(v.string()), owner: v.boolean() })),
  evidence: v.array(v.strictObject({ ref: v.string(), fingerprint: v.nullable(v.string()) })),
  basis: v.picklist(["store", "fact", "task", "pattern"]),
  data: v.record(v.string(), v.unknown()),
})

/** Where a project stands: per chat signals, open money, and what was left out. Empty lists are left out. */
export const projectStatusSchema = v.looseObject({
  project: v.string(),
  key: v.nullable(v.string()),
  name: v.string(),
  window: v.strictObject({ since: v.string(), until: v.string() }),
  signals: v.array(v.strictObject({ id: v.string(), version: v.number() })),
  money: v.array(
    v.strictObject({ direction: v.string(), currency: v.nullable(v.string()), amount: v.string(), rows: v.number() }),
  ),
  chats: v.array(
    v.strictObject({
      chat: v.string(),
      title: v.nullable(v.string()),
      kind: v.string(),
      role: v.nullable(v.string()),
      purpose: v.string(),
      project: v.string(),
      coverage: v.string(),
      attention: v.number(),
      why: v.nullable(v.string()),
    }),
  ),
  out_of_scope: v.optional(
    v.array(v.strictObject({ chat: v.string(), reason: v.string(), purpose: v.optional(v.string()) })),
  ),
  failed: v.optional(v.array(v.strictObject({ signal: v.string(), why: v.string() }))),
  ...Object.fromEntries(
    Object.keys(STATUS_SIGNAL_ROWS).map((name) => [listKey(name.slice(7)), v.optional(v.array(statusItem))]),
  ),
})

export type ProjectStatusItem = v.InferOutput<typeof projectStatusSchema>

const coverageOf = (found: ProjectStatus, chat: string) =>
  found.items.find((one) => one.signal === "coverage" && one.chat === chat)?.data as
    | { state: string; beforeHeld: boolean }
    | undefined

const partial = (found: ProjectStatus, chat: StatusChatSummary) => {
  const held = coverageOf(found, chat.ref)
  return held ? held.state !== "complete" && held.beforeHeld : chat.coverage.completeness.state !== "complete"
}

const readFrom = (found: ProjectStatus, chat: string): string => {
  const reply = found.items.find((one) => one.signal === "reply-next" && one.chat === chat)?.data as
    | { waitingSince: string | null }
    | undefined
  const money = found.items
    .filter((one) => one.signal === "amounts" && one.chat === chat && (one.data as { state: string }).state === "open")
    .map((one) => (one.data as { since: string }).since)
    .sort()[0]
  return day([money, reply?.waitingSince, found.window.since].find((one) => typeof one === "string") as string)
}

/** At most two: the chats `attention` weighs highest, a chat held in part synced first. */
const nextOf = (found: ProjectStatus, hints: ProjectStatusHints): NextStep[] => {
  const byRef = new Map(found.chats.map((chat) => [chat.ref, chat]))
  const top = found.attention.slice(0, 2).flatMap((one) => {
    const chat = byRef.get(one.chat)
    return chat ? [{ chat, why: one.why }] : []
  })
  const because = (step: NextStep | null, why: string): NextStep[] => (step ? [{ ...step, why }] : [])
  const syncs = top.flatMap(({ chat, why }) =>
    partial(found, chat) ? because(hints.sync(chat, day(found.window.since)), why) : [],
  )
  const reads = top.flatMap(({ chat, why }) =>
    partial(found, chat) ? [] : because(hints.read(chat, readFrom(found, chat.ref)), why),
  )
  return [...syncs, ...reads].slice(0, 2)
}

const missingOf = (found: ProjectStatus): Missing[] => {
  const held = found.chats.filter((chat) => partial(found, chat))
  const [first] = held
  return [
    ...(first
      ? [
          {
            field: "history",
            why:
              `${held.length} of ${found.chats.length} chats hold only part of the window; ` +
              `the first is ${heldPhrase(first.coverage)}`,
            step: "messages.sync",
          },
        ]
      : []),
    ...(found.outOfScope.length
      ? [
          {
            field: "chats",
            why: `${found.outOfScope.length} linked chats were not read here (${[
              ...new Set(found.outOfScope.map((one) => one.reason)),
            ].join(", ")}); memo projects status reads every account`,
          },
        ]
      : []),
    ...found.failed.map((one) => ({ field: `signal:${one.signal}`, why: one.why })),
  ]
}

const withPlace = (found: ProjectStatus, hints: ProjectStatusHints) => {
  const titles = new Map(found.chats.map((chat) => [chat.ref, chat.title]))
  const sync = (one: StatusItem) => {
    const chat = found.chats.find((each) => each.ref === one.chat)
    const step = chat && partial(found, chat) ? hints.sync(chat, day(found.window.since)) : null
    return step ? hints.line(step) : null
  }
  return (one: StatusItem) => ({
    ...one,
    ref: one.evidence[0]?.ref ?? one.chat,
    chatTitle: one.chat === null ? null : (titles.get(one.chat) ?? null),
    ...(one.signal === "coverage" ? { syncCommand: sync(one) } : {}),
  })
}

/** The answer of `projects status`: the item, two steps at most, what is missing, and the window. */
export const projectStatusAnswer = (found: ProjectStatus, hints: ProjectStatusHints) => {
  const weights = new Map(found.attention.map((one) => [one.chat, one]))
  const place = withPlace(found, hints)
  const lists = Object.fromEntries(
    found.signals.flatMap(({ id }) => {
      const items = found.items.filter((one) => one.signal === id).map(place)
      return items.length ? [[listKey(id), items]] : []
    }),
  )
  const item = snakeKeys({
    project: found.project.ref,
    key: found.project.key,
    name: found.project.name,
    window: found.window,
    signals: found.signals,
    money: found.money.open,
    chats: found.chats.map((chat) => ({
      chat: chat.ref,
      title: chat.title,
      kind: chat.kind,
      role: chat.role,
      purpose: chat.purpose,
      project: chat.project,
      coverage: chat.coverage.completeness.state,
      attention: weights.get(chat.ref)?.weight ?? 0,
      why: weights.get(chat.ref)?.why ?? null,
    })),
    ...(found.outOfScope.length ? { outOfScope: found.outOfScope } : {}),
    ...(found.failed.length ? { failed: found.failed } : {}),
    ...lists,
  }) as ProjectStatusItem
  const missing = missingOf(found)
  const complete = found.failed.length === 0 && !found.chats.some((chat) => partial(found, chat))
  return {
    item,
    next: nextOf(found, hints),
    missing,
    meta: { window: found.window, complete, ...(found.accounts.length ? { accounts: found.accounts } : {}) },
  }
}

const NEXT_WORDS: Record<string, string> = { owner: "YOU", them: "them", nobody: "nobody" }

const chatLine = (found: ProjectStatus, chat: StatusChatSummary): string[] => {
  const of = (signal: string) => found.items.filter((one) => one.signal === signal && one.chat === chat.ref)
  const [last] = of("last-message")
  const reply = of("reply-next")[0]?.data as
    | { next: string; waitingSince: string | null; addressed: { name: string | null } | null }
    | undefined
  const head = [
    `${chat.title ?? chat.ref} (${[chat.role ?? "no role", chat.kind].join(", ")})`,
    last
      ? `last ${day(last.at as string)} ${last.who?.owner ? "you" : (last.who?.name ?? "them")}`
      : "nothing in the window",
    ...(reply
      ? [
          `next: ${reply.next === "named" ? `${reply.addressed?.name ?? "someone"} (named)` : NEXT_WORDS[reply.next]}` +
            (reply.waitingSince ? ` since ${day(reply.waitingSince)}` : ""),
        ]
      : []),
    ...(partial(found, chat) ? [heldPhrase(chat.coverage)] : []),
  ].join(" · ")
  const open: string[] = []
  const asked = of("questions").map((one) => one.data as { side: string })
  const yours = asked.filter((one) => one.side === "yours").length
  const theirs = asked.length - yours
  if (theirs) open.push(`${theirs} question${theirs === 1 ? "" : "s"} to you unanswered`)
  if (yours) open.push(`${yours} question${yours === 1 ? "" : "s"} of yours unanswered`)
  for (const topic of of("topics")) {
    const data = topic.data as { topic: string; silentSince: string | null }
    if (data.silentSince) open.push(`"${data.topic}" quiet on their side since ${day(data.silentSince)}`)
  }
  const promised = of("promises").length
  if (promised) open.push(`${promised} promise${promised === 1 ? "" : "s"}`)
  return [`  ${head}`, ...(open.length ? [`    open: ${open.join(" · ")}`] : [])]
}

const moneyLine = (one: StatusItem, titles: Map<string, string | null>) => {
  const data = one.data as {
    direction: string
    amount: string
    currency: string | null
    state: string
    since: string
    asks: number
    lastAsked: string | null
  }
  const asks = data.asks > 1 && data.lastAsked ? ` (asked ${data.asks}×, last ${day(data.lastAsked)})` : ""
  const where = one.chat === null ? "" : ` · ${titles.get(one.chat) ?? one.chat}`
  const words = data.direction.replace("_", " ")
  const sum = `${data.amount} ${data.currency ?? "?"} ${data.state} since ${day(data.since)}`
  return `  ${words.padEnd(7)} ${sum}${asks}${where} · ${one.evidence[0]?.ref ?? ""} [${one.basis}]`
}

/** The human form: header, money, a line per chat with what is open, then the steps. */
export const projectStatusText = (found: ProjectStatus, hints: ProjectStatusHints): string => {
  const titles = new Map(found.chats.map((chat) => [chat.ref, chat.title]))
  const { next } = projectStatusAnswer(found, hints)
  const money = found.items.filter(
    (one) => one.signal === "amounts" && (one.data as { state: string }).state !== "mentioned",
  )
  const payments = found.items.filter((one) => one.signal === "payments")
  const children = found.items.filter((one) => one.signal === "children")
  const key = found.project.key ? `${found.project.key} · ` : ""
  const lines = [
    `${key}${found.project.name} · ${found.chats.length} linked chats in ${found.accounts.length} accounts, ` +
      `${day(found.window.since)} to ${day(found.window.until)}`,
  ]
  if (money.length || payments.length) {
    lines.push("Money")
    for (const one of money) lines.push(moneyLine(one, titles))
    for (const one of payments) {
      const data = one.data as { statement: string; status: string }
      lines.push(`  payment ${data.statement} · ${one.evidence[0]?.ref ?? ""} [${data.status}]`)
    }
  }
  if (found.chats.length) lines.push("Chats")
  for (const chat of found.chats) for (const line of chatLine(found, chat)) lines.push(line)
  if (children.length) lines.push("Children")
  for (const one of children) {
    const data = one.data as { child: string; key: string | null; name: string | null; chats: number | null }
    const cut = (one.data as { cut: string | null }).cut
    lines.push(
      `  ${cut ? `${data.child} not read (${cut})` : `${data.key ?? data.child} · ${data.name} · ${data.chats} chats`}`,
    )
  }
  if (found.outOfScope.length)
    lines.push(`Not read here: ${found.outOfScope.map((one) => `${one.chat} (${one.reason})`).join(", ")}`)
  for (const one of found.failed) lines.push(`Signal ${one.signal} failed: ${one.why}`)
  if (next.length) lines.push("Next")
  next.forEach((step, index) => {
    lines.push(`  ${index + 1}. ${hints.line(step)}`)
  })
  return lines.join("\n")
}
