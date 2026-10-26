import { CliError, isCliError, singleLine } from "@wirecat/cli-base"
import { type QueryAst, type QueryRegistry, queryFieldsOf, walkQuery } from "@wirecat/cli-base/query"
import type * as v from "valibot"
import { isLocator, parseLocator } from "../domain/locator.js"
import { formatReference } from "../domain/references.js"
import { task as taskEntity } from "../entities/task.js"
import {
  type CloseSuggestion,
  certaintyOf,
  type SimilarTask,
  TASK_RELATION_KINDS,
  type TaskDraft,
  type TaskPair,
  type TaskPairSide,
  type TaskRelation,
  type TaskRelationKind,
} from "../store/index.js"
import type { AccountKey, Author, MessageStore, TaskDetails, ThingLink } from "../store/store.js"
import { type ColumnMap, queryFilter, type Where } from "../store/store.js"
import {
  type ClosedState,
  createTaskService,
  type GroupStats,
  TASK_KINDS,
  TASK_STATES,
  type Task,
  type TaskKind,
  type TaskOrigin,
} from "../tasks/index.js"
import type { ServiceDeps } from "./deps.js"
import { storedChatId } from "./message-resolution.js"
import { categorize, type TaskCategory, taskCategoryOf, type UnlistedCategory } from "./task-categories.js"
import { taskAccount } from "./task-rules.js"
import { taskTagFilters } from "./task-tag-filters.js"

export { TASK_KINDS, TASK_STATES }

/** Source previews are read on demand; task records never retain source text. */
export interface TaskView extends Task {
  message: { senderName: string | null; text: string; timestamp: string } | null
  note?: { id: string; title: string | null; text: string; updatedAt: string } | null
}

export const TASK_QUERY = {
  entity: "task",
  backend: "sql",
  fields: queryFieldsOf(taskEntity, {
    exclude: ["ref", "description", "project", "account", "priority", "parent", "claimed_until", "close_suggestion"],
    relations: {
      close: {
        type: "enum",
        values: ["suggested"],
        example: "close:suggested",
        relation: "an agent's close waits on the owner: tasks close confirms it, tasks reject refuses it",
      },
      tag: { type: "kw", example: "tag:urgent", relation: "a tag put on the task with tags add --task" },
      assignee: {
        type: "kw",
        example: "assignee:any",
        relation: "who does it: any (someone owes it), none, or a person (person:12) — tasks add/plan --assignee",
      },
    },
    examples: {
      key: "key:Q-15",
      category: "category:money",
      kind: "kind:question",
      chat: "chat:12345",
      title: "title:*invoice*",
      source_message: 'source_message:"msg:telegram/1/2/3"',
      claimed_by: "claimed_by:session-1",
    },
  }),
} as const satisfies QueryRegistry

/** Which pairs `tasks duplicates list` lists: those waiting for the reviewing agent, or those it left to the owner. */
export const PAIR_DECISIONS = ["review", "unsure"] as const
export type PairDecision = (typeof PAIR_DECISIONS)[number]

export const TASK_PAIR_QUERY = {
  entity: "task_pair",
  backend: "sql",
  fields: [
    {
      name: "decision",
      type: "enum",
      values: PAIR_DECISIONS,
      operators: ["term"],
      example: "decision:unsure",
      relation: "review waits for the reviewing agent, unsure for the owner",
    },
  ],
  defaults: ["decision:review"],
} as const satisfies QueryRegistry

const TIME = (sql: string) => ({ type: "time", sql }) as const

