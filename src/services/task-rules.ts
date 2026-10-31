import { formatLocator } from "../domain/locator.js"
import type { ChatKind, Id, Message, ReviewChat } from "../domain/models.js"
import type { AccountKey, MessageStore } from "../store/store.js"
import { createTaskService, isClosedState, type TaskKind, type TaskStore } from "../tasks/index.js"
import { questions } from "./questions.js"
import { categorize, type TaskCategory } from "./task-categories.js"

export interface RuleResult {
  added: number
  closed: number
  /** Opened tasks that may be the same job as another: on the review list (`tasks duplicates list`). */
  review: number
  /** Tasks the rules found but did not open: over the per-chat limit, or a dry run. */
  held?: number
  /** Chats with at least one held task. */
  heldChats?: number
}

/** A task the rules would open, for a dry run. */
export interface HeldTask {
  source: string
  kind: TaskKind
  category: string | null
}

export const taskAccount = ({ provider, account }: AccountKey): string => `${provider}:${account}`

/**
 * Opens a task for each question nobody answered and each message that mentions the owner, and closes
 * one when the owner answered it — over every message a review read, before `--unanswered` narrows it.
 * Run twice over the same window it changes nothing: the service returns the task a source already has.
 * Only the owner's answers count: the store knows no admins, and a review without `--unanswered` asks
 * for none. A mention is one the messenger marks by id; an `@handle` is not seen.
 */
/**
 * Where the rules open tasks for the owner (owner, 2026-10-17): every unanswered question in a one-to-one chat; in a
 * group only a question that replies to the owner, and a mention; nothing in a channel or Saved Messages. A group
 * of strangers' questions is not the owner's work. `unknown` is read as a group: it may be one.
 */
export const RULES_IN: Record<ChatKind, "all" | "addressed" | "none"> = {
  dialog: "all",
  group: "addressed",
  unknown: "addressed",
  channel: "none",
  saved: "none",
}

/** A group the owner tagged so: every unanswered question in it opens a task, whoever it is for (owner, 2026-10-17). */
export const WATCH_TAG = "watch-tasks"

const scopeOf = (kind: ChatKind, watched: boolean) =>
  watched && RULES_IN[kind] === "addressed" ? "all" : RULES_IN[kind]

const watchedChats = async (store: MessageStore, account: AccountKey): Promise<Set<Id>> =>
  new Set(
    (await store.tags.tags(account, { tag: WATCH_TAG, type: "chat" })).flatMap((one) =>
      one.chatId ? [one.chatId] : [],
    ),
  )

/** `review`'s chats, each marked when the owner tagged it watch-tasks. */
export const withWatched = async <Chat extends { id: Id }>(
  store: MessageStore,
  account: AccountKey,
  review: { chats: Chat[] },
): Promise<{ chats: (Chat & { watched: boolean })[] }> => {
  const watched = await watchedChats(store, account)
  return { chats: review.chats.map((chat) => ({ ...chat, watched: watched.has(chat.id) })) }
}

const repliesToOwner = (message: Message, messages: readonly Message[]) => {
  const to = message.replyTo?.id ?? message.replyToId
  const quoted = to === undefined ? undefined : messages.find((one) => one.id === to)
  return quoted ? quoted.outgoing === true : message.replyTo?.outgoing === true
}

