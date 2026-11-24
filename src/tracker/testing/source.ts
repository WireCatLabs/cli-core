import { CliError } from "@wirecat/cli-base"
import type { TrackerKind, TrackerRecords } from "../../domain/tracker.js"
import type { TrackerCallContext, TrackerChanges, TrackerIdPage, TrackerSource } from "../source.js"
import { TRACKER_WRITES, type TrackerIssueFields, type TrackerWrite, type TrackerWriter } from "../writer.js"

const OVERLAP_MS = 10 * 60_000

export type FakeTrackerRows = { [K in TrackerKind]?: TrackerRecords[K][] }

export interface FakeTrackerSourceOptions {
  rows: FakeTrackerRows
  /** The tracker's own clock, which stamps `updatedAt`; this computer's is `skew` off it. */
  clock?: () => number
  skew?: number
  /** Rows on one page. */
  pageSize?: number
  provider?: string
  /** The signed-in user's id, which `self()` answers; absent, the tracker cannot say. */
  self?: string
}

export interface FakeTrackerSource extends TrackerSource, TrackerWriter {
  /** Each write that reached the tracker, in order. */
  sent: { write: TrackerWrite; id: string }[]
  /** The next write is made, and its answer lost, as a dropped connection does. */
  loseNextAnswer(): void
  /** Changes one row on the tracker's side: it gets a new `updatedAt`. */
  touch(kind: TrackerKind, externalId: string): void
  archive(kind: TrackerKind, externalId: string): void
  /** Deletes one row outright, as only an id pass finds. */
  remove(kind: TrackerKind, externalId: string): void
  /**
   * Moves one row to the trash, as Linear does: still listed, archived and `deleted`, with its `updatedAt` as it was,
   * so a change read misses it and only a full list or an id pass, which leaves it out, finds it.
   */
  trash(kind: TrackerKind, externalId: string): void
  /** The same tracker, read from a computer whose clock is `ms` off. */
  skewed(ms: number): FakeTrackerSource
}

/**
 * A tracker in memory, read the way a GraphQL tracker is: changes by `updatedAt` from the cursor less an overlap, pages
 * by offset, archived rows listed with their mark, deletions only by their absence from `ids()`. One call reads one
 * page, so it never spends from the run's budget itself.
 */
export const fakeTrackerSource = (options: FakeTrackerSourceOptions): FakeTrackerSource => {
  let tick = 0
  const clock = options.clock ?? (() => Date.UTC(2026, 10, 17) + tick++ * 1000)
  const rows = options.rows
  const size = options.pageSize ?? 2
  const listOf = <K extends TrackerKind>(kind: K): TrackerRecords[K][] => (rows[kind] ?? []) as TrackerRecords[K][]
  const find = (kind: TrackerKind, externalId: string) => {
    const found = listOf(kind).find((one) => one.externalId === externalId)
    if (!found) throw new Error(`the fake tracker has no ${kind} ${externalId}`)
    return found
  }
  const self = options.self
  const sent: FakeTrackerSource["sent"] = []
  let lose = false
  const made = (write: TrackerWrite, id: string) => {
    sent.push({ write, id })
    if (!lose) return
    lose = false
    throw new CliError("outcome_unknown", "the connection dropped after the tracker got the write")
  }
  const apply = (issue: TrackerRecords["issue"], fields: TrackerIssueFields) => {
    for (const [field, value] of Object.entries(fields))
      if (value !== undefined) Object.assign(issue, { [field]: value })
    issue.updatedAt = clock()
    return { ...issue }
  }
  const make = (skew: number): FakeTrackerSource => ({
    provider: options.provider ?? "fake-tracker",
    traits: { kinds: (Object.keys(rows) as TrackerKind[]).filter((kind) => listOf(kind).length > 0) },
    ...(self === undefined ? {} : { self: async () => self }),
    async changes<K extends TrackerKind>(
      kind: K,
      cursor: string | null,
      page?: string,
      _context?: TrackerCallContext,
    ): Promise<TrackerChanges<TrackerRecords[K]>> {
      const since = cursor === null ? null : Date.parse(cursor)
      if (since !== null && Number.isNaN(since)) return { reset: true }
      const [offsetText, startedText] = (page ?? "").split("@")
      const offset = page === undefined ? 0 : Number(offsetText)
      const started = page === undefined ? clock() + skew : Number(startedText)
      if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(started))
        throw new CliError("validation_error", `not a page of the fake tracker: ${page}`)
      const listed = listOf(kind)
        .filter((one) => since === null || (one.updatedAt ?? 0) >= since - OVERLAP_MS)
        .sort((a, b) => (a.updatedAt ?? 0) - (b.updatedAt ?? 0) || a.externalId.localeCompare(b.externalId))
      const items = listed.slice(offset, offset + size).map((one) => ({ ...one }))
      const next = offset + size
      return next < listed.length
        ? { items, hasMore: true, nextCursor: `${next}@${started}` }
        : { items, hasMore: false, cursor: new Date(started).toISOString() }
    },
    async ids(kind: TrackerKind, page?: string, _context?: TrackerCallContext): Promise<TrackerIdPage> {
      const offset = page === undefined ? 0 : Number(page)
      const all = listOf(kind)
        .filter((one) => one.deleted !== true)
        .map((one) => one.externalId)
      const items = all.slice(offset, offset + size)
      return offset + size < all.length
        ? { items, hasMore: true, nextCursor: String(offset + size) }
        : { items, hasMore: false }
    },
    touch(kind, externalId) {
      find(kind, externalId).updatedAt = clock()
    },
    archive(kind, externalId) {
      const found = find(kind, externalId)
      found.archivedAt = clock()
      found.updatedAt = found.archivedAt
    },
    trash(kind, externalId) {
      const found = find(kind, externalId)
      found.archivedAt = clock()
      found.deleted = true
    },
    remove(kind, externalId) {
      const list = rows[kind] as { externalId: string }[] | undefined
      const at = list?.findIndex((one) => one.externalId === externalId) ?? -1
      if (at < 0) throw new Error(`the fake tracker has no ${kind} ${externalId}`)
      list?.splice(at, 1)
    },
    skewed: (ms) => make(ms),
    sent,
    loseNextAnswer() {
      lose = true
    },
    writes: TRACKER_WRITES,
    async createIssue(draft) {
      rows.issue ??= []
      const issues = rows.issue
      const team = (rows.team ?? []).find((one) => one.externalId === draft.team)
      const number = issues.length + 1
      const issue: TrackerRecords["issue"] = {
        externalId: `issue-${number}`,
        key: `${team?.key ?? "ISS"}-${number}`,
        labels: [],
        creator: self ?? null,
        createdAt: clock(),
        title: draft.title,
      }
      issues.push(issue)
      const answer = apply(issue, draft)
      made("create", issue.externalId)
      return answer
    },
    async updateIssue(externalId, patch) {
      const found = (rows.issue ?? []).find((one) => one.externalId === externalId)
      if (!found) throw new CliError("not_found", `the fake tracker has no issue ${externalId}`)
      const answer = apply(found, patch)
      made("update", externalId)
      return answer
    },
    async comment(issue, body) {
      rows.comment ??= []
      const comments = rows.comment
      const comment = {
        externalId: `comment-${comments.length + 1}`,
        issue,
        body,
        author: self ?? null,
        createdAt: clock(),
        updatedAt: clock(),
      }
      comments.push(comment)
      made("comment", comment.externalId)
      return { ...comment }
    },
  })
  return make(options.skew ?? 0)
}

