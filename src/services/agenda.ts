import { type QueryAst, type QueryRegistry, queryFieldsOf } from "@wirecat/cli-base/query"
import type * as v from "valibot"
import { formatLocator, isLocator, parseLocator } from "../domain/locator.js"
import { formatReference } from "../domain/references.js"
import { agenda } from "../entities/agenda.js"
import { AGENDA_COLUMNS, type ChatActivity, inboxKey, queryFilter, type TaskDetails } from "../store/store.js"
import { CHAT_KINDS } from "./chats.js"
import type { ServiceDeps } from "./deps.js"
import { taskAccount } from "./task-rules.js"

const DAY = 86_400_000

export interface AgendaOptions {
  /** ms: a task due within this is listed. */
  dueWithin?: number
  /** ms: a chat where the owner wrote last and nobody answered for this long is listed. */
  waiting?: number
  /** ms: a chat where someone else wrote last and the owner did not answer for this long is listed. */
  unanswered?: number
  /** ms: chats silent for longer than this are not looked at: they ended, they did not go quiet. */
  within?: number
  /** A `tasks agenda` query over `AGENDA_QUERY`; `listQuery` adds the default kinds. */
  query?: QueryAst
  /** Who asks: a task this holder claimed stays listed. */
  holder?: string
  /** Also list tasks someone else claimed; left out, they are hidden. */
  claimed?: boolean
  /** Only tasks of this category. */
  category?: string
  /** Only tasks with this tag (`tags add --task`). */
  tag?: string
}

export const AGENDA_QUERY = {
  entity: "agenda",
  backend: "sql",
  fields: queryFieldsOf(agenda, {
    exclude: ["at", "account", "stored_at", "stale"],
    relations: {
      chat_kind: {
        type: "enum",
        values: CHAT_KINDS,
        example: "chat_kind:channel",
        relation: "the kind of the chats in owed, waiting and unsynced",
      },
    },
  }),
  defaults: ["chat_kind:(dialog OR group)"],
} as const satisfies QueryRegistry

/** Why a task is on the agenda; a task planned for later and not due soon is not on it. */
export type AgendaReason = "overdue" | "due" | "check" | "unplanned"

export interface AgendaTask
  extends Pick<
    TaskDetails,
    | "id"
    | "key"
    | "title"
    | "type"
    | "category"
    | "source"
    | "dueAt"
    | "nextCheckAt"
    | "claimedBy"
    | "claimedUntil"
    | "createdAt"
  > {
  reasons: AgendaReason[]
}

export interface AgendaChat extends Omit<ChatActivity, "lastMessageId"> {
  /** The newest message, as a locator to read around; never its text. `null` while it is not stored. */
  lastMessage: string | null
  /** Open tasks whose source is in this chat. */
  openTasks: string[]
}

/**
 * What needs a look today, from the local store alone and without one message's text: the agent
 * reads only what this names. `stale` says the store saved nothing for a day — a chat may look quiet
 * only because nothing was synced; `unsynced` names the chats the store is behind on.
 */
export interface Agenda {
  at: string
  account: string
  storedAt: string | null
  stale: boolean
  tasks: AgendaTask[]
  /** Someone else wrote last, and the owner has not answered. */
  owed: AgendaChat[]
  /** The owner wrote last, and nobody answered. */
  waiting: AgendaChat[]
  /**
   * The chat list says these moved, and their newest message is not stored: who wrote last is unknown
   * until they are read. Never dropped, or a chat nobody synced would never come up.
   */
  unsynced: AgendaChat[]
}

export interface AgendaService {
  show(options?: AgendaOptions): Promise<Agenda>
}

