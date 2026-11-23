import { CliError, isCliError } from "@wirecat/cli-base"
import type { TrackerKind, TrackerRecords } from "../domain/tracker.js"
import { foldName } from "../resolve.js"
import type { Asker } from "../sends/guard.js"
import { guardedWrite } from "../sends/guarded.js"
import type { PermissionKey } from "../sends/permissions.js"
import { askedKeys, type ProfileWrites, profileWriteGuard } from "../sends/profile-writes.js"
import { newOperationId } from "../sends/send-id.js"
import type { TrackerItem } from "../store/sqlite/tracker.js"
import type { MessageStore } from "../store/store.js"
import type { AccountKey } from "../store/types.js"
import type { TrackerSource } from "./source.js"
import { trackerSelfOf } from "./sync.js"
import {
  TRACKER_ASSIGN_OTHERS_KEY,
  TRACKER_WRITE_DEFAULTS,
  TRACKER_WRITE_KEYS,
  type TrackerIssueFields,
  type TrackerWrite,
  type TrackerWriteOptions,
  type TrackerWriter,
} from "./writer.js"

/** What a CLI hands the tracker writes for one profile. */
export interface TrackerWrites extends ProfileWrites {
  writer: TrackerWriter
}

export interface TrackerWriteContext {
  store: MessageStore
  account: AccountKey
  writes: TrackerWrites
  /** A terminal's question, or an agent's go-ahead. */
  ask: Asker
  /** Names the sign-in's own user when no sync has kept it yet; left out, every assignee is somebody else. */
  source?: () => TrackerSource
  now?: () => number
}

/**
 * An issue's fields as typed: a team by its id, key or name, a state, label or project by its id or name, a user by
 * its id, name or e-mail, a parent by its key or id. An empty value clears a field; one empty `labels` clears the list.
 */
export interface TrackerIssueInput {
  title?: string
  description?: string
  team?: string
  state?: string
  assignee?: string
  /** 0 to 4, or none, urgent, high, medium, low. */
  priority?: string
  labels?: readonly string[]
  project?: string
  parent?: string
}

export interface TrackerIssueWritten {
  operationId: string
  issue: TrackerItem<"issue">
}

export interface TrackerCommentWritten {
  operationId: string
  comment: TrackerItem<"comment">
}

const PAGE = 500
const PRIORITIES: Readonly<Record<string, number>> = { none: 0, urgent: 1, high: 2, medium: 3, low: 4 }
const PLURALS = { team: "teams", user: "users", state: "states", label: "labels", project: "projects" } as const
type Named = keyof typeof PLURALS

const invalid = (message: string, param?: string, details: Record<string, unknown> = {}) =>
  new CliError("validation_error", message, { reason: "tracker.field", ...(param ? { param } : {}), ...details })

const supported = (writer: TrackerWriter, write: TrackerWrite) => {
  if (!writer.writes.includes(write))
    throw new CliError("validation_error", `this tracker takes no issues ${write}`, {
      reason: "tracker.write-unsupported",
      sent: false,
    })
}

const namesOf = (kind: Named, record: TrackerRecords[Named]): string[] => {
  const { name } = record as { name: string }
  if (kind === "team") return [name, (record as TrackerRecords["team"]).key ?? ""]
  if (kind === "user") return [name, (record as TrackerRecords["user"]).email ?? ""]
  return [name]
}

/** Every live row of the kind, page by page: a uniqueness check over a capped page could miss the second match. */
const allOf = async <K extends Named>(context: TrackerWriteContext, kind: K, parent?: string) => {
  const all: TrackerItem<K>[] = []
  for (let offset = 0; ; offset += PAGE) {
    const page = await context.store.tracker.list(context.account, kind, {
      limit: PAGE,
      offset,
      ...(parent === undefined ? {} : { parent }),
    })
    for (const item of page.items) all.push(item)
    if (!page.hasMore) return all
  }
}

/** A team's states are its own; its labels are its own and the workspace's, which belong to no team. */
const withinTeam = (kind: Named, item: TrackerItem, team: string | undefined) => {
  if (team === undefined || (kind !== "state" && kind !== "label")) return true
  const owner = (item.record as TrackerRecords["state"] | TrackerRecords["label"]).team ?? null
  return owner === team || (kind === "label" && owner === null)
}

/**
 * A record of this account's copy by the tracker's id, or by a name only one of them has, in any letter case. A state
 * or a label is looked for among the issue's team's. Anything else is refused before a write is sent: a reference the
 * copy does not hold would reach the tracker as typed.
 */