const T0 = Date.UTC(2026, 10, 1)

/**
 * A small Linear-like workspace: one team, two users, the seven state types, a label, a project, a sprint, three
 * issues.
 */
export const exampleTrackerRows = (): Required<FakeTrackerRows> => ({
  team: [{ externalId: "team-1", key: "ENG", name: "Engineering", updatedAt: T0 }],
  user: [
    { externalId: "user-1", name: "Ada Owner", email: "ada@example.com", active: true, updatedAt: T0 },
    { externalId: "user-2", name: "Bob Builder", email: "bob@example.com", active: true, updatedAt: T0 + 1 },
  ],
  state: [
    { externalId: "state-triage", name: "Triage", type: "triage", team: "team-1", position: 0, updatedAt: T0 },
    { externalId: "state-backlog", name: "Backlog", type: "backlog", team: "team-1", position: 1, updatedAt: T0 },
    { externalId: "state-todo", name: "Todo", type: "unstarted", team: "team-1", position: 2, updatedAt: T0 },
    { externalId: "state-doing", name: "In Progress", type: "started", team: "team-1", position: 3, updatedAt: T0 },
    { externalId: "state-done", name: "Done", type: "completed", team: "team-1", position: 4, updatedAt: T0 },
    { externalId: "state-gone", name: "Canceled", type: "canceled", team: "team-1", position: 5, updatedAt: T0 },
    { externalId: "state-twin", name: "Duplicate", type: "duplicate", team: "team-1", position: 6, updatedAt: T0 },
  ],
  label: [{ externalId: "label-bug", name: "Bug", team: "team-1", updatedAt: T0 }],
  project: [
    {
      externalId: "project-1",
      name: "Billing revamp",
      description: "Move invoices to the new provider",
      status: "started",
      lead: "user-1",
      teams: ["team-1"],
      updatedAt: T0,
    },
  ],
  sprint: [
    {
      externalId: "sprint-1",
      name: "",
      number: 1,
      team: "team-1",
      startsAt: T0,
      endsAt: T0 + 14 * 86_400_000,
      updatedAt: T0,
    },
  ],
  issue: [
    {
      externalId: "issue-1",
      key: "ENG-1",
      title: "Invoices fail for EUR accounts",
      description: "The provider refuses the currency code",
      state: "state-doing",
      team: "team-1",
      project: "project-1",
      sprint: "sprint-1",
      assignee: "user-1",
      labels: ["label-bug"],
      priority: 1,
      createdAt: T0,
      updatedAt: T0 + 10,
    },
    {
      externalId: "issue-2",
      key: "ENG-2",
      title: "Write the migration guide",
      state: "state-todo",
      team: "team-1",
      project: "project-1",
      assignee: "user-2",
      labels: [],
      priority: 3,
      createdAt: T0,
      updatedAt: T0 + 20,
    },
    {
      externalId: "issue-3",
      key: "ENG-3",
      title: "Old spike",
      state: "state-done",
      team: "team-1",
      assignee: null,
      labels: [],
      priority: 0,
      createdAt: T0,
      updatedAt: T0 + 30,
      completedAt: T0 + 30,
    },
  ],
  comment: [
    { externalId: "comment-1", issue: "issue-1", body: "Seen on three accounts", author: "user-2", updatedAt: T0 + 11 },
  ],
})