export const agendaService = (deps: ServiceDeps, now: () => number = Date.now): AgendaService => ({
  show: async ({
    dueWithin = DAY,
    waiting = 7 * DAY,
    unanswered = DAY,
    within = 30 * DAY,
    query,
    holder,
    claimed = false,
    category,
    tag,
  } = {}) => {
    const [store, account] = [await deps.store(), await deps.account()]
    const at = now()
    const open = await store.tasks
      .find({ project: inboxKey(taskAccount(account)), status: "open", limit: 500 })
      .catch((error: unknown) => {
        // An account that never had a task has no inbox project yet.
        if (error instanceof Error && "code" in error && error.code === "not_found") return []
        throw error
      })
    const tagged =
      tag === undefined
        ? undefined
        : new Set(
            (await store.tags(account, { type: "task", tag: tag.trim().toLowerCase() })).map(({ taskId }) => taskId),
          )
    const tasks = open
      .filter((task) => claimed || task.claimedBy === null || task.claimedBy === holder)
      .filter((task) => category === undefined || task.category === category.trim().toLowerCase())
      .filter((task) => tagged === undefined || tagged.has(task.id))
      .map((task) => ({ task, reasons: reasonsOf(task, at, dueWithin) }))
      .filter(({ reasons }) => reasons.length > 0)
      .sort((a, b) => urgency(a.task) - urgency(b.task))
      .map(({ task, reasons }) => ({
        id: task.id,
        key: task.key,
        title: task.title,
        type: task.type,
        category: task.category,
        source: task.source,
        dueAt: task.dueAt,
        nextCheckAt: task.nextCheckAt,
        claimedBy: task.claimedBy,
        claimedUntil: task.claimedUntil,
        createdAt: task.createdAt,
        reasons,
      }))

    const where = query ? queryFilter(query, AGENDA_COLUMNS, { command: "tasks agenda" }) : undefined
    const activity = await store.chatActivity(account, at - within, where)
    const chats = activity.chats.map(({ lastMessageId, ...chat }) => ({
      ...chat,
      lastMessage:
        lastMessageId === null
          ? null
          : formatLocator({
              provider: account.provider,
              account: account.account,
              chat: chat.chatId,
              message: lastMessageId,
            }),
      openTasks: open.filter((task) => chatOf(task.source) === chat.chatId).map((task) => task.id),
    }))
    const silentFor = (chat: AgendaChat) => at - Date.parse(chat.lastMessageAt)
    return {
      at: new Date(at).toISOString(),
      account: taskAccount(account),
      storedAt: activity.storedAt,
      stale: activity.storedAt === null || at - Date.parse(activity.storedAt) > DAY,
      tasks,
      owed: chats.filter((chat) => chat.lastFromOwner === false && silentFor(chat) >= unanswered),
      waiting: chats.filter((chat) => chat.lastFromOwner === true && silentFor(chat) >= waiting),
      unsynced: chats.filter((chat) => chat.lastMessage === null),
    }
  },
})

const reasonsOf = (task: TaskDetails, at: number, dueWithin: number): AgendaReason[] => {
  const due = task.dueAt === null ? undefined : Date.parse(task.dueAt)
  const check = task.nextCheckAt === null ? undefined : Date.parse(task.nextCheckAt)
  const reasons: AgendaReason[] = []
  if (due !== undefined && due <= at) reasons.push("overdue")
  else if (due !== undefined && due <= at + dueWithin) reasons.push("due")
  if (check !== undefined && check <= at) reasons.push("check")
  if (due === undefined && check === undefined) reasons.push("unplanned")
  return reasons
}

/** The earliest date a task names; one with none waits since it was opened. */
const urgency = (task: TaskDetails): number => {
  const dates = [task.dueAt, task.nextCheckAt].filter((one): one is string => one !== null).map(Date.parse)
  return dates.length > 0 ? Math.min(...dates) : Date.parse(task.createdAt)
}

/** The chat a message locator names; a note or document source belongs to no chat. */
const chatOf = (source: string | null): string | undefined =>
  source !== null && isLocator(source) ? parseLocator(source).chat : undefined

export type AgendaItem = v.InferOutput<typeof agenda>

/** The agenda in entity keys, as `--json` and MCP answer it; chats become `chat:` references. */
export const agendaItem = (shown: Agenda): AgendaItem => {
  const split = shown.account.indexOf(":")
  const [provider, account] = [shown.account.slice(0, split), shown.account.slice(split + 1)]
  const chat = (one: AgendaChat) => ({
    chat: formatReference({ type: "chat", provider, account, chat: one.chatId }),
    title: one.title,
    kind: one.kind,
    last_message: one.lastMessage,
    last_message_at: one.lastMessageAt,
    last_from_owner: one.lastFromOwner,
    open_tasks: one.openTasks,
  })
  return {
    at: shown.at,
    account: shown.account,
    stored_at: shown.storedAt,
    stale: shown.stale,
    tasks: shown.tasks.map((task) => ({
      id: task.id,
      key: task.key,
      title: task.title,
      kind: task.type,
      category: task.category,
      source: task.source,
      due_at: task.dueAt,
      next_check_at: task.nextCheckAt,
      claimed_by: task.claimedBy,
      claimed_until: task.claimedUntil,
      created_at: task.createdAt,
      reasons: task.reasons,
    })),
    owed: shown.owed.map(chat),
    waiting: shown.waiting.map(chat),
    unsynced: shown.unsynced.map(chat),
  }
}