/** `chat:` names the chat as the messenger does; `groups` holds each name already resolved to its stored id. */
const taskColumns = (groups: ReadonlyMap<string, string>, tags: ReadonlyMap<string, Where>): ColumnMap => ({
  id: { type: "kw", sql: "t.package_id" },
  key: { type: "kw", sql: "t.key" },
  category: { type: "kw", sql: "t.category" },
  tag: { where: (node) => tags.get(node.value) ?? { sql: "0", params: [] } },
  title: { type: "kw", sql: "t.title_folded", folded: true },
  kind: { type: "enum", sql: "t.type" },
  state: { type: "enum", sql: "t.status" },
  origin: { type: "enum", sql: "t.source" },
  chat: {
    where: (node) =>
      node.operator === "wildcard"
        ? { sql: "t.source_group IS NOT NULL", params: [] }
        : { sql: "t.source_group = ?", params: [groups.get(node.value) ?? ""] },
  },
  source_message: { type: "ref", sql: "t.source_locator" },
  // A lapsed claim holds nothing, as tasks claim and the list's own claimed_by read it.
  claimed_by: {
    where: (node) => ({
      sql: `t.claimed_by ${node.operator === "wildcard" ? "GLOB" : "="} ? AND t.claimed_until >= ?`,
      params: [node.value, Date.now()],
    }),
  },
  reason: { type: "kw", sql: "t.close_reason_folded", folded: true },
  close: { where: () => ({ sql: "t.close_suggested_as IS NOT NULL", params: [] }) },
  assignee: {
    where: (node) => {
      const assigned = "SELECT 1 FROM task_assignments a WHERE a.task_id = t.id AND a.role = 'assignee'"
      const value = node.value.trim().toLowerCase()
      if (value === "any") return { sql: `EXISTS (${assigned})`, params: [] }
      if (value === "none") return { sql: `NOT EXISTS (${assigned})`, params: [] }
      const id = /^(?:person:)?(\d+)$/.exec(value)?.[1]
      if (id === undefined)
        throw new CliError("validation_error", `assignee: takes any, none or person:<id>, not "${singleLine(value)}"`)
      return { sql: `EXISTS (${assigned} AND a.assignee_type = 'person' AND a.assignee_id = ?)`, params: [Number(id)] }
    },
  },
  due_at: TIME("t.due_at"),
  closed_at: TIME("t.closed_at"),
  created_at: TIME("t.created_at"),
  updated_at: TIME("t.updated_at"),
})

export type TaskItem = v.InferOutput<typeof taskEntity>

export interface TaskListRequest {
  query?: QueryAst
  limit: number
  offset: number
  /** Each task's message or note preview, for a person's view; never in the answer. */
  previews?: boolean
}

export interface TaskList {
  items: TaskItem[]
  has_more: boolean
  previews?: TaskView[]
}

/**
 * What the owner or an agent adds to a task beyond its source. A description is written, never copied
 * from a message: the message stays a link, so deleting it leaves no copy here.
 */
export interface TaskPlan {
  priority?: number | null
  parent?: string | null
  title?: string
  description?: string | null
  dueAt?: Date | null
  nextCheckAt?: Date | null
  /** A name from the category list; anything else is refused with the list. */
  category?: string
  /**
   * Who does it: `sender` (whoever sent the task's message) or `person:<id>`; replaces the task's assignees, and
   * `null` clears them. A sender the store knows no person for leaves the task unassigned rather than refused.
   */
  assignees?: string[] | null
}

/** What a task may be linked to: what it is about, what shows it, what it came from. */
export const TASK_LINK_KINDS = ["related-to", "evidence", "created-from"] as const
export type TaskLinkKind = (typeof TASK_LINK_KINDS)[number]
/** `tasks link --kind`: a link's kinds, and a `task:` target's relation kinds; `related-to` is both. */
export const TASK_LINK_OPTION_KINDS = [
  ...TASK_LINK_KINDS,
  "blocked-by",
  "follow-up-of",
  "duplicate-of",
  "discovered-from",
] as const
export type TaskLinkOptionKind = (typeof TASK_LINK_OPTION_KINDS)[number]
/**
 * What `tasks add` does when tasks like the new one exist: nothing yet (it refuses and lists them), `attach` links
 * the message to one of them instead, `new` opens the task anyway.
 */
export interface DuplicateChoice {
  attach?: string
  new?: boolean
}

/** How many candidates a refused `tasks add` lists. */
export const REFUSAL_CANDIDATES = 5

