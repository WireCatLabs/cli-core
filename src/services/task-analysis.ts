import { CliError } from "@wirecat/cli-base"
import { isLocator, parseLocator } from "../domain/locator.js"
import type { ChatKind, Id, Message } from "../domain/models.js"
import type { AccountKey, MessageStore, TaskAnalysisMark, TaskAnalysisMarkWrite } from "../store/index.js"
import { FIRST_PASS_DAYS, RULES_IN, taskAccount } from "./task-rules.js"

/** How many messages one read gives an agent: a page it can judge in one go. */
export const ANALYSIS_PAGE = 100
export const ANALYSIS_PAGE_MAX = 1000

/** Where a chat never read for tasks starts, unless the caller names a time: older history is not new work. */
export const defaultStart = (now: Date): string => new Date(now.getTime() - FIRST_PASS_DAYS * 86_400_000).toISOString()

const after = (iso: string) => new Date(Date.parse(iso) + 1).toISOString()

/** Messages saved or edited after the mark was last checked, sent inside the stretch it had read. */
const lateOf = async (store: MessageStore, account: AccountKey, mark: TaskAnalysisMark): Promise<Message[]> => {
  const { messages } = await store.messages.changes(account, mark.chatId, mark.checkedAt)
  return messages.filter((one) => one.timestamp >= mark.from && one.timestamp <= mark.checkedThrough)
}

export interface ChatAnalysis {
  chatId: Id
  title: string | null
  kind: ChatKind
  newestAt: string | null
  mark: TaskAnalysisMark | null
  /** Stored messages after the mark, or since the default start when the chat was never read for tasks. */
  waiting: number
  /** Stored inside the read stretch after it was read: `--since <from>` reads the stretch again. */
  late: number
}

/**
 * Every chat whose messages can hold the owner's tasks — not a channel or Saved Messages (owner, 2026-10-17) — with
 * how far it was read for tasks and how much waits, newest chat first.
 */
export const taskAnalysisList = async (
  store: MessageStore,
  account: AccountKey,
  now = new Date(),
): Promise<ChatAnalysis[]> => {
  const marks = new Map((await store.sync.taskAnalysisMarks(account)).map((mark) => [mark.chatId, mark]))
  const start = defaultStart(now)
  const chats: ChatAnalysis[] = []
  for (const chat of await store.chats.chatStats(account)) {
    if (RULES_IN[chat.kind] === "none") continue
    const mark = marks.get(chat.chatId) ?? null
    chats.push({
      chatId: chat.chatId,
      title: chat.title,
      kind: chat.kind,
      newestAt: chat.newestAt,
      mark,
      waiting: await store.messages.countMessages(account, chat.chatId, { since: mark ? after(mark.through) : start }),
      late: mark ? (await lateOf(store, account, mark)).length : 0,
    })
  }
  return chats.sort((a, b) => (b.newestAt ?? "").localeCompare(a.newestAt ?? ""))
}

export interface UnanalysedPage {
  mark: TaskAnalysisMark | null
  /** Where this read started: the mark, `since`, or the default start. */
  from: string
  messages: Message[]
  more: boolean
  late: number
}

/**
 * The stored messages of a chat not yet read for tasks, oldest first, from its mark; `since` reads from that time
 * instead, to read a stretch again. Reading moves nothing: `acknowledgeTaskAnalysis` does, once the reader is done.
 */
export const unanalysedMessages = async (
  store: MessageStore,
  account: AccountKey,
  chatId: Id,
  { limit = ANALYSIS_PAGE, since, now = new Date() }: { limit?: number; since?: string; now?: Date } = {},
): Promise<UnanalysedPage> => {
  const mark = (await store.sync.taskAnalysisMark(account, chatId)) ?? null
  const from = since ?? mark?.through ?? defaultStart(now)
  const byTime = { time: Date.parse(from) - (since === undefined && mark ? 0 : 1) }
  const read = (start: { id: Id } | { time: number }) =>
    store.messages.messages(account, chatId, { limit, after: start })
  let page: Awaited<ReturnType<typeof read>>
  if (since === undefined && mark) {
    try {
      page = await read({ id: mark.throughId })
    } catch (error) {
      if (!(error instanceof CliError && error.code === "not_found")) throw error
      page = await read(byTime)
    }
  } else page = await read(byTime)
  return {
    mark,
    from,
    messages: page.items,
    more: page.hasMore,
    late: mark ? (await lateOf(store, account, mark)).length : 0,
  }
}

/**
 * Records that the chat was read for tasks through `messageId`, from `since` when that read started there. The mark
 * never moves back. A read that covered the whole stretch again also clears what arrived late inside it.
 */
export const acknowledgeTaskAnalysis = async (
  store: MessageStore,
  account: AccountKey,
  chatId: Id,
  messageId: Id,
  { since, by, now = new Date() }: { since?: string; by: string; now?: Date },
): Promise<{ mark: TaskAnalysisMark; moved: boolean }> => {
  const message = await store.messages.message(account, messageId, { chatId })
  if (!message) throw new CliError("not_found", `message ${messageId} is not in the local copy of chat ${chatId}`)
  const mark = await store.sync.taskAnalysisMark(account, chatId)
  const start = since ?? mark?.from ?? defaultStart(now)
  if (message.timestamp < start)
    throw new CliError("validation_error", `message ${messageId} was sent before the read started (${start})`)
  if (mark && message.timestamp < mark.from)
    throw new CliError(
      "validation_error",
      `message ${messageId} ends before the stretch already read (${mark.from}): read on to it, then acknowledge`,
    )
  const ahead = !mark || message.timestamp > mark.through || (since !== undefined && message.timestamp >= mark.through)
  if (mark && !ahead && start >= mark.from) return { mark, moved: false }
  const reread = mark !== undefined && since !== undefined && since <= mark.from && ahead
  const checked = !mark || reread || (since === undefined && (await lateOf(store, account, mark)).length === 0)
  const through = mark && !ahead ? mark : { through: message.timestamp, throughId: message.id }
  const next: TaskAnalysisMarkWrite = {
    chatId,
    from: mark && mark.from < start ? mark.from : start,
    through: through.through,
    throughId: through.throughId,
    by,
    checked,
    checkedThrough: checked || !mark ? through.through : mark.checkedThrough,
  }
  await store.sync.setTaskAnalysisMark(account, next)
  const saved = await store.sync.taskAnalysisMark(account, chatId)
  if (!saved) throw new Error(`the task analysis mark of chat ${chatId} was not saved`)
  return { mark: saved, moved: true }
}

/**
 * A read again of history the chat's task point already passed only updates and closes tasks (owner, 2026-11-03):
 * a new task from such a message needs `--open-new`. A message that already has a task, or one after the point, is
 * let through.
 */
export const refuseAlreadyRead = async (store: MessageStore, account: AccountKey, source: string): Promise<void> => {
  if (!isLocator(source)) return
  const { provider, account: owner, chat, message } = parseLocator(source)
  if (provider !== account.provider || owner !== account.account) return
  const mark = await store.sync.taskAnalysisMark(account, chat)
  if (!mark) return
  const stored = await store.messages.message(account, message, { chatId: chat })
  if (!stored || stored.timestamp > mark.through) return
  if ((await store.tasks.findBySource(taskAccount(account), source)).length > 0) return
  throw new CliError(
    "validation_error",
    `${source} was already read for tasks (the point is at ${mark.through}): a read again only updates and closes ` +
      "tasks; add --open-new to open a task from it anyway",
    { reason: "task.already-read" },
  )
}
