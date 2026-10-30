import {
  type QueryAst,
  type QueryNode,
  type QueryRegistry,
  queryError,
  queryFieldsOf,
  walkQuery,
} from "@wirecat/cli-base/query"
import type * as v from "valibot"
import { formatLocator, isLocator, parseLocator } from "../domain/locator.js"
import { formatReference } from "../domain/references.js"
import { agenda } from "../entities/agenda.js"
import {
  AGENDA_COLUMNS,
  type ChatActivity,
  type ColumnMap,
  inboxKey,
  queryFilter,
  type TaskDetails,
  type Where,
} from "../store/store.js"
import { type ChatCoverage, chatCoverage } from "./chat-coverage.js"
import { CHAT_KINDS } from "./chats.js"
import type { ServiceDeps } from "./deps.js"
import { taskAccount } from "./task-rules.js"
import { taskTagFilters } from "./task-tag-filters.js"

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
  /** A `tasks agenda` query over `AGENDA_QUERY`; `listQuery` adds the default kinds and claims. */
  query?: QueryAst
  /** Who asks: `claimed:mine` is this holder's claims. */
  holder?: string
}

const CLAIMS = ["none", "mine", "others", "any"] as const
const TASK_FIELDS = new Set(["tag", "category", "claimed"])

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
      tag: { type: "kw", example: "tag:urgent", relation: "a tag put on a listed task with tags add --task" },
      category: { type: "kw", example: "category:money", relation: "a listed task's category" },
      claimed: {
        type: "enum",
        values: CLAIMS,
        example: "claimed:any",
        relation: "whose claim a listed task is under: none, mine (--holder), others, or any",
      },
    },
  }),
  defaults: ["chat_kind:(dialog OR group)", "claimed:(none OR mine)"],
} as const satisfies QueryRegistry

/** Why a task is on the agenda; a task planned for later and not due soon is not on it. */
export type AgendaReason = "overdue" | "due" | "check" | "unplanned" | "close-suggested"

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
    | "closeSuggestion"
    | "createdAt"
  > {
  reasons: AgendaReason[]
}

export interface AgendaAssigned
  extends Pick<TaskDetails, "id" | "key" | "title" | "type" | "category" | "source" | "dueAt" | "createdAt"> {
  /** `person:<id>`, each one who does it. */
  assignees: string[]
}

export interface AgendaChat extends Omit<ChatActivity, "lastMessageId"> {
  /** How much of the chat's history the store holds: a chat held from last week alone is not a quiet chat. */
  coverage: ChatCoverage
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
  /** The start of the window the chats were read for (`within`). */
  since: string
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
  /** Open tasks someone else does: what they owe the owner, oldest first. */
  assigned: AgendaAssigned[]
  /** Open tasks carry these categories, which the list no longer holds: move them, or put the category back. */
  unlistedCategories: { name: string; openTasks: number }[]
}

export interface AgendaService {
  show(options?: AgendaOptions): Promise<Agenda>
}

export const agendaService = (deps: ServiceDeps, now: () => number = Date.now): AgendaService => ({
  show: async ({ dueWithin = DAY, waiting = 7 * DAY, unanswered = DAY, within = 30 * DAY, query, holder } = {}) => {
    const [store, account] = [await deps.store(), await deps.account()]
    const at = now()
    const parts = query ? split(query) : { tasks: undefined, chats: undefined }
    const find = (where?: Where) =>
      store.tasks
        .find({ project: inboxKey(taskAccount(account)), status: "open", limit: 500, ...(where ? { where } : {}) })
        .catch((error: unknown) => {
          // An account that never had a task has no inbox project yet.
          if (error instanceof Error && "code" in error && error.code === "not_found") return []
          throw error
        })
    const open = await find()
    const tags = await taskTagFilters(store, parts.tasks)
    const listed = parts.tasks
      ? await find(queryFilter(parts.tasks, taskColumns(holder, at, tags), { command: "tasks agenda" }))
      : open
    const tasks = listed
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
        closeSuggestion: task.closeSuggestion,
        createdAt: task.createdAt,
        reasons,
      }))

    const assigned = listed
      .map((task) => ({
        task,
        assignees: task.assignments.filter((one) => one.role === "assignee").map((one) => one.to),
      }))
      .filter(({ assignees }) => assignees.length > 0)
      .sort((a, b) => Date.parse(a.task.createdAt) - Date.parse(b.task.createdAt))
      .map(({ task, assignees }) => ({
        id: task.id,
        key: task.key,
        title: task.title,
        type: task.type,
        category: task.category,
        source: task.source,
        dueAt: task.dueAt,
        createdAt: task.createdAt,
        assignees,
      }))

    const where = parts.chats ? queryFilter(parts.chats, AGENDA_COLUMNS, { command: "tasks agenda" }) : undefined
    const activity = await store.chats.chatActivity(account, at - within, where)
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
    const silentFor = (chat: Omit<AgendaChat, "coverage">) => at - Date.parse(chat.lastMessageAt)
    const shown = {
      owed: chats.filter((chat) => chat.lastFromOwner === false && silentFor(chat) >= unanswered),
      waiting: chats.filter((chat) => chat.lastFromOwner === true && silentFor(chat) >= waiting),
      unsynced: chats.filter((chat) => chat.lastMessage === null),
    }
    const covered = new Map(
      (
        await chatCoverage(
          store,
          account,
          Object.values(shown).flatMap((list) => list.map(({ chatId }) => chatId)),
        )
      ).map((one) => [one.chatId, one]),
    )
    const withCoverage = (list: typeof chats): AgendaChat[] =>
      list.map((chat) => ({ ...chat, coverage: covered.get(chat.chatId) as ChatCoverage }))
    const inList = new Set((await store.tasks.categories()).map(({ name }) => name))
    const unlisted = new Map<string, number>()
    for (const { category } of open)
      if (category && !inList.has(category)) unlisted.set(category, (unlisted.get(category) ?? 0) + 1)
    return {
      at: new Date(at).toISOString(),
      since: new Date(at - within).toISOString(),
      account: taskAccount(account),
      storedAt: activity.storedAt,
      stale: activity.storedAt === null || at - Date.parse(activity.storedAt) > DAY,
      tasks,
      owed: withCoverage(shown.owed),
      waiting: withCoverage(shown.waiting),
      unsynced: withCoverage(shown.unsynced),
      assigned,
      unlistedCategories: [...unlisted].sort().map(([name, openTasks]) => ({ name, openTasks })),
    }
  },
})

