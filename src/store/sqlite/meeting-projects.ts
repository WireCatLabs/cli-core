import { createHash } from "node:crypto"
import { CliError } from "@wirecat/cli-base"
import { formatMeetingReference } from "../../domain/meeting-reference.js"
import type { AccountKey } from "../store.js"
import { atomic } from "./atomic.js"
import type { StoreContext } from "./open.js"

export interface MeetingProjectLink {
  id: string
  meeting: string
  project: string
  confirmed: boolean
  provenance: string | null
  fingerprint: string
}
export interface MeetingProjectsStore {
  linkMeetingProject(
    key: AccountKey,
    meetingId: string,
    projectId: string,
    options?: { by?: "owner" | "agent"; provenance?: string; expectedFingerprint?: string; signal?: AbortSignal },
  ): Promise<{ link: MeetingProjectLink; changed: boolean }>
  meetingProjects(
    key: AccountKey,
    options?: {
      meetingId?: string
      projectId?: string
      confirmed?: boolean
      limit?: number
      offset?: number
      signal?: AbortSignal
    },
  ): Promise<{ items: MeetingProjectLink[]; hasMore: boolean }>
}

type Row = Record<string, unknown>
const fields =
  "id,from_id,to_id,source,confirmed,updated_at,length(evidence) AS evidenceLength,substr(evidence,1,2000) AS evidence"
const id = (value: string) => {
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)))
    throw new CliError("validation_error", "a meeting or project needs a positive stored id")
  return Number(value)
}
const check = (signal?: AbortSignal) => {
  if (signal?.aborted) throw new CliError("cancelled", "meeting project operation was cancelled")
}

/** Membership is scoped to the meeting's account, independently of global project names. */
export const meetingProjectsStoreOver = ({ database, now }: StoreContext): MeetingProjectsStore => {
  const account = (key: AccountKey) => {
    if (!key?.provider || !key.account) throw new CliError("validation_error", "choose a meeting account explicitly")
    const row = database
      .prepare("SELECT id FROM accounts WHERE provider=? AND external_id=?")
      .get(key.provider, key.account)
    if (!row) throw new CliError("not_found", "the meeting account is unavailable")
    return Number(row.id)
  }
  const linkOf = (row: Row, accountId: number): MeetingProjectLink => {
    if (Number(row.evidenceLength ?? 0) > 2000)
      throw new CliError("validation_error", "stored membership provenance exceeds its read budget")
    return {
      id: String(row.id),
      meeting: formatMeetingReference({ type: "meeting", accountId, meetingId: Number(row.from_id) }),
      project: `project:${row.to_id}`,
      confirmed: Number(row.confirmed) === 1,
      provenance: row.evidence == null ? null : String(row.evidence),
      fingerprint: createHash("sha256")
        .update(
          JSON.stringify([row.id, row.from_id, row.to_id, row.source, row.confirmed, row.evidence, row.updated_at]),
        )
        .digest("hex"),
    }
  }
  return {
    linkMeetingProject: async (key, meetingId, projectId, options = {}) => {
      check(options.signal)
      const meeting = id(meetingId)
      const project = id(projectId)
      const by = options.by ?? "owner"
      if (by !== "owner" && by !== "agent") throw new CliError("validation_error", "choose owner or agent provenance")
      if (
        options.provenance !== undefined &&
        (typeof options.provenance !== "string" || options.provenance.length > 2000)
      )
        throw new CliError("validation_error", "meeting project provenance takes at most 2000 characters")
      return atomic(database, () => {
        const accountId = account(key)
        if (
          !database
            .prepare("SELECT 1 FROM meetings WHERE id=? AND account_id=? AND deleted_at IS NULL")
            .get(meeting, accountId)
        )
          throw new CliError("not_found", "the meeting is unavailable in this account")
        if (
          !database
            .prepare("SELECT 1 FROM projects WHERE id=? AND account_id IS NULL AND deleted_at IS NULL")
            .get(project)
        )
          throw new CliError("not_found", "the owner project is unavailable")
        const held = database
          .prepare(
            `SELECT ${fields} FROM links WHERE from_type='meeting' AND from_id=? AND to_type='project' AND to_id=? AND kind='member-of' AND anchor IS NULL`,
          )
          .get(meeting, project)
        if (
          options.expectedFingerprint !== undefined &&
          (!held || linkOf(held, accountId).fingerprint !== options.expectedFingerprint)
        )
          throw new CliError("configuration_error", "meeting membership changed since review", {
            reason: "stale_meeting_project",
          })
        if (held && (Number(held.confirmed) === 1 || by === "agent"))
          return { link: linkOf(held, accountId), changed: false }
        // Confirmation is an owner review of a specific proposal, never an implicit retry upgrade.
        if (held && options.expectedFingerprint === undefined)
          throw new CliError("validation_error", "confirm the proposed membership with its preview fingerprint")
        const at = now()
        if (held)
          database
            .prepare("UPDATE links SET confirmed=1,source='owner',author='owner',updated_at=? WHERE id=?")
            .run(at, Number(held.id))
        else
          database
            .prepare(
              "INSERT INTO links (from_type,from_id,to_type,to_id,kind,source,confirmed,evidence,author,created_at,updated_at) VALUES ('meeting',?,'project',?,'member-of',?,?,?,?,?,?)",
            )
            .run(
              meeting,
              project,
              by === "owner" ? "owner" : "suggested",
              by === "owner" ? 1 : 0,
              options.provenance ?? null,
              by === "owner" ? "owner" : null,
              at,
              at,
            )
        const row = database
          .prepare(
            `SELECT ${fields} FROM links WHERE from_type='meeting' AND from_id=? AND to_type='project' AND to_id=? AND kind='member-of' AND anchor IS NULL`,
          )
          .get(meeting, project) as Row
        check(options.signal)
        return { link: linkOf(row, accountId), changed: true }
      })
    },
    meetingProjects: async (key, options = {}) => {
      check(options.signal)
      const accountId = account(key)
      const limit = options.limit ?? 50
      const offset = options.offset ?? 0
      if (
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > 500 ||
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        offset > 10000
      )
        throw new CliError("validation_error", "meeting project reads take 1–500 rows and offset 0–10000")
      if (options.confirmed !== undefined && typeof options.confirmed !== "boolean")
        throw new CliError("validation_error", "confirmed must be boolean")
      const meeting = options.meetingId === undefined ? null : id(options.meetingId)
      const project = options.projectId === undefined ? null : id(options.projectId)
      const rows = database
        .prepare(
          "SELECT l.id,l.from_id,l.to_id,l.source,l.confirmed,l.updated_at,length(l.evidence) AS evidenceLength,substr(l.evidence,1,2000) AS evidence FROM links l JOIN meetings m ON m.id=l.from_id JOIN projects p ON p.id=l.to_id WHERE l.from_type='meeting' AND l.to_type='project' AND l.kind='member-of' AND l.anchor IS NULL AND m.account_id=? AND m.deleted_at IS NULL AND p.account_id IS NULL AND p.deleted_at IS NULL AND (? IS NULL OR m.id=?) AND (? IS NULL OR p.id=?) AND (? IS NULL OR l.confirmed=?) ORDER BY l.id LIMIT ? OFFSET ?",
        )
        .all(
          accountId,
          meeting,
          meeting,
          project,
          project,
          options.confirmed === undefined ? null : Number(options.confirmed),
          options.confirmed === undefined ? null : Number(options.confirmed),
          limit + 1,
          offset,
        )
      check(options.signal)
      return { items: rows.slice(0, limit).map((row) => linkOf(row, accountId)), hasMore: rows.length > limit }
    },
  }
}
