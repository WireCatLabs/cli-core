import { formatLocator, isLocator, parseLocator } from "../domain/locator.js"
import type { ChatKind } from "../domain/models.js"
import { type ChatActivity, inboxKey, type TaskDetails } from "../store/store.js"
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
  kinds?: readonly ChatKind[]
}

/** Why a task is on the agenda; a task planned for later and not due soon is not on it. */
export type AgendaReason = "overdue" | "due" | "check" | "unplanned"

export interface AgendaTask
  extends Pick<TaskDetails, "id" | "key" | "title" | "type" | "source" | "dueAt" | "nextCheckAt" | "createdAt"> {
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
  show: async ({ dueWithin = DAY, waiting = 7 * DAY, unanswered = DAY, within = 30 * DAY, kinds } = {}) => {
    const [store, account] = [await deps.store(), await deps.account()]
    const at = now()
    const open = await store.tasks
      .find({ project: inboxKey(taskAccount(account)), status: "open", limit: 500 })
      .catch((error: unknown) => {
        // An account that never had a task has no inbox project yet.
        if (error instanceof Error && "code" in error && error.code === "not_found") return []
        throw error
      })
    const tasks = open
      .map((task) => ({ task, reasons: reasonsOf(task, at, dueWithin) }))
      .filter(({ reasons }) => reasons.length > 0)
      .sort((a, b) => urgency(a.task) - urgency(b.task))
      .map(({ task, reasons }) => ({
        id: task.id,
        key: task.key,
        title: task.title,
        type: task.type,
        source: task.source,
        dueAt: task.dueAt,
        nextCheckAt: task.nextCheckAt,
        createdAt: task.createdAt,
        reasons,
      }))

    const activity = await store.chatActivity(account, at - within)
    const wanted = new Set<ChatKind>(kinds ?? ["dialog", "group"])
    const chats = activity.chats
      .filter((chat) => wanted.has(chat.kind))
      .map(({ lastMessageId, ...chat }) => ({
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