const referenceOf = async (
  context: TrackerWriteContext,
  kind: Named,
  given: string,
  param: string,
  team?: string,
): Promise<string> => {
  const byId = await context.store.tracker.get(context.account, kind, given)
  if (byId && byId.deletedAt === null && withinTeam(kind, byId, team)) return given
  const want = foldName(given.trim())
  const found = (await allOf(context, kind, kind === "state" ? team : undefined)).filter(
    (one) => withinTeam(kind, one, team) && namesOf(kind, one.record).some((name) => name && foldName(name) === want),
  )
  if (found.length === 1) return (found[0] as TrackerItem).record.externalId
  const candidates = found.map((one) => ({ id: one.record.externalId, name: (one.record as { name: string }).name }))
  const scoped = (kind === "state" || kind === "label") && team ? " for the issue's team" : ""
  throw invalid(
    found.length
      ? `${found.length} ${PLURALS[kind]} are named ${given}${scoped}; name one by its id`
      : `no ${kind} ${given} in the copy${scoped}; see ${PLURALS[kind]} list, or run sync`,
    param,
    { reason: "tracker.reference", ...(candidates.length ? { candidates } : {}) },
  )
}

/** The team a new issue goes to: the one named, or the copy's only team; several and none named is refused. */
const teamOf = async (context: TrackerWriteContext, given: string | undefined): Promise<string> => {
  if (given !== undefined) return referenceOf(context, "team", given, "--team")
  const all = await allOf(context, "team")
  if (all.length === 1) return (all[0] as TrackerItem<"team">).record.externalId
  // Sent without a team, the issue would be refused by the tracker or land where the owner did not choose.
  if (all.length === 0)
    throw invalid("the copy holds no team for a new issue; run sync, then try again", "--team", {
      reason: "tracker.team-required",
    })
  throw invalid(
    `this tracker has ${all.length} teams; name one with --team: ` +
      all.map(({ record }) => `${record.name} (${record.key ?? record.externalId})`).join(", "),
    "--team",
    { reason: "tracker.team-required", allowed: all.map(({ record }) => record.externalId) },
  )
}

/** An issue of this account's copy by its key (`ENG-12`, any case) or id. */
export const trackerIssueOf = async (
  context: Pick<TrackerWriteContext, "store" | "account">,
  reference: string,
  param = "<issue>",
): Promise<TrackerItem<"issue">> => {
  const found =
    (await context.store.tracker.get(context.account, "issue", reference)) ??
    (await context.store.tracker.issueByKey(context.account, reference))
  if (!found || found.deletedAt !== null)
    throw new CliError("not_found", `no issue ${reference} in the copy; run sync, then try again`, { param })
  return found
}

/** An empty value clears it, as for every other field: 0 is the tracker's "no priority". */
const priorityOf = (typed: string): number => {
  if (typed.trim() === "") return 0
  const word = PRIORITIES[typed.trim().toLowerCase()]
  const number = word ?? Number(typed)
  if (!Number.isInteger(number) || number < 0 || number > 4)
    throw invalid("--priority is 0 to 4, or none, urgent, high, medium, low", "--priority")
  return number
}

/** Typed fields into the port's, each reference resolved in the copy; `team` is the issue's, for its states. */
const fieldsOf = async (
  context: TrackerWriteContext,
  input: TrackerIssueInput,
  team: string | undefined,
  self?: string,
): Promise<TrackerIssueFields> => {
  const fields: TrackerIssueFields = {}
  const cleared = (value: string) => value.trim() === ""
  if (input.title !== undefined) {
    if (cleared(input.title)) throw invalid("a title is never empty", "--title")
    fields.title = input.title.trim()
  }
  if (input.description !== undefined) fields.description = cleared(input.description) ? null : input.description
  if (team !== undefined && input.team !== undefined) fields.team = team
  if (input.state !== undefined) {
    if (cleared(input.state)) throw invalid("every issue is in a state; name one", "--state")
    fields.state = await referenceOf(context, "state", input.state, "--state", team)
  }
  if (input.assignee !== undefined)
    fields.assignee = cleared(input.assignee) ? null : await referenceOf(context, "user", input.assignee, "--assignee")
  if (input.priority !== undefined) fields.priority = priorityOf(input.priority)
  if (input.labels !== undefined)
    fields.labels =
      input.labels.length === 1 && cleared(input.labels[0] as string)
        ? []
        : await Promise.all(input.labels.map((one) => referenceOf(context, "label", one, "--label", team)))
  if (input.project !== undefined)
    fields.project = cleared(input.project) ? null : await referenceOf(context, "project", input.project, "--project")
  if (input.parent !== undefined) {
    fields.parent = cleared(input.parent)
      ? null
      : (await trackerIssueOf(context, input.parent, "--parent")).record.externalId
    if (fields.parent !== null && fields.parent === self) throw invalid("an issue is not its own parent", "--parent")
  }
  return fields
}

/**
 * Checked and journaled once. A write the tracker made whose answer then held no record is journaled as sent, and the
 * failure answered after; a lost answer is `outcome_unknown`, and the owner syncs before writing again.
 */
