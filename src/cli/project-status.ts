import type { Missing, NextStep } from "@wirecat/cli-base/standards"
import * as v from "valibot"
import type { Id } from "../domain/models.js"
import type {
  OutOfScope,
  ProjectStatus,
  StatusChatSummary,
  StatusItem,
  StatusWho,
} from "../services/project-status/index.js"
import type { CoverageData } from "../services/project-status/signals/coverage.js"
import type { ReplyNextData } from "../services/project-status/signals/reply-next.js"
import type { AccountKey } from "../store/store.js"
import type { RowShape } from "./compact.js"
import { snakeKeys } from "./envelope.js"
import { heldPhrase } from "./messenger/search-answers.js"
import { ON_CHAT_ROW, STATUS_SIGNAL_ROWS } from "./project-status-rows.js"

export interface ProjectStatusHints {
  /** The step that syncs a chat held in part back to `since` (`YYYY-MM-DD`); null when no command here can. */
  sync: (chat: StatusChatSummary, since: string) => NextStep | null
  /** The step that reads a chat's stored messages from `since`; null when no command here can. */
  read: (chat: StatusChatSummary, since: string) => NextStep | null
  /** The command line a step runs, for the text form. */
  line: (step: NextStep) => string
  /** The step that reads a chat left out by its purpose from `since`; null when no command here can. */
  readChat?: (chat: { ref: string; account: AccountKey; chatId: Id }, since: string) => NextStep | null
}

const day = (at: string | number) => new Date(at).toISOString().slice(0, 10)
const listKey = (signal: string) => signal.replaceAll("-", "_")

const SECTIONS = {
  money: "status.money",
  chats: "status.chat",
  out_of_scope: "status.out-of-scope",
  failed: "status.failed",
}

/** The `project_status` answer drawn by `--compact`: a row per chat, then each listed signal with its own row. */
export const projectStatusRow = (signals: readonly { id: string }[]): RowShape => ({
  columns: [],
  hidden: ["project", "purposes", "signals"],
  sections: {
    ...SECTIONS,
    ...Object.fromEntries(signals.flatMap(({ id }) => (ON_CHAT_ROW.has(id) ? [] : [[listKey(id), `status.${id}`]]))),
  },
})

const who = v.strictObject({ ref: v.optional(v.string()), name: v.optional(v.string()), owner: v.boolean() })

const statusItem = v.looseObject({
  ref: v.nullable(v.string()),
  /** Left out when `ref` is a message of that chat. */
  chat: v.optional(v.nullable(v.string())),
  at: v.nullable(v.string()),
  who: v.optional(who),
  /** Every ref the item cites, when it cites more than `ref`. */
  evidence: v.optional(v.array(v.string())),
  /** Left out for `store`, what most items are read from. */
  basis: v.optional(v.picklist(["fact", "task", "pattern"])),
  data: v.record(v.string(), v.unknown()),
})

