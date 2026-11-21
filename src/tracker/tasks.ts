import { CliError } from "@wirecat/cli-base"
import type { StateType, TrackerIssue } from "../domain/tracker.js"
import { taskAccount } from "../services/task-rules.js"
import type { MessageStore } from "../store/store.js"
import type { AccountKey } from "../store/types.js"
import { type ClosedState, createTaskService, isClosedState, type Task, type TaskOrigin } from "../tasks/index.js"

export const TRACKER_ISSUE_TASK = "tracker_issue"

/** The task's locator: the issue in the tracker's copy. */
export const trackerIssueSource = (externalId: string): string => `tracker:issue/${externalId}`

/** A task's title is at most this long; the store refuses a longer one on edit. */
const MOST_TITLE = 300
const OPEN_TYPES: readonly StateType[] = ["triage", "backlog", "unstarted", "started"]
const PAGE = 500
const SYNC = { bot: "rule", kind: "rule" } as const

/** `ENG-12 Fix login`: the key people say, then the issue's title as the last sync copied it. */
export const trackerIssueTitle = (issue: TrackerIssue): string =>
  [issue.key, issue.title]
    .map((part) => part?.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join(" ")
    .slice(0, MOST_TITLE)
    .trim() || issue.externalId

const serviceOf = (store: MessageStore, now: number) => {
  const { reviewDuplicates: _review, ...tasks } = store.tasks
  return createTaskService({ store: tasks, now: () => new Date(now) })
}

const addIssueTask = (
  store: MessageStore,
  account: AccountKey,
  issue: TrackerIssue,
  origin: TaskOrigin,
  now: number,
  dueAt?: Date,
) =>
  serviceOf(store, now).add({
    source: trackerIssueSource(issue.externalId),
    sourceKind: TRACKER_ISSUE_TASK,
    account: taskAccount(account),
    group: trackerIssueSource(issue.externalId),
    kind: "request",
    origin,
    title: trackerIssueTitle(issue),
    ...(dueAt ? { dueAt } : {}),
  })

/**
 * Makes an issue the owner's task: the task points at the issue and carries its key and title, which each sync keeps
 * current. The same issue twice, or one a sync already made a task of, answers the task it already has.
 */
export const trackerIssueTask = async (
  store: MessageStore,
  account: AccountKey,
  issue: string,
  { dueAt, now = Date.now() }: { dueAt?: Date; now?: number } = {},
): Promise<{ task: Task; created: boolean }> => {
  const found = (await store.tracker.get(account, "issue", issue)) ?? (await store.tracker.issueByKey(account, issue))
  if (!found || found.deletedAt !== null)
    throw new CliError("not_found", `no issue ${issue} in the copy of ${account.provider}; run sync, then try again`)
  const { task, created } = await addIssueTask(store, account, found.record, "owner", now, dueAt)
  return { task, created }
}

/** What a sync did to the owner's tasks from issues assigned to the signed-in user. */
export interface TrackerTaskChanges {
  opened: number
  closed: number
  reopened: number
  renamed: number
}

type Why = "completed" | "canceled" | "deleted" | "archived" | "reassigned" | "unassigned"

const closing: Record<Why, { as: ClosedState; reason: (provider: string) => string }> = {
  completed: { as: "done", reason: (provider) => `the issue was completed in ${provider}` },
  canceled: { as: "dismissed", reason: (provider) => `the issue was canceled in ${provider}` },
  deleted: { as: "dismissed", reason: (provider) => `the issue was deleted in ${provider}` },
  archived: { as: "dismissed", reason: (provider) => `the issue was archived in ${provider}` },
  reassigned: { as: "dismissed", reason: (provider) => `the issue was assigned to someone else in ${provider}` },
  unassigned: { as: "dismissed", reason: (provider) => `the issue was unassigned in ${provider}` },
}

/** The owner opened the task again after a sync closed it: the owner's call wins over the issue's state. */
const ownerReopened = async (store: MessageStore, id: string) => {
  const statuses = (await store.tasks.events(id)).filter((event) => event.kind === "status")
  const [closed, opened] = statuses.slice(-2)
  return (
    closed?.actor?.type === "bot" &&
    opened !== undefined &&
    opened.actor?.type !== "bot" &&
    !isClosedState(String(opened.changes?.status?.[1]))
  )
}

/**
 * Brings the owner's tasks in line with the tracker's copy, after a sync: each live issue assigned to `self` whose
 * state is open work becomes a task, and every task from an issue takes the issue's current title. A task closes when
 * its issue is completed, canceled, archived or deleted, and a task the sync made also when the issue goes to someone
 * else; `issues assign` picks an issue whoever holds it. A task the sync closed opens again once its issue is open
 * work again (and, for one the sync made, assigned to `self` again); one the owner closed stays closed, as a dismissed
 * task does. Nothing is written to the tracker.
 */
export const syncTrackerTasks = async (
  store: MessageStore,
  account: AccountKey,
  self: string,
  { now = Date.now() }: { now?: number } = {},
): Promise<TrackerTaskChanges> => {
  const changes: TrackerTaskChanges = { opened: 0, closed: 0, reopened: 0, renamed: 0 }
  for (let offset = 0; ; offset += PAGE) {
    const { items, hasMore } = await store.tracker.list(account, "issue", {
      assignee: self,
      stateTypes: OPEN_TYPES,
      limit: PAGE,
      offset,
    })
    for (const { record } of items)
      if ((await addIssueTask(store, account, record, "rule", now)).created) changes.opened += 1
    if (!hasMore) break
  }

  const reasons = new Set(Object.values(closing).map(({ reason }) => reason(account.provider)))
  const where = { sql: "t.source_kind = ?", params: [TRACKER_ISSUE_TASK] }
  let tasks: { task: Task; title: string }[] = []
  for (let offset = 0; ; offset += PAGE) {
    const page = await store.tasks.query(taskAccount(account), where, { limit: PAGE, offset })
    tasks = tasks.concat(page)
    if (page.length < PAGE) break
  }
  const states = new Map<string, StateType | undefined>()
  const typeOf = async (state: string | null | undefined) => {
    if (!state) return undefined
    if (!states.has(state)) states.set(state, (await store.tracker.get(account, "state", state))?.record.type)
    return states.get(state)
  }
  for (const { task, title } of tasks) {
    const found = await store.tracker.get(account, "issue", task.source.slice("tracker:issue/".length))
    const issue = found?.record
    const type = await typeOf(issue?.state)
    const why: Why | undefined =
      !found || found.deletedAt !== null
        ? "deleted"
        : issue?.archivedAt
          ? "archived"
          : type === "completed" || type === "canceled"
            ? type
            : task.origin === "rule" && issue?.assignee !== self
              ? issue?.assignee
                ? "reassigned"
                : "unassigned"
              : undefined
    const closed = isClosedState(task.state)
    const reopen =
      closed &&
      why === undefined &&
      type !== undefined &&
      OPEN_TYPES.includes(type) &&
      task.closedBy === "rule" &&
      reasons.has(task.reason ?? "")
    const named = issue ? trackerIssueTitle(issue) : title
    if (!closed && why !== undefined && !(await ownerReopened(store, task.id))) {
      const { as, reason } = closing[why]
      await serviceOf(store, now).close(task.id, { as, by: "rule", reason: reason(account.provider) })
      changes.closed += 1
    }
    if (reopen || named !== title)
      await store.tasks.edit(
        task.id,
        { ...(named === title ? {} : { title: named }), ...(reopen ? { status: "open" } : {}) },
        SYNC,
      )
    if (reopen) changes.reopened += 1
    if (named !== title) changes.renamed += 1
  }
  return changes
}