const written = async <T>(
  context: TrackerWriteContext,
  write: TrackerWrite,
  operationId: string,
  act: (options: TrackerWriteOptions) => Promise<T>,
  extra: PermissionKey[] = [],
): Promise<T> => {
  const key = TRACKER_WRITE_KEYS[write]
  try {
    const confirmed = askedKeys(context.writes, TRACKER_WRITE_DEFAULTS, [key, ...extra])
    const done = await guardedWrite(
      profileWriteGuard(context.writes, context.ask, TRACKER_WRITE_DEFAULTS, extra),
      { chatId: null, kind: "edit", key, operationId },
      async () => {
        try {
          return { record: await act({ operationId, confirmed }), unread: null }
        } catch (error) {
          if (isCliError(error) && error.details.sent === true) return { record: null, unread: error }
          throw error
        }
      },
    )
    if (done.unread)
      throw new CliError(done.unread.code, `${done.unread.message} — sync to store it, do not write it again`, {
        ...done.unread.details,
        operation_id: operationId,
      })
    return done.record as T
  } catch (error) {
    if (!isCliError(error) || error.code !== "outcome_unknown") throw error
    throw new CliError(
      "outcome_unknown",
      `${error.message} — sync and look at the tracker before writing again: a repeat may write it twice`,
      { ...error.details, operation_id: operationId },
    )
  }
}

/** The tracker's answer into the copy, as a sync saves it; a failure names the record, which the tracker has written. */
const kept = async <K extends "issue" | "comment">(
  context: TrackerWriteContext,
  kind: K,
  record: TrackerRecords[K],
  operationId: string,
): Promise<TrackerItem<K>> => {
  try {
    await context.store.tracker.save(context.account, kind, [record], context.now?.() ?? Date.now())
    const found = await context.store.tracker.get(context.account, kind as TrackerKind, record.externalId)
    if (!found) throw new Error("it is not found after the save")
    return found as TrackerItem<K>
  } catch (error) {
    throw new CliError(
      "invalid_response",
      `the tracker wrote ${kind} ${record.externalId}, but the local store did not keep it ` +
        `(${error instanceof Error ? error.message : String(error)}); sync to store it — do not write it again`,
      { operation_id: operationId, external_id: record.externalId, sent: true },
    )
  }
}

/** An assignee other than the sign-in's own user checks `issues.assign-others` too (WC-PERM-22). */
const assignKeys = async (context: TrackerWriteContext, fields: TrackerIssueFields): Promise<PermissionKey[]> => {
  if (fields.assignee == null) return []
  const self = await trackerSelfOf(context.store, context.account, context.source?.())
  return fields.assignee === self ? [] : [TRACKER_ASSIGN_OTHERS_KEY]
}

/** A new issue in the tracker, through the guarded path; the tracker's answer is stored as a sync stores it. */
export const createTrackerIssue = async (
  context: TrackerWriteContext,
  input: TrackerIssueInput,
): Promise<TrackerIssueWritten> => {
  const { writer } = context.writes
  supported(writer, "create")
  if (input.title === undefined) throw invalid("a new issue needs --title", "--title")
  const team = await teamOf(context, input.team)
  const fields = await fieldsOf(context, { ...input, team }, team)
  const operationId = newOperationId()
  const issue = await written(
    context,
    "create",
    operationId,
    (options) => writer.createIssue({ ...fields, title: fields.title as string }, options),
    await assignKeys(context, fields),
  )
  return { operationId, issue: await kept(context, "issue", issue, operationId) }
}

/** A change to an issue by its key or id; what is left out keeps its value. */
export const updateTrackerIssue = async (
  context: TrackerWriteContext,
  reference: string,
  input: TrackerIssueInput,
): Promise<TrackerIssueWritten> => {
  const { writer } = context.writes
  supported(writer, "update")
  const copy = await trackerIssueOf(context, reference)
  const team = input.team === undefined ? (copy.record.team ?? undefined) : await teamOf(context, input.team)
  const fields = await fieldsOf(context, input, team, copy.record.externalId)
  if (Object.keys(fields).length === 0) throw invalid("nothing to change: name a field")
  const operationId = newOperationId()
  const issue = await written(
    context,
    "update",
    operationId,
    (options) => writer.updateIssue(copy.record.externalId, fields, options),
    await assignKeys(context, fields),
  )
  return { operationId, issue: await kept(context, "issue", issue, operationId) }
}

/** A comment on an issue by its key or id, in the owner's words. */
export const commentTrackerIssue = async (
  context: TrackerWriteContext,
  reference: string,
  body: string,
): Promise<TrackerCommentWritten> => {
  const { writer } = context.writes
  supported(writer, "comment")
  if (body.trim() === "") throw invalid("a comment is never empty", "--body")
  const copy = await trackerIssueOf(context, reference)
  const operationId = newOperationId()
  const comment = await written(context, "comment", operationId, (options) =>
    writer.comment(copy.record.externalId, body, options),
  )
  return { operationId, comment: await kept(context, "comment", comment, operationId) }
}