/** Where a project stands: per chat signals, open money, and what was left out. Empty lists are left out. */
export const projectStatusSchema = v.looseObject({
  project: v.string(),
  key: v.nullable(v.string()),
  name: v.string(),
  /** Each signal's version, so a saved answer says which rules made it. */
  signals: v.record(v.string(), v.number()),
  money: v.array(
    v.strictObject({ direction: v.string(), currency: v.nullable(v.string()), amount: v.string(), rows: v.number() }),
  ),
  chats: v.array(
    v.strictObject({
      chat: v.string(),
      title: v.nullable(v.string()),
      kind: v.string(),
      role: v.optional(v.string()),
      purpose: v.optional(v.string()),
      project: v.optional(v.string()),
      coverage: v.string(),
      attention: v.optional(v.number()),
      why: v.optional(v.string()),
      last: v.optional(v.strictObject({ ref: v.string(), at: v.string(), who })),
      next: v.optional(v.picklist(["owner", "them", "named", "nobody"])),
      waiting_since: v.optional(v.nullable(v.string())),
      addressed: v.optional(v.strictObject({ ref: v.nullable(v.string()), name: v.nullable(v.string()) })),
      overdue: v.optional(v.boolean()),
      held: v.optional(v.strictObject({ messages: v.number(), oldest_at: v.nullable(v.string()) })),
      sync_command: v.optional(v.nullable(v.string())),
      unlisted: v.optional(v.record(v.string(), v.number())),
    }),
  ),
  purposes: v.union([v.literal("all"), v.array(v.string())]),
  out_of_scope: v.optional(
    v.array(
      v.strictObject({
        chat: v.string(),
        reason: v.string(),
        purpose: v.optional(v.string()),
        messages: v.optional(v.number()),
        first_at: v.optional(v.nullable(v.string())),
        last_at: v.optional(v.nullable(v.string())),
        read_command: v.optional(v.nullable(v.string())),
      }),
    ),
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
    .filter((one) => one.signal === "amounts" && one.chat === chat && (one.data as { state: string }).state === "asked")
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

type LeftOut = Extract<OutOfScope, { reason: "purpose" }>

const leftOutOf = (found: ProjectStatus): LeftOut[] =>
  found.outOfScope.filter((one): one is LeftOut => one.reason === "purpose")

const readLine = (found: ProjectStatus, one: LeftOut, hints: ProjectStatusHints): string | null => {
  const step = hints.readChat?.({ ref: one.chat, account: one.account, chatId: one.chatId }, day(found.window.since))
  return step ? hints.line(step) : null
}

/** `12 messages 2026-10-03…2026-11-01`, or that the window holds none. */
export const heldInWindow = (one: { messages: number; firstAt: string | null; lastAt: string | null }) =>
  one.messages && one.firstAt && one.lastAt
    ? `${one.messages} message${one.messages === 1 ? "" : "s"} ${day(one.firstAt)}…${day(one.lastAt)}`
    : "no messages in the window"

const leftOutWhy = (one: LeftOut, read: string | null) =>
  `${one.chat}, purpose ${one.purpose}, not read: ${heldInWindow(one)}` +
  (read ? `; read it: ${read}` : "; add its purpose to --purpose to read it")

const missingOf = (found: ProjectStatus, hints: ProjectStatusHints): Missing[] => {
  const held = found.chats.filter((chat) => partial(found, chat))
  const [first] = held
  const others = found.outOfScope.filter((one) => one.reason !== "purpose")
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
    ...(others.length
      ? [
          {
            field: "chats",
            why: `${others.length} linked chats were not read here (${[
              ...new Set(others.map((one) => one.reason)),
            ].join(", ")}); memo projects status reads every account`,
          },
        ]
      : []),
    ...leftOutOf(found).map((one) => {
      const read = readLine(found, one, hints)
      return { field: "chats", why: leftOutWhy(one, read), ...(read ? { step: "messages.list" } : {}) }
    }),
    ...found.failed.map((one) => ({ field: `signal:${one.signal}`, why: one.why })),
  ]
}

const whoOf = (one: StatusWho | null) =>
  one === null
    ? {}
    : {
        who: {
          ...(one.ref === null ? {} : { ref: one.ref }),
          ...(one.name === null ? {} : { name: one.name }),
          owner: one.owner,
        },
      }

const inChat = (ref: string | null, chat: string | null) =>
  ref !== null && chat !== null && (ref === chat || ref.startsWith(`msg:${chat.slice("chat:".length)}/`))

/**
 * An item as listed: its first ref, every ref only when there are more. What the rest of the item already says is
 * left out: the chat its message ref names, the `store` basis, and a promise's `source`, which is its basis.
 */
const listed = ({ signal: _signal, who, evidence, chat, basis, data, ...one }: StatusItem) => {
  const ref = evidence[0]?.ref ?? chat
  const { source, ...rest } = data as { source?: unknown }
  return {
    ...(inChat(ref, chat) ? {} : { chat }),
    ...one,
    ...(basis === "store" ? {} : { basis }),
    data: source === basis ? rest : data,
    ref,
    ...whoOf(who),
    ...(evidence.length > 1 ? { evidence: evidence.map((each) => each.ref) } : {}),
  }
}

/**
 * Low signal items, counted on their chat's row instead of listed: questions others ask in a group with no role (a
 * leads group's requests), promises found by words that others wrote in a group, and past the newest one per chat.
 */
const unlistedOf = (found: ProjectStatus): Set<StatusItem> => {
  const chats = new Map(found.chats.map((chat) => [chat.ref, chat]))
  const patterned = new Set<string>()
  return new Set(
    found.items.filter((one) => {
      const chat = one.chat === null ? undefined : chats.get(one.chat)
      if (!chat) return false
      if (one.signal === "questions")
        return (one.data as { side: string }).side === "theirs" && chat.role === null && chat.kind !== "dialog"
      if (one.signal !== "promises" || one.basis !== "pattern") return false
      if (chat.kind !== "dialog" && !one.who?.owner) return true
      if (!patterned.has(chat.ref)) {
        patterned.add(chat.ref)
        return false
      }
      return true
    }),
  )
}

const counted = (items: StatusItem[]) => {
  const counts: Record<string, number> = {}
  for (const one of items) counts[one.signal] = (counts[one.signal] ?? 0) + 1
  return counts
}

// The newest held message is the row's `last`.
const heldOf = (one: StatusItem) => {
  const { messages, oldestAt } = (one.data as unknown as CoverageData).held
  return { messages, oldestAt }
}

/** A chat with what is said once per chat: its newest message, whose move it is, and how much of it is held. */
const chatRow = (found: ProjectStatus, hints: ProjectStatusHints, chat: StatusChatSummary, unlisted: StatusItem[]) => {
  const weight = found.attention.find((one) => one.chat === chat.ref)
  const of = (signal: string) => found.items.find((one) => one.signal === signal && one.chat === chat.ref)
  const reply = of("reply-next")
  const held = of("coverage")
  const sync = held && partial(found, chat) ? hints.sync(chat, day(found.window.since)) : null
  const replied = reply?.data as ReplyNextData | undefined
  return {
    chat: chat.ref,
    title: chat.title,
    kind: chat.kind,
    ...(chat.role === null ? {} : { role: chat.role }),
    ...(Array.isArray(found.purposes) && found.purposes.length === 1 ? {} : { purpose: chat.purpose }),
    ...(chat.project === found.project.ref ? {} : { project: chat.project }),
    coverage: chat.coverage.completeness.state,
    ...(weight ? { attention: weight.weight, why: weight.why } : {}),
    ...(reply && replied
      ? {
          last: { ref: reply.evidence[0]?.ref, at: reply.at, ...whoOf(reply.who) },
          next: replied.next,
          ...(replied.next === "nobody" ? {} : { waitingSince: replied.waitingSince }),
          ...(replied.addressed ? { addressed: replied.addressed } : {}),
          ...(replied.overdue ? { overdue: true } : {}),
        }
      : {}),
    ...(held ? { held: heldOf(held), syncCommand: sync ? hints.line(sync) : null } : {}),
    ...(unlisted.length ? { unlisted: counted(unlisted) } : {}),
  }
}

/** The answer of `projects status`: the item, two steps at most, what is missing, and the window. */
export const projectStatusAnswer = (found: ProjectStatus, hints: ProjectStatusHints) => {
  const unlisted = unlistedOf(found)
  const lists = Object.fromEntries(
    found.signals.flatMap(({ id }) => {
      if (ON_CHAT_ROW.has(id)) return []
      const items = found.items.filter((one) => one.signal === id && !unlisted.has(one)).map(listed)
      return items.length ? [[listKey(id), items]] : []
    }),
  )
  const item = snakeKeys({
    project: found.project.ref,
    key: found.project.key,
    name: found.project.name,
    signals: Object.fromEntries(found.signals.map(({ id, version }) => [id, version])),
    money: found.money.open,
    chats: found.chats.map((chat) =>
      chatRow(
        found,
        hints,
        chat,
        [...unlisted].filter((one) => one.chat === chat.ref),
      ),
    ),
    purposes: found.purposes,
    ...(found.outOfScope.length
      ? {
          outOfScope: found.outOfScope.map((one) =>
            one.reason === "purpose"
              ? {
                  chat: one.chat,
                  reason: one.reason,
                  purpose: one.purpose,
                  messages: one.messages,
                  firstAt: one.firstAt,
                  lastAt: one.lastAt,
                  readCommand: readLine(found, one, hints),
                }
              : one,
          ),
        }
      : {}),
    ...(found.failed.length ? { failed: found.failed } : {}),
    ...lists,
  }) as ProjectStatusItem
  const missing = missingOf(found, hints)
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
  const [last] = of("reply-next")
  const reply = last?.data as
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
    const data = topic.data as { query: string; silentSince: string | null }
    if (data.silentSince) open.push(`"${data.query}" quiet on their side since ${day(data.silentSince)}`)
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
      const data = one.data as { title: string; status: string }
      lines.push(`  payment ${data.title} · ${one.evidence[0]?.ref ?? ""} [${data.status}]`)
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
  const others = found.outOfScope.filter((one) => one.reason !== "purpose")
  if (others.length) lines.push(`Not read here: ${others.map((one) => `${one.chat} (${one.reason})`).join(", ")}`)
  for (const one of leftOutOf(found)) lines.push(`Left out: ${leftOutWhy(one, readLine(found, one, hints))}`)
  for (const one of found.failed) lines.push(`Signal ${one.signal} failed: ${one.why}`)
  if (next.length) lines.push("Next")
  next.forEach((step, index) => {
    lines.push(`  ${index + 1}. ${hints.line(step)}`)
  })
  return lines.join("\n")
}
