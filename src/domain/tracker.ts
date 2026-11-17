/**
 * What an issue tracker holds that the store copies (Linear, and any tracker after it): its teams, users, workflow
 * states, labels, projects, issues and the comments on them. Teams, users, states and labels come before the
 * projects and issues that name them.
 */
export const TRACKER_KINDS = ["team", "user", "state", "label", "project", "issue", "comment"] as const
export type TrackerKind = (typeof TRACKER_KINDS)[number]

/** Where an issue in a state stands in its work, whatever the team named the state. */
export const STATE_TYPES = ["triage", "backlog", "unstarted", "started", "completed", "canceled"] as const
export type StateType = (typeof STATE_TYPES)[number]

/**
 * Every record has the tracker's id. A field left out means the tracker did not say, and the store keeps what it
 * held; `null` means the tracker said there is none. Times are epoch milliseconds.
 */
interface TrackerRecord {
  externalId: string
  createdAt?: number | null
  updatedAt?: number | null
  /** The tracker archived it: it still exists, and a read that asks for archived rows lists it. */
  archivedAt?: number | null
}

export interface TrackerTeam extends TrackerRecord {
  name: string
  /** The short key an issue's key starts with: `ENG`. */
  key?: string | null
}

export interface TrackerUser extends TrackerRecord {
  name: string
  /** How the store joins the user to a person it already knows: by this exact address. */
  email?: string | null
  active?: boolean | null
}

export interface TrackerState extends TrackerRecord {
  name: string
  type: StateType
  team?: string | null
  /** Any numbers; the order they give is the board's. */
  position?: number | null
}

export interface TrackerLabel extends TrackerRecord {
  name: string
  team?: string | null
}

export interface TrackerProject extends TrackerRecord {
  name: string
  description?: string | null
  /** The tracker's own word for where the project stands: `planned`, `started`. */
  status?: string | null
  /** A user's id. */
  lead?: string | null
  teams?: string[]
  /** `YYYY-MM-DD`. */
  targetDate?: string | null
  url?: string | null
}

export interface TrackerIssue extends TrackerRecord {
  title: string
  /** The readable key people say: `ENG-12`. */
  key?: string | null
  description?: string | null
  state?: string | null
  team?: string | null
  project?: string | null
  /** Users' ids. */
  assignee?: string | null
  creator?: string | null
  labels?: string[]
  /** The issue this one is a part of. */
  parent?: string | null
  /** 0 is none, then 1 the most urgent: Linear's scale, which a tracker with another one maps onto. */
  priority?: number | null
  /** `YYYY-MM-DD`. */
  dueDate?: string | null
  completedAt?: number | null
  canceledAt?: number | null
  url?: string | null
}

export interface TrackerComment extends TrackerRecord {
  issue: string
  body: string
  /** A user's id; none when an integration wrote it. */
  author?: string | null
  url?: string | null
}

export interface TrackerRecords {
  team: TrackerTeam
  user: TrackerUser
  state: TrackerState
  label: TrackerLabel
  project: TrackerProject
  issue: TrackerIssue
  comment: TrackerComment
}

/** The record's title in lists and search: an issue's title, a comment's start, anything else's name. */
export const trackerTitleOf = <K extends TrackerKind>(kind: K, record: TrackerRecords[K]): string =>
  kind === "issue"
    ? (record as TrackerIssue).title
    : kind === "comment"
      ? (record as TrackerComment).body.split("\n")[0]?.slice(0, 120) || "(comment)"
      : (record as { name: string }).name

/** The record's text that search reads beside its title: a description or a comment's body. */
export const trackerBodyOf = <K extends TrackerKind>(kind: K, record: TrackerRecords[K]): string | null | undefined =>
  kind === "comment"
    ? (record as TrackerComment).body
    : kind === "issue" || kind === "project"
      ? (record as TrackerIssue | TrackerProject).description
      : null

/** The record its row hangs under: a comment's issue, a state's or a label's team. */
export const trackerParentOf = <K extends TrackerKind>(
  kind: K,
  record: TrackerRecords[K],
): string | null | undefined =>
  kind === "comment"
    ? (record as TrackerComment).issue
    : kind === "state" || kind === "label"
      ? (record as TrackerState).team
      : kind === "issue"
        ? (record as TrackerIssue).team
        : null