export type DuplicateCandidate = Pick<SimilarTask, "ref" | "key" | "title" | "status" | "score" | "band" | "reasons">

/** An owner-project task's id, `task:<id>` written without its prefix, or a project key such as `HRB-12`. */
const BARE_TASK = /^(\d+|[A-Z][A-Z0-9]*-\d+)$/

export interface CloseRequest {
  as?: ClosedState
  reason?: string
  by: TaskOrigin
  /** The agent's name, recorded with its suggestion. */
  agent?: string
  /** 0–1: how sure the agent is that the task needs nothing more. */
  certainty?: number
  /** Under `<PREFIX>_READ_ONLY`: the close waits on the owner whatever the threshold, so the lock closes nothing. */
  suggestOnly?: boolean
}

export interface ClosedTask extends TaskView {
  closeCertainty: number | null
  closeSuggestion: CloseSuggestion | null
}

export interface TaskCard extends TaskDetails {
  links: ThingLink[]
  /** Other tasks' relations that point at this one, so a closed task shows the task that follows it up. */
  linkedFrom: ThingLink[]
}

/** What waits on the owner, kept in the local store by `src/tasks/`; nothing here reaches the messenger. */
export interface TasksService {
  list(request: TaskListRequest): Promise<TaskList>
  /**
   * Tasks of this account that may be the same job as a task, or as a draft not added yet: scored, best first,
   * each with its band and reasons. Reads only; nothing is merged or refused here.
   */
  similar(subject: string | TaskDraft, options?: { limit?: number }): Promise<SimilarTask[]>
  /**
   * Refused (`task.duplicate-candidates`, with the candidates) while an open task is likely or maybe the same job,
   * unless `choice` says to attach the message to one of them or to open the task anyway. A task opened while one
   * closed in the last 14 days is likely or maybe the same job follows it up (`followUpOf`); that one stays closed.
   */
  add(
    message: string,
    type: TaskKind,
    origin: TaskOrigin,
    plan?: TaskPlan,
    choice?: DuplicateChoice,
  ): Promise<{
    task: TaskView
    created: boolean
    attached?: boolean
    review?: number
    /** The task closed in the last 14 days this one follows up; it stays closed. */
    followUpOf?: TaskPairSide
    card?: TaskCard
  }>
  /** Pairs a rule left for review — or, with `unsure`, the ones the reviewing agent passed to the owner — newest first. */
  duplicates(options: { decision: PairDecision; limit: number; offset: number }): Promise<TaskPair[]>
  /** `rejected`: not the same job, never offered again. `unsure`: the owner decides. */
  decideDuplicate(dup: string, task: string, decision: "rejected" | "unsure", by: TaskOrigin): Promise<TaskPair>
  /** Links every message of `dup` to `into` and closes `dup` as its duplicate; `unmerge` undoes it. */
  merge(
    dup: string,
    into: string,
    by: TaskOrigin,
  ): Promise<{ pair: TaskPair; linked: number; review: number; task: TaskCard }>
  unmerge(dup: string, by: TaskOrigin): Promise<{ pair: TaskPair; task: TaskCard }>
  /**
   * An agent states its `certainty`; below the store's threshold, or while agent closes are off, the task stays open
   * with the close waiting on the owner. The owner always closes; `as` left out takes the agent's suggestion.
   */
  close(id: string, options: CloseRequest): Promise<ClosedTask>
  /** The owner refuses an agent's close: the task stays open and the suggestion goes. */
  reject(id: string, by: TaskOrigin): Promise<TaskCard>
  stats(filter?: { chat?: string; type?: TaskKind }): Promise<GroupStats[]>
  /** Title, description, due date and next check; `null` clears one. */
  plan(id: string, plan: TaskPlan, by: TaskOrigin): Promise<TaskCard>
  /**
   * Links a task to stored things (`msg:`, `chat:`, `person:`, `document:`…) or, for what the store does
   * not hold, to the text as written — a URL, a message not saved yet. After a `msg:` target, `review` counts the
   * pairs the duplicate check sent to `tasks duplicates list`.
   */
  link(
    id: string,
    targets: { references?: readonly string[]; chats?: readonly string[] },
    options: { kind: TaskLinkOptionKind; by: TaskOrigin },
  ): Promise<(TaskCard & { review?: number }) | { relations: TaskRelation[] }>
  /** An owner project's task (`HRB-12`) belongs to no messenger account; any other task must be this account's. */
  show(id: string): Promise<TaskCard>
  /** The list a task's category comes from, with what each one means. */
  categories(): Promise<readonly TaskCategory[]>
  /** The shared config file the owner edits the list in. */
  categoriesFile(): Promise<string | undefined>
  /** Categories tasks still carry that the list no longer holds, across the store, with open and total counts. */
  unlistedCategories(): Promise<UnlistedCategory[]>
  /** Takes an open task for `holder` for `forMs`; refused, naming the holder, while someone else holds it. */
  claim(id: string, holder: string, forMs: number): Promise<TaskCard>
  /** Gives a task back; only its holder or the owner may. */
  release(id: string, holder: string): Promise<TaskCard>
}