/** Task terms filter the tasks, the rest the chats; a clause that mixes the two has no one source to ask. */
const split = (query: QueryAst): { tasks?: QueryAst; chats?: QueryAst } => {
  const clauses: QueryNode[] = []
  const flatten = (node: QueryNode) => {
    if (node.kind === "boolean" && node.clauses.every((clause) => clause.occur === "must"))
      for (const clause of node.clauses) flatten(clause.node)
    else clauses.push(node)
  }
  flatten(query.root)
  const side = (node: QueryNode) => {
    const fields = new Set(walkQuery(node).map((term) => (TASK_FIELDS.has(term.field) ? "tasks" : "chats")))
    if (fields.size > 1)
      queryError(
        "query.unsupported-placement",
        node.span,
        "join task fields (tag, category, claimed) and chat_kind with AND, not OR or NOT",
        { command: "tasks agenda" },
      )
    return [...fields][0]
  }
  const of = (which: "tasks" | "chats"): QueryAst | undefined => {
    const own = clauses.filter((node) => side(node) === which)
    if (own.length === 0) return undefined
    return {
      ...query,
      root: { kind: "boolean", clauses: own.map((node) => ({ occur: "must", node })), span: query.root.span },
    }
  }
  return { tasks: of("tasks"), chats: of("chats") }
}

/** A claim that lapsed holds nothing, as `tasks claim` reads it. */
const taskColumns = (holder: string | undefined, at: number, tags: ReadonlyMap<string, Where>): ColumnMap => ({
  tag: { where: (node) => tags.get(node.value) ?? { sql: "0", params: [] } },
  category: { type: "kw", sql: "t.category" },
  claimed: {
    where: (node) => {
      const claim = node.value.toLowerCase() as (typeof CLAIMS)[number]
      if (claim === "any") return { sql: "1", params: [] }
      if (claim === "none") return { sql: "t.claimed_by IS NULL OR t.claimed_until < ?", params: [at] }
      if (claim === "mine")
        return {
          sql: "t.claimed_by IS NOT NULL AND t.claimed_by = ? AND t.claimed_until >= ?",
          params: [holder ?? null, at],
        }
      return {
        sql: "t.claimed_by IS NOT NULL AND t.claimed_by IS NOT ? AND t.claimed_until >= ?",
        params: [holder ?? null, at],
      }
    },
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
  if (task.closeSuggestion !== null) reasons.push("close-suggested")
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
    completeness: {
      state: one.coverage.completeness.state,
      up_to_date: one.coverage.completeness.upToDate,
      gaps: one.coverage.completeness.gaps,
      reaches_start: one.coverage.completeness.reachesStart,
      fetched_at: one.coverage.completeness.fetchedAt,
    },
    held: {
      messages: one.coverage.held.messages,
      oldest_at: one.coverage.held.oldestAt,
      newest_at: one.coverage.held.newestAt,
    },
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
      close_suggestion: task.closeSuggestion,
      created_at: task.createdAt,
      reasons: task.reasons,
    })),
    owed: shown.owed.map(chat),
    waiting: shown.waiting.map(chat),
    unsynced: shown.unsynced.map(chat),
    assigned: shown.assigned.map((task) => ({
      id: task.id,
      key: task.key,
      title: task.title,
      kind: task.type,
      category: task.category,
      source: task.source,
      due_at: task.dueAt,
      created_at: task.createdAt,
      assignees: task.assignees,
    })),
    unlisted_categories: shown.unlistedCategories.map(({ name, openTasks }) => ({ name, open_tasks: openTasks })),
  }
}
