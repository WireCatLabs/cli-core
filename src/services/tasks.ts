import { CliError, singleLine } from "@wirecat/cli-base"
import { isLocator, parseLocator } from "../domain/locator.js"
import { formatReference } from "../domain/references.js"
import type { AccountKey, MessageStore, TaskDetails, ThingLink } from "../store/store.js"
import {
  type ClosedState,
  createTaskService,
  type GroupStats,
  TASK_KINDS,
  TASK_STATES,
  type Task,
  type TaskKind,
  type TaskOrigin,
  type TaskState,
} from "../tasks/index.js"
import type { ServiceDeps } from "./deps.js"
import { storedChatId } from "./messages.js"
import { taskAccount } from "./task-rules.js"

export { TASK_KINDS, TASK_STATES }

/** Source previews are read on demand; task records never retain source text. */
export interface TaskView extends Task {
  message: { senderName: string | null; text: string; timestamp: string } | null
  note?: { id: string; title: string | null; text: string; updatedAt: string } | null
}

export interface TaskListFilter {
  state?: TaskState
  chat?: string
  types?: readonly TaskKind[]
  /** ms: only tasks opened before it. */
  before?: number
  limit?: number
}

/**
 * What the owner or an agent adds to a task beyond its source. A description is written, never copied
 * from a message: the message stays a link, so deleting it leaves no copy here.
 */
export interface TaskPlan {
  title?: string
  description?: string | null
  dueAt?: Date | null
  nextCheckAt?: Date | null
}

/** What a task may be linked to: what it is about, what shows it, what it came from. */
export const TASK_LINK_KINDS = ["related-to", "evidence", "created-from"] as const
export type TaskLinkKind = (typeof TASK_LINK_KINDS)[number]

export interface TaskCard extends TaskDetails {
  links: ThingLink[]
}

/** What waits on the owner, kept in the local store by `src/tasks/`; nothing here reaches the messenger. */
export interface TasksService {
  list(filter?: TaskListFilter): Promise<TaskView[]>
  add(
    message: string,
    type: TaskKind,
    origin: TaskOrigin,
    plan?: TaskPlan,
  ): Promise<{ task: TaskView; created: boolean; card?: TaskCard }>
  close(id: string, options: { as: ClosedState; reason?: string; by: TaskOrigin }): Promise<TaskView>
  stats(filter?: { chat?: string; type?: TaskKind }): Promise<GroupStats[]>
  /** Title, description, due date and next check; `null` clears one. */
  plan(id: string, plan: TaskPlan, by: TaskOrigin): Promise<TaskCard>
  /**
   * Links a task to stored things (`msg:`, `chat:`, `person:`, `document:`…) or, for what the store does
   * not hold, to the text as written — a URL, a message not saved yet.
   */
  link(
    id: string,
    targets: { references?: readonly string[]; chats?: readonly string[] },
    options: { kind: TaskLinkKind; by: TaskOrigin },
  ): Promise<TaskCard>
  show(id: string): Promise<TaskCard>
}

export const PREVIEW = 200

const oneOf =
  <T extends string>(values: readonly T[], name: string, flag: string) =>
  (typed: string) => {
    const value = typed.trim().toLowerCase()
    if ((values as readonly string[]).includes(value)) return value as T
    throw new CliError(
      "validation_error",
      `${flag} takes ${values.join(", ")} — not "${singleLine(typed)}" as a ${name}`,
    )
  }

export const taskTypeOf = oneOf(TASK_KINDS, "task type", "--type")
export const taskStateOf = oneOf(TASK_STATES, "task state", "--state")
export const closedStateOf = oneOf(["done", "dismissed"] as const, "way to close a task", "--as")
export const taskLinkKindOf = oneOf(TASK_LINK_KINDS, "link kind", "--kind")
export const taskTypesOf = (typed: string): TaskKind[] => [
  ...new Set(
    typed
      .split(",")
      .filter((one) => one.trim() !== "")
      .map(taskTypeOf),
  ),
]

