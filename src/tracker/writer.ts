import type { TrackerComment, TrackerIssue } from "../domain/tracker.js"
import type { PermissionKey } from "../sends/permissions.js"

export const TRACKER_WRITES = ["create", "update", "comment"] as const
export type TrackerWrite = (typeof TRACKER_WRITES)[number]

/** An issue's fields in `TrackerIssue`'s names, each a reference by the tracker's own id; `null` clears one. */
export interface TrackerIssueFields {
  title?: string
  description?: string | null
  team?: string
  state?: string | null
  assignee?: string | null
  /** 0 is none, then 1 the most urgent, as `TrackerIssue` keeps it. */
  priority?: number | null
  /** Replaces the whole list. */
  labels?: string[]
  project?: string | null
  parent?: string | null
}

export type TrackerIssueDraft = TrackerIssueFields & { title: string }

export interface TrackerWriteOptions {
  /** Journaled before the call. */
  operationId: string
  /**
   * The keys the owner was asked about for this write, those at level `ask`: a writer over the `api` group does not
   * ask them again.
   */
  confirmed?: readonly PermissionKey[]
}

/**
 * Writes to one tracker account. Each answers the whole record as the tracker holds it after the write, which the store
 * saves as a sync would. None of them retries: a write whose answer was lost throws `outcome_unknown`.
 */
export interface TrackerWriter {
  readonly provider: string
  /** What this tracker takes: `issues create`, `issues update` and `issues comment` are mounted for these. */
  readonly writes: readonly TrackerWrite[]
  createIssue(draft: TrackerIssueDraft, options: TrackerWriteOptions): Promise<TrackerIssue>
  updateIssue(externalId: string, patch: TrackerIssueFields, options: TrackerWriteOptions): Promise<TrackerIssue>
  /** A comment on the issue by its tracker id; the body is the owner's text, sent as typed. */
  comment(issue: string, body: string, options: TrackerWriteOptions): Promise<TrackerComment>
}

/** Each write's key: its command path. */
export const TRACKER_WRITE_KEYS: Readonly<Record<TrackerWrite, PermissionKey>> = {
  create: "issues.create",
  update: "issues.update",
  comment: "issues.comment",
}
