import { CliError } from "@wirecat/cli-base"
import { taskAccount } from "../services/task-rules.js"
import type { MessageStore } from "../store/store.js"
import type { AccountKey } from "../store/types.js"
import { createTaskService, type Task } from "../tasks/index.js"

export const TRACKER_ISSUE_TASK = "tracker_issue"

/** The task's locator: the issue in the tracker's copy, resolved when the task is read. */
export const trackerIssueSource = (externalId: string): string => `tracker:issue/${externalId}`

/**
 * Makes an issue the owner's task: the task points at the issue and keeps only its readable key as a title, so the
 * issue's text stays in the tracker's copy and a sync that changes it changes what the task shows. The same issue
 * twice answers the task it already has.
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
  const { externalId, key } = found.record
  const { reviewDuplicates: _review, ...tasks } = store.tasks
  const { task, created } = await createTaskService({ store: tasks, now: () => new Date(now) }).add({
    source: trackerIssueSource(externalId),
    sourceKind: TRACKER_ISSUE_TASK,
    account: taskAccount(account),
    group: trackerIssueSource(externalId),
    kind: "request",
    origin: "owner",
    title: key ?? externalId,
    ...(dueAt ? { dueAt } : {}),
  })
  return { task, created }
}