export const tasksService = (deps: ServiceDeps): TasksService => {
  const inStore = async <T>(work: (store: MessageStore, account: AccountKey) => Promise<T>): Promise<T> =>
    work(await deps.store(), await deps.account())
  const service = (store: MessageStore) => createTaskService({ store: store.tasks })

  const groupOf = async (store: MessageStore, account: AccountKey, chat: string | undefined) =>
    chat === undefined ? undefined : storedChatId(deps.messenger, chat, store, account)

  const owned = async (store: MessageStore, account: AccountKey, id: string): Promise<Task> => {
    const existing = await store.tasks.get(id)
    if (!existing || existing.account !== taskAccount(account))
      throw new CliError("not_found", `no task ${singleLine(id)} for this account — tasks list shows the ids`)
    return existing
  }
  const cardOf = async (store: MessageStore, id: string): Promise<TaskCard> => {
    const details = await store.tasks.details(id)
    return { ...details, links: await store.notes.links({ from: details.ref }) }
  }
  const planOf = async (store: MessageStore, id: string, plan: TaskPlan, by: TaskOrigin) => {
    const open = (await store.tasks.get(id))?.state === "open"
    if (!open && (plan.dueAt != null || plan.nextCheckAt != null))
      throw new CliError("validation_error", "a closed task takes no due date or next check; it stays closed")
    await store.tasks.edit(id, plan, by === "owner" ? "owner" : { bot: by })
    return cardOf(store, id)
  }

  return {
    list: (filter = {}) =>
      inStore(async (store, account) => {
        const group = await groupOf(store, account, filter.chat)
        const found = await service(store).list({
          account: taskAccount(account),
          ...(filter.state === undefined ? {} : { state: filter.state }),
          ...(group === undefined ? {} : { group }),
          ...(filter.before === undefined ? {} : { createdBefore: new Date(filter.before) }),
        })
        const typed = filter.types?.length ? found.filter((task) => filter.types?.includes(task.kind)) : found
        const shown = filter.limit === undefined ? typed : typed.slice(0, filter.limit)
        return Promise.all(shown.map((task) => taskView(store, account, task)))
      }),

    add: (message, type, origin, plan = {}) =>
      inStore(async (store, account) => {
        const source = message.trim()
        const native = isNoteReference(source)
        if (!native && !isLocator(source)) {
          throw new CliError(
            "validation_error",
            `"${singleLine(source)}" is not a message locator or note reference — give msg:<provider>/<account>/<chat>/<message>, note:<id> or document:<id>`,
          )
        }
        const locator = native ? undefined : parseLocator(source)
        if (locator && (locator.provider !== account.provider || locator.account !== account.account))
          throw new CliError("validation_error", "that locator belongs to another account; select its profile first")
        const note = native || locator?.provider === "notes" ? await store.notes.resolveNote(source) : undefined
        if ((native || locator?.provider === "notes") && !note)
          throw new CliError("not_found", "the task source note is unavailable or deleted")
        if (note && note.deletedAt !== null)
          throw new CliError("not_found", "the task source note is unavailable or deleted")
        if (note) {
          for (const reference of await store.notes.noteReferences(note.ref)) {
            const existing = (await store.tasks.findBySource(taskAccount(account), reference)).find(
              (task) => origin === "rule" || task.kind === type,
            )
            if (existing) return { task: await taskView(store, account, existing), created: false }
          }
        }
        const { task, created } = await service(store).add({
          source: note ? note.ref : source,
          sourceKind:
            note || account.provider === "notes" ? "note" : account.provider === "email" ? "email" : "message",
          account: taskAccount(account),
          group: note ? note.ref : (locator as ReturnType<typeof parseLocator>).chat,
          kind: type,
          origin,
          ...(plan.dueAt ? { dueAt: plan.dueAt } : {}),
        })
        // A source that already has a task keeps its plan: adding again is not editing.
        if (!created || Object.keys(plan).length === 0) return { task: await taskView(store, account, task), created }
        const card = await planOf(store, task.id, plan, origin)
        return { task: await taskView(store, account, task), created, card }
      }),

    close: (id, { as, reason, by }) =>
      inStore(async (store, account) => {
        const existing = await store.tasks.get(id)
        if (!existing || existing.account !== taskAccount(account))
          throw new CliError("not_found", `no task ${singleLine(id)} for this account — tasks list shows the ids`)
        try {
          const closed = await service(store).close(id, { as, by, ...(reason === undefined ? {} : { reason }) })
          return taskView(store, account, closed)
        } catch (error) {
          if (error instanceof Error && "code" in error && error.code === "closed")
            throw new CliError("validation_error", `${error.message}; a closed task stays closed`)
          throw error
        }
      }),

    plan: (id, plan, by) =>
      inStore(async (store, account) => {
        await owned(store, account, id)
        return planOf(store, id, plan, by)
      }),

    link: (id, { references = [], chats = [] }, { kind, by }) =>
      inStore(async (store, account) => {
        await owned(store, account, id)
        const from = (await store.tasks.details(id)).ref
        const chatRefs = await Promise.all(
          chats.map(async (chat) =>
            formatReference({
              type: "chat",
              provider: account.provider,
              account: account.account,
              chat: await storedChatId(deps.messenger, chat, store, account),
            }),
          ),
        )
        const origin = by === "owner" ? "owner" : "suggested"
        for (const target of [...references.map((one) => one.trim()), ...chatRefs]) {
          if (!target) continue
          try {
            await store.notes.addLink({ from, to: target, kind, origin })
          } catch (error) {
            // Only text that names nothing typed, or a message not saved yet; a mistyped `person:9` is refused.
            const unsaved = error instanceof CliError && error.code === "not_found" && target.startsWith("msg:")
            if (!unsaved && !(error instanceof CliError && error.code === "validation_error")) throw error
            await store.notes.addLink({ from, targetText: target, kind, origin })
          }
        }
        return cardOf(store, id)
      }),

    show: (id) =>
      inStore(async (store, account) => {
        await owned(store, account, id)
        return cardOf(store, id)
      }),

    stats: (filter = {}) =>
      inStore(async (store, account) => {
        const group = await groupOf(store, account, filter.chat)
        const rows = await service(store).stats({
          account: taskAccount(account),
          ...(filter.type === undefined ? {} : { kind: filter.type }),
        })
        return group === undefined ? rows : rows.filter((one) => one.group === group)
      }),
  }
}

/** A file in a notes folder is a `document:`, a written note a `note:`. */
const isNoteReference = (source: string) => source.startsWith("note:") || source.startsWith("document:")

export const taskView = async (store: MessageStore, account: AccountKey, task: Task): Promise<TaskView> => {
  if (task.account !== taskAccount(account)) throw new CliError("not_found", "the task belongs to another account")
  const native = isNoteReference(task.source)
  if (!native && !isLocator(task.source)) return { ...task, message: null }
  const locator = native ? undefined : parseLocator(task.source)
  if (locator && (locator.provider !== account.provider || locator.account !== account.account))
    return { ...task, message: null }
  if (native || locator?.provider === "notes") {
    const note = await store.notes.resolveNote(task.source)
    return {
      ...task,
      message: null,
      note:
        note && note.deletedAt === null
          ? { id: note.id, title: note.title, text: note.text.slice(0, PREVIEW), updatedAt: note.updatedAt }
          : null,
    }
  }
  const found = locator ? await store.message(account, locator.message, { chatId: locator.chat }) : undefined
  return {
    ...task,
    message: found
      ? { senderName: found.senderName, text: found.text.slice(0, PREVIEW), timestamp: found.timestamp }
      : null,
  }
}