export const applyTaskRules = async (
  review: { chats: (Pick<ReviewChat, "id" | "messages" | "kind"> & { watched?: boolean })[] },
  {
    store,
    account,
    now,
    categories,
    openLimit,
    dryRun = false,
    onHeld,
  }: {
    store: TaskStore
    account: AccountKey
    now?: () => Date
    categories?: readonly TaskCategory[]
    /** Per chat: the newest this many are opened, the rest held. */
    openLimit?: number
    /** Changes nothing: what would open is held and passed to `onHeld`. */
    dryRun?: boolean
    onHeld?: (task: HeldTask) => void
  },
): Promise<RuleResult> => {
  const tasks = createTaskService({ store, ...(now ? { now } : {}) })
  const owner = taskAccount(account)
  const result: RuleResult = { added: 0, closed: 0, review: 0 }
  const sourceOf = (message: Message) =>
    formatLocator({ provider: account.provider, account: account.account, chat: message.chatId, message: message.id })

  const open = async (message: Message, group: Id, kind: TaskKind) => {
    const { created, review = 0 } = await tasks.add({
      source: sourceOf(message),
      sourceKind: "message",
      account: owner,
      group,
      kind,
      origin: "rule",
      category: categorize(message.text, categories),
    })
    if (created) result.added += 1
    result.review += review
  }
  const close = async (message: Message, kind: TaskKind, answer?: Message) => {
    for (const task of await store.findBySource(owner, sourceOf(message))) {
      if (task.kind !== kind || isClosedState(task.state)) continue
      result.closed += 1
      if (dryRun) continue
      await tasks.close(task.id, { as: "done", by: "rule" })
      if (answer)
        await store.answer(task.id, {
          resolution: answer.outgoing ? "answered by the owner" : "answered in the group",
          by: sourceOf(answer),
        })
    }
  }
  const hasTask = async (message: Message) => (await store.findBySource(owner, sourceOf(message))).length > 0

  for (const chat of review.chats) {
    const scope = scopeOf(chat.kind, chat.watched === true)
    if (scope === "none") continue
    const opens: { message: Message; kind: TaskKind }[] = []
    // In a group the owner watches, any member's direct reply settles a question (owner, 2026-10-17); a later
    // message that does not reply to it may be about anything else.
    const memberReply = (question: Message) =>
      chat.watched === true
        ? chat.messages.find(
            (one) => (one.replyTo?.id ?? one.replyToId) === question.id && one.senderId !== question.senderId,
          )
        : undefined
    for (const found of questions(chat.messages, { answerers: new Set() })) {
      const { question } = found
      const answer = found.answer ?? memberReply(question)
      if (answer) await close(question, "question", answer)
      else if (scope === "all" || (question.text.includes("?") && repliesToOwner(question, chat.messages)))
        opens.push({ message: question, kind: "question" })
    }
    for (const [index, message] of chat.messages.entries()) {
      if (message.outgoing || !message.mentions?.includes(account.account)) continue
      if (ownerAnswered(chat.messages, index)) await close(message, "mention")
      else opens.push({ message, kind: "mention" })
    }
    opens.sort((a, b) => Date.parse(a.message.timestamp) - Date.parse(b.message.timestamp))
    const keep = dryRun ? 0 : openLimit === undefined ? opens.length : Math.min(openLimit, opens.length)
    let held = 0
    for (const [index, { message, kind }] of opens.entries()) {
      if (index >= opens.length - keep) await open(message, chat.id, kind)
      else if (!(await hasTask(message))) {
        held += 1
        onHeld?.({ source: sourceOf(message), kind, category: categorize(message.text, categories) })
      }
    }
    if (held > 0) {
      result.held = (result.held ?? 0) + held
      result.heldChats = (result.heldChats ?? 0) + 1
    }
  }
  return result
}

/** How far back `serve` looks when a message arrives: enough to see whether it answers a recent question. */
export const ARRIVAL_WINDOW = 50

/** A chat the store has no message of yet is `unknown`, which the rules read as a group: only what is addressed. */
const kindOf = async (store: MessageStore, account: AccountKey, chat: Id): Promise<ChatKind> =>
  (await store.chats.chatKind(account, chat)) ?? "unknown"

/** `serve`'s rule pass: the new message with the chat's stored messages before it, as a review would read them. */
export const applyTaskRulesOnArrival = async (
  store: MessageStore,
  account: AccountKey,
  message: Message,
): Promise<RuleResult> => {
  const page = await store.messages.messages(account, message.chatId, { limit: ARRIVAL_WINDOW })
  const messages = [...page.items.filter((one) => one.id !== message.id), message].sort(
    (a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp),
  )
  return applyTaskRules(
    {
      chats: [
        {
          id: message.chatId,
          messages,
          kind: await kindOf(store, account, message.chatId),
          watched: (await watchedChats(store, account)).has(message.chatId),
        },
      ],
    },
    { store: store.tasks, account, categories: await store.tasks.categories() },
  )
}

/** The most messages one chat gives a stored pass, however many arrived since the last. */
export const STORED_PASS_LIMIT = 1000

/**
 * The rule pass over what is already stored, for a program that reads no messenger (memo): every chat of
 * the account stored into after `since`, its new messages with the ARRIVAL_WINDOW before them, through the
 * rules `review` applies. `until` is the newest store time it saw — the next pass's `since`, so a pass reads
 * only what changed. A chat with more new messages than STORED_PASS_LIMIT has its oldest left unread. After
 * `since`, a chat with nothing sent since is skipped: a backfill of old history is not new work.
 */
