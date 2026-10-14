import { CliError } from "@wirecat/cli-base"
import type {
  Meeting,
  MeetingContextReadCapabilities,
  MeetingReadCapabilities,
  MeetingReadScope,
  Transcript,
  TranscriptReadScope,
} from "../../meetings/index.js"
import type { CacheDatabase } from "../driver.js"
import { meetingOf, transcriptOf, transcriptRowOf } from "./meeting-values.js"
import type { StoreContext } from "./open.js"

export type {
  MeetingContextReadCapabilities,
  MeetingReadCapabilities,
  MeetingReadScope,
  TranscriptContextInput,
  TranscriptContextPage,
  TranscriptPage,
  TranscriptReadScope,
  TranscriptRowPage,
} from "../../meetings/index.js"

const MEETING_TEXT = ["external_id", "title", "description", "location", "join_url", "timezone", "metadata"]
const TRANSCRIPT_TEXT = ["source", "format", "language", "content_hash", "metadata"]
const ROW_TEXT = ["speaker_name", "text", "normalized_text", "metadata"]
const bytesOf = (columns: readonly string[]) =>
  columns.map((column) => `coalesce(length(CAST(${column} AS BLOB)), 0)`).join(" + ")
export const positiveReadInteger = (value: number, name: string): void => {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new CliError("validation_error", `${name} must be a positive safe integer`)
}
const check = (input: MeetingReadScope): number => {
  input.signal?.throwIfAborted()
  if (
    "includeHistorical" in input &&
    input.includeHistorical !== undefined &&
    typeof input.includeHistorical !== "boolean"
  )
    throw new CliError("validation_error", "includeHistorical must be a boolean")
  positiveReadInteger(input.accountId, "accountId")
  positiveReadInteger(input.meetingId, "meetingId")
  const budget = input.maxReadBytes ?? 4 * 1024 * 1024
  positiveReadInteger(budget, "maxReadBytes")
  return budget
}
const page = (limit: number, after: number | undefined, name: string, zero = false) => {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
    throw new CliError("validation_error", "limit must be an integer from 1 to 1000")
  if (after !== undefined && (!Number.isSafeInteger(after) || after < (zero ? 0 : 1)))
    throw new CliError("validation_error", `Invalid ${name}`)
}
const missing = (): never => {
  throw new CliError("not_found", "Meeting or transcript not found")
}
const ensureBytes = (bytes: unknown, budget: number): number => {
  const size = Number(bytes ?? 0)
  if (!Number.isSafeInteger(size) || size < 0 || size > budget)
    throw new CliError("validation_error", "Meeting read exceeds the stored text byte budget")
  return size
}
/** The preflight and value reads share one snapshot; this read transaction never drains write queues. */
export const meetingReadSnapshot = <T>(database: CacheDatabase, body: () => T): T => {
  database.exec("BEGIN")
  try {
    const result = body()
    database.exec("COMMIT")
    return result
  } catch (error) {
    database.exec("ROLLBACK")
    throw error
  }
}
const parent = (database: CacheDatabase, input: MeetingReadScope, budget: number, load: boolean) => {
  const preflight = database
    .prepare(
      `SELECT ${bytesOf(MEETING_TEXT)} AS read_bytes FROM meetings WHERE id = ? AND account_id = ? AND deleted_at IS NULL`,
    )
    .get(input.meetingId, input.accountId)
  if (!preflight) return missing()
  const bytes = load ? ensureBytes(preflight.read_bytes, budget) : 0
  input.signal?.throwIfAborted()
  return {
    bytes,
    meeting: load
      ? meetingOf(database.prepare("SELECT * FROM meetings WHERE id = ?").get(input.meetingId) ?? missing())
      : undefined,
  }
}
const revision = (database: CacheDatabase, input: TranscriptReadScope, budget: number, load: boolean) => {
  positiveReadInteger(input.transcriptId, "transcriptId")
  const where =
    "id = ? AND meeting_id = ? AND deleted_at IS NULL" +
    (input.includeHistorical === true ? "" : " AND superseded_at IS NULL")
  const preflight = database
    .prepare(`SELECT ${bytesOf(TRANSCRIPT_TEXT)} AS read_bytes FROM meeting_transcripts WHERE ${where}`)
    .get(input.transcriptId, input.meetingId)
  if (!preflight) return missing()
  const bytes = load ? ensureBytes(preflight.read_bytes, budget) : 0
  input.signal?.throwIfAborted()
  return {
    bytes,
    transcript: load
      ? transcriptOf(
          database.prepare("SELECT * FROM meeting_transcripts WHERE id = ?").get(input.transcriptId) ?? missing(),
        )
      : undefined,
  }
}
export const meetingReadsOver = ({
  database,
}: Pick<StoreContext, "database">): MeetingReadCapabilities & MeetingContextReadCapabilities => ({
  async transcriptContext(input) {
    const budget = check(input)
    positiveReadInteger(input.transcriptId, "transcriptId")
    if (
      !Number.isSafeInteger(input.position) ||
      input.position < 0 ||
      !Number.isSafeInteger(input.before) ||
      input.before < 0 ||
      !Number.isSafeInteger(input.after) ||
      input.after < 0 ||
      input.before + input.after > 999
    )
      throw new CliError("validation_error", "context requires a cue position and 0–999 surrounding cues in total")
    return meetingReadSnapshot(database, () => {
      const m = parent(database, input, budget, true)
      const t = revision(database, input, budget - m.bytes, true)
      const columns = `id,position,${bytesOf(ROW_TEXT)} AS read_bytes`
      const selection = `WITH before_rows AS (SELECT ${columns} FROM meeting_transcript_rows WHERE meeting_transcript_id=? AND position<? ORDER BY position DESC LIMIT ?),
        after_rows AS (SELECT ${columns} FROM meeting_transcript_rows WHERE meeting_transcript_id=? AND position>? ORDER BY position LIMIT ?),
        selected AS (SELECT * FROM before_rows UNION ALL SELECT ${columns} FROM meeting_transcript_rows WHERE meeting_transcript_id=? AND position=? UNION ALL SELECT * FROM after_rows)`
      const params = [
        input.transcriptId,
        input.position,
        input.before + 1,
        input.transcriptId,
        input.position,
        input.after + 1,
        input.transcriptId,
        input.position,
      ]
      const probes = database.prepare(`${selection} SELECT * FROM selected ORDER BY position`).all(...params)
      const target = probes.find((row) => Number(row.position) === input.position)
      if (!target) return missing()
      const left = probes.filter((row) => Number(row.position) < input.position)
      const right = probes.filter((row) => Number(row.position) > input.position)
      const selected = [...left.slice(Math.max(0, left.length - input.before)), target, ...right.slice(0, input.after)]
      const total = selected.reduce((sum, row) => sum + ensureBytes(row.read_bytes, budget), 0)
      ensureBytes(total, budget - m.bytes - t.bytes)
      input.signal?.throwIfAborted()
      const found = database
        .prepare("SELECT * FROM meeting_transcript_rows WHERE id IN (SELECT value FROM json_each(?)) ORDER BY position")
        .all(JSON.stringify(selected.map((row) => Number(row.id))))
        .map(transcriptRowOf)
      input.signal?.throwIfAborted()
      return {
        meeting: m.meeting as Meeting,
        transcript: t.transcript as Transcript,
        rows: found,
        hasBefore: left.length > input.before,
        hasAfter: right.length > input.after,
      }
    })
  },
  async meetingMetadata(input) {
    const budget = check(input)
    return meetingReadSnapshot(database, () => {
      const result = parent(database, input, budget, true)
      input.signal?.throwIfAborted()
      return result.meeting as Meeting
    })
  },
  async transcriptMetadata(input) {
    const budget = check(input)
    positiveReadInteger(input.transcriptId, "transcriptId")
    return meetingReadSnapshot(database, () => {
      parent(database, input, budget, false)
      const result = revision(database, input, budget, true)
      input.signal?.throwIfAborted()
      return result.transcript as Transcript
    })
  },
  async transcripts(input) {
    const budget = check(input)
    page(input.limit, input.afterId, "afterId")
    return meetingReadSnapshot(database, () => {
      parent(database, input, budget, false)
      const where =
        "meeting_id = ? AND id > ? AND deleted_at IS NULL" +
        (input.includeHistorical === true ? "" : " AND superseded_at IS NULL")
      const params = [input.meetingId, input.afterId ?? 0, input.limit + 1]
      const selected = `FROM meeting_transcripts WHERE ${where} ORDER BY id LIMIT ?`
      const preflight = database
        .prepare(
          `SELECT coalesce(sum(read_bytes), 0) AS read_bytes FROM (SELECT ${bytesOf(TRANSCRIPT_TEXT)} AS read_bytes ${selected})`,
        )
        .get(...params)
      ensureBytes(preflight?.read_bytes, budget)
      input.signal?.throwIfAborted()
      const found = database
        .prepare(`SELECT * ${selected}`)
        .all(...params)
        .map(transcriptOf)
      input.signal?.throwIfAborted()
      const hasMore = found.length > input.limit
      const items = found.slice(0, input.limit)
      return { items, hasMore, ...(hasMore ? { nextId: items.at(-1)?.id } : {}) }
    })
  },
  async transcriptRows(input) {
    const budget = check(input)
    positiveReadInteger(input.transcriptId, "transcriptId")
    page(input.limit, input.afterPosition, "afterPosition", true)
    return meetingReadSnapshot(database, () => {
      const m = parent(database, input, budget, true)
      input.signal?.throwIfAborted()
      const t = revision(database, input, budget - m.bytes, true)
      input.signal?.throwIfAborted()
      const params = [input.transcriptId, input.afterPosition ?? -1, input.limit + 1]
      const selected =
        "FROM meeting_transcript_rows WHERE meeting_transcript_id = ? AND position > ? ORDER BY position LIMIT ?"
      const preflight = database
        .prepare(
          `SELECT coalesce(sum(read_bytes), 0) AS read_bytes FROM (SELECT ${bytesOf(ROW_TEXT)} AS read_bytes ${selected})`,
        )
        .get(...params)
      ensureBytes(preflight?.read_bytes, budget - m.bytes - t.bytes)
      input.signal?.throwIfAborted()
      const found = database
        .prepare(`SELECT * ${selected}`)
        .all(...params)
        .map(transcriptRowOf)
      input.signal?.throwIfAborted()
      const hasMore = found.length > input.limit
      const rows = found.slice(0, input.limit)
      return {
        meeting: m.meeting as Meeting,
        transcript: t.transcript as Transcript,
        rows,
        hasMore,
        ...(hasMore ? { nextPosition: rows.at(-1)?.position } : {}),
      }
    })
  },
})