/** How long a claim lasts when the caller names no time: a crashed agent never holds a task for long. */
export const CLAIM_LEASE_MS = 30 * 60_000

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
export const taskLinkKindOf = oneOf(TASK_LINK_OPTION_KINDS, "link kind", "--kind")
export const taskTypesOf = (typed: string): TaskKind[] => [
  ...new Set(
    typed
      .split(",")
      .filter((one) => one.trim() !== "")
      .map(taskTypeOf),
  ),
]

/** `categories` fixes the list; left out, each call reads the store's, with the shared config file's edits. */
export const tasksService = (deps: ServiceDeps, categories?: readonly TaskCategory[]): TasksService => {
  const listOf = async (store: MessageStore) => categories ?? (await store.tasks.categories())
  const categoryOf = async (store: MessageStore, name: string) => taskCategoryOf(await listOf(store))(name)
  const inStore = async <T>(work: (store: MessageStore, account: AccountKey) => Promise<T>): Promise<T> =>
    work(await deps.store(), await deps.account())
  const service = (store: MessageStore) => createTaskService({ store: store.tasks })

  const groupOf = async (store: MessageStore, account: AccountKey, chat: string | undefined) =>
    chat === undefined ? undefined : storedChatId(deps.messenger, chat, store, account, { includeLeft: true })

  const refuseBare = (target: string): never => {
    throw new CliError(
      "validation_error",
      `no task ${singleLine(target)} — write task:${singleLine(target)} for a task`,
    )
  }
  const owned = async (store: MessageStore, account: AccountKey, id: string): Promise<Task> => {
    const existing = await store.tasks.get(id)
    if (!existing || existing.account !== taskAccount(account))
      throw new CliError("not_found", `no task ${singleLine(id)} for this account — tasks list shows the ids`)
    return existing
  }
  const cardOf = async (store: MessageStore, id: string): Promise<TaskCard> => {
    const details = await store.tasks.details(id)
    const [links, incoming] = await Promise.all([
      store.notes.links({ from: details.ref }),
      store.notes.links({ to: details.ref }),
    ])
    return { ...details, links, linkedFrom: incoming.filter((link) => link.from.startsWith("task:")) }
  }
  const planOf = async (store: MessageStore, id: string, plan: TaskPlan, by: TaskOrigin) => {
    if (plan.category !== undefined) plan = { ...plan, category: await categoryOf(store, plan.category) }
    const open = (await store.tasks.details(id)).status === "open"
    if (!open && (plan.dueAt != null || plan.nextCheckAt != null))
      throw new CliError("validation_error", "a closed task takes no due date or next check; it stays closed")
    const { assignees, ...fields } = plan
    const author = by === "owner" ? "owner" : { bot: by }
    await store.tasks.edit(id, fields, author)
    if (assignees !== undefined) await assign(store, id, assignees, author)
    return cardOf(store, id)
  }
  const assign = async (store: MessageStore, id: string, given: string[] | null, by: Author) => {
    const wanted = new Set<string>()
    for (const one of given ?? []) {
      const who = one.trim()
      if (who === "sender") {
        const sender = await store.tasks.sourceSender(id)
        if (sender) wanted.add(sender)
      } else if (/^person:\d+$/.test(who)) wanted.add(who)
      else throw new CliError("validation_error", `an assignee is sender or person:<id>, not "${singleLine(who)}"`)
    }
    const current = (await store.tasks.details(id)).assignments.filter((one) => one.role === "assignee")
    for (const one of current) if (!wanted.has(one.to)) await store.tasks.unassign(id, one, by)
    for (const to of wanted)
      if (!current.some((one) => one.to === to)) await store.tasks.assign(id, { to, role: "assignee" }, by)
  }
  /**
   * A message linked to a task is read by the comparison, so the task may now look like another one: the pairs go to
   * the review list, never to a merge, and the link stands whatever they score. A closed task is not checked.
   */
  const reviewAfterLink = async (store: MessageStore, id: string): Promise<number> =>
    (await store.tasks.get(id))?.state === "open" ? store.tasks.reviewDuplicates(id, { linked: true }) : 0

  return {
    list: ({ query, limit, offset, previews }) =>
      inStore(async (store, account) => {
        const groups = new Map<string, string>()
        for (const node of query ? walkQuery(query.root) : [])
          if (node.field === "chat" && node.operator !== "wildcard" && !groups.has(node.value))
            groups.set(
              node.value,
              await storedChatId(deps.messenger, node.value, store, account, { includeLeft: true }),
            )
        const tags = await taskTagFilters(store, query)
        const where = query ? queryFilter(query, taskColumns(groups, tags), { command: "tasks list" }) : undefined
        const rows = await store.tasks.query(taskAccount(account), where, { limit: limit + 1, offset })
        const shown = rows.slice(0, limit)
        return {
          items: shown.map((row) => taskItem(account, row)),
          has_more: rows.length > limit,
          ...(previews ? { previews: await Promise.all(shown.map(({ task }) => taskView(store, account, task))) } : {}),
        }
      }),

    add: (message, type, origin, { category: named, ...plan } = {}, choice = {}) =>
      inStore(async (store, account) => {
        const chosen = named === undefined ? undefined : await categoryOf(store, named)
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
        const held = (await store.tasks.findBySource(taskAccount(account), note ? note.ref : source)).find(
          (one) => one.kind === type,
        )
        if (held) return { task: await taskView(store, account, held), created: false }
        if (choice.attach !== undefined && choice.new)
          throw new CliError("validation_error", "choose one: --into <id> or --new")
        const draft = {
          title: plan.title ?? "",
          ...(plan.description === undefined ? {} : { description: plan.description }),
          ...(note ? {} : { source }),
          ...(chosen === undefined ? {} : { category: chosen }),
          ...(plan.dueAt ? { due: plan.dueAt } : {}),
        }
        const subject = { account: taskAccount(account), draft }
        const by = origin === "owner" ? ("owner" as const) : { bot: origin }
        if (choice.attach !== undefined) {
          const target = await owned(store, account, choice.attach)
          const similarity = await store.tasks.compare(subject, target.id)
          const link = {
            from: (await store.tasks.details(target.id)).ref,
            kind: "evidence" as const,
            origin: origin === "owner" ? ("owner" as const) : ("suggested" as const),
          }
          try {
            await store.notes.addLink({ ...link, to: note ? note.ref : source })
          } catch (error) {
            // A message the store has not saved yet is linked by its locator as written.
            if (!(error instanceof CliError && error.code === "not_found" && !note)) throw error
            await store.notes.addLink({ ...link, targetText: source })
          }
          await store.tasks.recordPair({ source, other: target.id, decision: "attached", similarity, by })
          const review = await reviewAfterLink(store, target.id)
          return { task: await taskView(store, account, target), created: false, attached: true, review }
        }
        const candidates = (await store.tasks.similar(subject, { limit: 40 })).filter((one) => one.band !== "different")
        // Only an open task can be the same job still waiting; a closed one makes the new task its follow-up.
        const closedOnes = candidates.some((one) => one.status !== "open")
        if (candidates.some((one) => one.status === "open") && !choice.new) {
          const shown: DuplicateCandidate[] = candidates
            .slice(0, REFUSAL_CANDIDATES)
            .map(({ ref, key, title, status, score, band, reasons }) => ({
              ref,
              key,
              title,
              status,
              score,
              band,
              reasons,
            }))
          throw new CliError(
            "validation_error",
            `${candidates.length === 1 ? "a task" : `${candidates.length} tasks`} may be the same job: ` +
              `${shown.map((one) => `${one.key} (${one.band}, ${one.score}: ${one.reasons.join(", ")})`).join("; ")}` +
              " — link the message to one with --into <id>, or open it anyway with --new" +
              (closedOnes ? ", which links it follow-up-of the closed one" : ""),
            { reason: "task.duplicate-candidates", candidates: shown },
          )
        }
        const sourceText = async () =>
          note
            ? note.text
            : locator
              ? ((await store.messages.message(account, locator.message, { chatId: locator.chat }))?.text ?? "")
              : ""
        const { task: added, created } = await service(store).add({
          source: note ? note.ref : source,
          sourceKind:
            note || account.provider === "notes" ? "note" : account.provider === "email" ? "email" : "message",
          account: taskAccount(account),
          group: note ? note.ref : (locator as ReturnType<typeof parseLocator>).chat,
          kind: type,
          origin,
          ...(plan.dueAt ? { dueAt: plan.dueAt } : {}),
          category: chosen ?? categorize(await sourceText(), await listOf(store)),
        })
        const task = (await store.tasks.get(added.id)) ?? added
        if (created && choice.new)
          for (const one of candidates)
            await store.tasks.recordPair({ task: task.id, other: one.ref, decision: "new", similarity: one, by })
        const followUpOf = created ? await store.tasks.followUp(task.id, candidates, by) : undefined
        const followed = followUpOf ? { followUpOf } : {}
        // A source that already has a task keeps its plan: adding again is not editing.
        if (!created || Object.keys(plan).length === 0)
          return { task: await taskView(store, account, task), created, ...followed }
        const card = await planOf(store, task.id, plan, origin)
        return { task: await taskView(store, account, task), created, ...followed, card }
      }),

    categories: () => inStore(async (store) => listOf(store)),
    unlistedCategories: () => inStore(async (store) => store.tasks.unlistedCategories()),
    categoriesFile: () => inStore(async (store) => store.tasks.categoriesFile()),

    duplicates: ({ decision, limit, offset }) =>
      inStore(async (store, account) => store.tasks.pairs(taskAccount(account), { decision, limit, offset })),

    decideDuplicate: (dup, task, decision, by) =>
      inStore(async (store, account) => {
        await owned(store, account, dup)
        await owned(store, account, task)
        return store.tasks.decidePair(dup, task, decision, by === "owner" ? "owner" : { bot: by })
      }),

    merge: (dup, into, by) =>
      inStore(async (store, account) => {
        await owned(store, account, dup)
        await owned(store, account, into)
        const merged = await store.tasks.merge(dup, into, by === "owner" ? "owner" : { bot: by })
        const review = await reviewAfterLink(store, into)
        return { ...merged, review, task: await cardOf(store, into) }
      }),

    unmerge: (dup, by) =>
      inStore(async (store, account) => {
        await owned(store, account, dup)
        const { pair } = await store.tasks.unmerge(dup, by === "owner" ? "owner" : { bot: by })
        return { pair, task: await cardOf(store, dup) }
      }),

    // A project task belongs to no messenger account, as show reads it.
    claim: async (id, holder, forMs) => {
      const store = await deps.store()
      if (!(await store.tasks.projectTask(id))) await owned(store, await deps.account(), id)
      await store.tasks.claim(id, holder, new Date(Date.now() + forMs))
      return cardOf(store, id)
    },

    release: async (id, holder) => {
      const store = await deps.store()
      if (!(await store.tasks.projectTask(id))) await owned(store, await deps.account(), id)
      await store.tasks.release(id, holder)
      return cardOf(store, id)
    },

    close: (id, { as, reason, by, agent, certainty, suggestOnly }) =>
      inStore(async (store, account) => {
        const existing = await owned(store, account, id)
        const suggested = existing.state === "open" ? await store.tasks.closeSuggestion(id) : null
        const state = as ?? (by === "owner" ? suggested?.as : undefined)
        if (state === undefined)
          throw new CliError("validation_error", "say how the task is closed: --as done, or --as dismissed")
        if (certainty !== undefined) certaintyOf(certainty)
        const closedView = async (task: Task): Promise<ClosedTask> => {
          const { closeCertainty, closeSuggestion } = await store.tasks.details(task.id)
          return { ...(await taskView(store, account, task)), closeCertainty, closeSuggestion }
        }
        if (by === "agent" && existing.state === "open") {
          if (certainty === undefined)
            throw new CliError(
              "validation_error",
              "an agent closes a task with its certainty, 0 to 1: how sure it is the task needs nothing more",
              { reason: "task.certainty-required" },
            )
          const { allowed, min } = await store.tasks.agentClose()
          if (suggestOnly || !allowed || certainty < min) {
            const suggestion = { as: state, certainty, ...(reason === undefined ? {} : { reason }) }
            await store.tasks.suggestClose(id, suggestion, { bot: agent ?? "agent" })
            return closedView((await store.tasks.get(id)) ?? existing)
          }
        }
        const why = reason ?? (suggested?.as === state ? (suggested.reason ?? undefined) : undefined)
        try {
          const closed = await service(store).close(id, {
            as: state,
            by,
            ...(why === undefined ? {} : { reason: why }),
          })
          if (by === "agent" && certainty !== undefined) await store.tasks.recordCloseCertainty(id, certainty)
          return closedView(closed)
        } catch (error) {
          if (isCliError(error) && error.details.reason === "task.closed")
            throw new CliError("validation_error", `${error.message}; a closed task stays closed`, {
              reason: "task.closed",
            })
          throw error
        }
      }),

    reject: (id, by) =>
      inStore(async (store, account) => {
        if (by !== "owner")
          throw new CliError("permission_error", "only the owner rejects an agent's close; the agent may close again")
        await owned(store, account, id)
        await store.tasks.suggestClose(id, null, "owner")
        return cardOf(store, id)
      }),

    plan: async (id, plan, by) => {
      const store = await deps.store()
      if (!(await store.tasks.projectTask(id))) await owned(store, await deps.account(), id)
      return planOf(store, id, plan, by)
    },

    link: async (id, { references = [], chats = [] }, { kind, by }) => {
      const written = references.map((one) => one.trim()).filter(Boolean)
      const relationKind = (TASK_RELATION_KINDS as readonly string[]).includes(kind)
      const store = await deps.store()
      // A bare id with a kind only tasks have is a task; with related-to only when that task exists.
      const asTask = async (target: string) =>
        target.startsWith("task:")
          ? target
          : BARE_TASK.test(target) && relationKind
            ? kind !== "related-to" ||
              (await store.tasks.taskRelations(target).then(
                () => true,
                () => false,
              ))
              ? `task:${target}`
              : refuseBare(target)
            : undefined
      const tasks = (await Promise.all(written.map(asTask))).filter((one): one is string => one !== undefined)
      if (tasks.length > 0) {
        if (tasks.length !== written.length || chats.length > 0)
          throw new CliError(
            "validation_error",
            "a task: target links two tasks; link messages, chats, people and URLs in a call of their own",
          )
        if (!relationKind)
          throw new CliError("validation_error", `a task: target takes --kind ${TASK_RELATION_KINDS.join(", ")}`)
        if (by !== "owner")
          throw new CliError("permission_error", "an agent proposes task relationships; only the owner applies them")
        for (const target of tasks) await store.tasks.linkTask(id, target, kind as TaskRelationKind, "owner")
        return { relations: await store.tasks.taskRelations(id) }
      }
      if (!(TASK_LINK_KINDS as readonly string[]).includes(kind))
        throw new CliError(
          "validation_error",
          `--kind ${kind} is for a task: target; a link takes related-to, evidence or created-from`,
        )
      return inStore(async (store, account) => {
        await owned(store, account, id)
        const from = (await store.tasks.details(id)).ref
        const chatRefs = await Promise.all(
          chats.map(async (chat) =>
            formatReference({
              type: "chat",
              provider: account.provider,
              account: account.account,
              chat: await storedChatId(deps.messenger, chat, store, account, { includeLeft: true }),
            }),
          ),
        )
        const origin = by === "owner" ? "owner" : "suggested"
        for (const target of [...written, ...chatRefs]) {
          try {
            await store.notes.addLink({ from, to: target, kind: kind as TaskLinkKind, origin })
          } catch (error) {
            // Only text that names nothing typed, or a message not saved yet; a mistyped `person:9` is refused.
            const unsaved = error instanceof CliError && error.code === "not_found" && target.startsWith("msg:")
            if (!unsaved && !(error instanceof CliError && error.code === "validation_error")) throw error
            await store.notes.addLink({ from, targetText: target, kind: kind as TaskLinkKind, origin })
          }
        }
        if (!written.some((target) => target.startsWith("msg:"))) return cardOf(store, id)
        const review = await reviewAfterLink(store, id)
        return { ...(await cardOf(store, id)), review }
      })
    },

    show: async (id) => {
      const store = await deps.store()
      if (!(await store.tasks.projectTask(id))) await owned(store, await deps.account(), id)
      return cardOf(store, id)
    },

    similar: (subject, { limit } = {}) =>
      inStore(async (store, account) => {
        const options = limit === undefined ? {} : { limit }
        if (typeof subject !== "string")
          return store.tasks.similar({ account: taskAccount(account), draft: subject }, options)
        await owned(store, account, subject)
        return store.tasks.similar({ task: subject }, options)
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

const iso = (at: Date | undefined) => (at === undefined ? null : at.toISOString())

/** A stored task as the `task` entity: its chat as a `chat:` reference, its times in ISO 8601. */
export const taskItem = (
  account: AccountKey,
  {
    task,
    title,
    updatedAt,
    closeSuggestion = null,
  }: { task: Task; title: string; updatedAt: Date; closeSuggestion?: CloseSuggestion | null },
): TaskItem => ({
  ref: `task:${task.id}`,
  id: task.id,
  key: task.key ?? null,
  title,
  kind: task.kind,
  state: task.state,
  origin: task.origin,
  account: task.account,
  chat:
    task.sourceKind === "note"
      ? null
      : formatReference({ type: "chat", provider: account.provider, account: account.account, chat: task.group }),
  source_message: task.source,
  due_at: iso(task.dueAt),
  closed_at: iso(task.closedAt),
  ...(task.reason === undefined ? {} : { reason: task.reason }),
  category: task.category ?? null,
  ...claimItem(task),
  close_suggestion: closeSuggestion,
  created_at: task.createdAt.toISOString(),
  updated_at: updatedAt.toISOString(),
})

/** A lapsed claim reads as none. */
const claimItem = ({ claimedBy, claimedUntil }: Task) =>
  claimedBy !== undefined && claimedUntil !== undefined && claimedUntil.getTime() >= Date.now()
    ? { claimed_by: claimedBy, claimed_until: claimedUntil.toISOString() }
    : { claimed_by: null, claimed_until: null }

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
  const found = locator ? await store.messages.message(account, locator.message, { chatId: locator.chat }) : undefined
  return {
    ...task,
    message: found
      ? { senderName: found.senderName, text: found.text.slice(0, PREVIEW), timestamp: found.timestamp }
      : null,
  }
}