export const applyTaskRulesToStored = async (
  store: MessageStore,
  account: AccountKey,
  since?: string,
  newerThan?: string,
  openLimit?: number,
): Promise<RuleResult & { until: string | null }> => {
  const result: RuleResult & { until: string | null } = { added: 0, closed: 0, review: 0, until: since ?? null }
  const categories = await store.tasks.categories()
  const watched = await watchedChats(store, account)
  for (const chat of await store.chats.chatStats(account)) {
    if (chat.lastStoredAt === null || (since !== undefined && chat.lastStoredAt <= since)) continue
    // A skipped chat still moves the stop point, or the next pass would read all of it as new.
    if (
      RULES_IN[chat.kind] === "none" ||
      (newerThan !== undefined && (chat.newestAt === null || chat.newestAt < newerThan))
    ) {
      if (result.until === null || chat.lastStoredAt > result.until) result.until = chat.lastStoredAt
      continue
    }
    const fresh = since === undefined ? 0 : await store.messages.countMessages(account, chat.chatId, { since })
    if (since !== undefined && fresh === 0) {
      if (result.until === null || chat.lastStoredAt > result.until) result.until = chat.lastStoredAt
      continue
    }
    const page = await store.messages.messages(account, chat.chatId, {
      limit: Math.min(ARRIVAL_WINDOW + fresh, STORED_PASS_LIMIT),
    })
    const pass = await applyTaskRules(
      { chats: [{ id: chat.chatId, messages: page.items, kind: chat.kind, watched: watched.has(chat.chatId) }] },
      { store: store.tasks, account, categories, ...(openLimit === undefined ? {} : { openLimit }) },
    )
    result.added += pass.added
    result.closed += pass.closed
    result.review += pass.review
    if (pass.held) {
      result.held = (result.held ?? 0) + pass.held
      result.heldChats = (result.heldChats ?? 0) + (pass.heldChats ?? 0)
    }
    if (result.until === null || chat.lastStoredAt > result.until) result.until = chat.lastStoredAt
  }
  return result
}

/** How far back the first pass after a sync looks, by the newest message's time: older chats are history, not work. */
export const FIRST_PASS_DAYS = 14

/**
 * The task rules over what a sync stored, from where the account's last pass stopped. The first pass reads only
 * chats with a message in the last FIRST_PASS_DAYS, so a store that already holds years of chats opens no task
 * for a question asked long ago, and opens at most `task_first_pass_per_chat` per chat (0 by default): what it
 * holds back is counted, for the owner to build with `tasks scan`.
 */
export const applyTaskRulesSinceLastPass = async (
  store: MessageStore,
  account: AccountKey,
  now = new Date(),
): Promise<RuleResult> => {
  const since = await store.sync.taskRulesStop(account)
  const newerThan = since === null ? new Date(now.getTime() - FIRST_PASS_DAYS * 86_400_000).toISOString() : undefined
  const openLimit = since === null ? await store.tasks.firstPassPerChat() : undefined
  const { until, ...result } = await applyTaskRulesToStored(store, account, since ?? undefined, newerThan, openLimit)
  if (until !== null && until !== since) await store.sync.setTaskRulesStop(account, until)
  return result
}

/**
 * A reply rule's `task` action: one `request` task pointing at the message. The service gives back
 * the task a source already has, so a message arriving twice opens one.
 */
export const openRequestTask = async (store: MessageStore, account: AccountKey, message: Message): Promise<boolean> => {
  const { created } = await createTaskService({ store: store.tasks }).add({
    source: formatLocator({
      provider: account.provider,
      account: account.account,
      chat: message.chatId,
      message: message.id,
    }),
    sourceKind: "message",
    account: taskAccount(account),
    group: message.chatId,
    kind: "request",
    origin: "rule",
    category: categorize(message.text, await store.tasks.categories()),
  })
  return created
}

/** The owner replied to the message, or to anything its sender said, later in the chat. */
const ownerAnswered = (messages: Message[], index: number): boolean => {
  const message = messages[index]
  if (!message) return false
  const senders = new Map(messages.map((one) => [one.id, one.senderId]))
  return messages.slice(index + 1).some((one) => {
    if (one.outgoing !== true) return false
    const to = one.replyTo?.id ?? one.replyToId
    if (to === message.id) return true
    const repliedSender = one.replyTo?.senderId ?? (to === undefined ? undefined : senders.get(to))
    return repliedSender != null && repliedSender === message.senderId
  })
}

/** What `tasks scan` did, or would do without `--yes`, in one chat. */
export interface ChatRulePass extends RuleResult {
  chat: string
  messages: number
  tasks: HeldTask[]
}

/**
 * `tasks scan`: the task rules over the newest `last` stored messages of chats the owner names — how a chat's
 * history becomes tasks when the first sync left it alone. Without `yes` it changes nothing and lists what would
 * open; with it, it opens them through the duplicate check, as a sync's pass would.
 */
export const applyTaskRulesToChats = async (
  store: MessageStore,
  account: AccountKey,
  chatIds: readonly string[],
  { last = ARRIVAL_WINDOW, yes = false }: { last?: number; yes?: boolean } = {},
): Promise<ChatRulePass[]> => {
  const categories = await store.tasks.categories()
  const watched = await watchedChats(store, account)
  const passes: ChatRulePass[] = []
  for (const chat of chatIds) {
    const page = await store.messages.messages(account, chat, { limit: Math.min(last, STORED_PASS_LIMIT) })
    const tasks: HeldTask[] = []
    const pass = await applyTaskRules(
      {
        chats: [
          { id: chat, messages: page.items, kind: await kindOf(store, account, chat), watched: watched.has(chat) },
        ],
      },
      { store: store.tasks, account, categories, dryRun: !yes, onHeld: (task) => tasks.push(task) },
    )
    passes.push({ chat, messages: page.items.length, ...pass, tasks })
  }
  return passes
}
