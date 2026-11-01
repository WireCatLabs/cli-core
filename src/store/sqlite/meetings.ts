import { CliError } from "@wirecat/cli-base"
import type {
  Attachment,
  ChatLine,
  MeetingChatLinesStore,
  MeetingContextStore,
  MeetingDetails,
  MeetingFilter,
  MeetingParticipantSearchStore,
  MeetingPreparationContextStore,
  MeetingPreparationKnowledgeStore,
  MeetingPreparationNotesStore,
  MeetingRelatedHistoryStore,
  MeetingReviewStore,
  MeetingSave,
  MeetingSearchIndexStore,
  MeetingSearchStore,
  MeetingSeries,
  MeetingSeriesHistoryStore,
  MeetingStatsStore,
  MeetingStore,
  MeetingTranscriptReceiptStore,
  MeetingTranscriptStore,
  NewRecord,
  Participant,
  SearchHit,
  TranscriptAppend,
  TranscriptAppendReceipt,
} from "../../meetings/index.js"
import { formatMeetingReference, joinKeyOf, MeetingError } from "../../meetings/index.js"
import type { CacheDatabase, SqlValue } from "../driver.js"
import { normalize } from "../normalize.js"
import * as eventQueries from "./events.js"
import { fromJson, int, page, str, toJson } from "./events.js"
import { folded } from "./folded.js"
import { meetingIdentityPk } from "./identities.js"
import { reviewLink } from "./link-reviews.js"
import { meetingChatLinesOver } from "./meeting-chat-lines.js"
import { meetingContextLinksOver } from "./meeting-context-links.js"
import { meetingHitIndexOver } from "./meeting-hit-index.js"
import { meetingHitSearchOver } from "./meeting-hit-search.js"
import { INDEX_CODES, type Indexable, indexedText, meetingRowid, summaryOf } from "./meeting-index-values.js"
import { meetingParticipantSearchOver } from "./meeting-participant-search.js"
import { meetingPreparationContextOver } from "./meeting-preparation-context.js"
import { meetingPreparationKnowledgeOver } from "./meeting-preparation-knowledge.js"
import { meetingPreparationNotesOver } from "./meeting-preparation-notes.js"
import { type MeetingContextReadCapabilities, type MeetingReadCapabilities, meetingReadsOver } from "./meeting-reads.js"
import { meetingRelatedHistoryOver } from "./meeting-related-history.js"
import { meetingReviewOver } from "./meeting-review.js"
import { meetingSeriesHistoryOver } from "./meeting-series-history.js"
import { meetingStatsOver } from "./meeting-stats.js"
import { invalidateMeetingStems } from "./meeting-stem-state.js"
import { meetingOf, transcriptOf, transcriptRowOf } from "./meeting-values.js"
import type { StoreContext } from "./open.js"
import { type ColumnMap, queryFilter } from "./query-filter.js"
import { read, write } from "./transaction.js"

type Row = Record<string, unknown>

const CURSOR_KEY = "meetings"

const seriesOf = (row: Row): MeetingSeries => ({
  id: Number(row.id),
  accountId: Number(row.account_id),
  externalId: String(row.external_id),
  eventSeriesId: int(row.event_series_id),
  title: str(row.title),
  description: str(row.description),
  kind: str(row.kind),
  recurrence: fromJson(row.recurrence),
  hostIdentityId: int(row.host_identity_id),
  joinUrl: str(row.join_url),
  metadata: fromJson(row.metadata),
  deletedAt: int(row.deleted_at),
  createdAt: Number(row.created_at),
  updatedAt: Number(row.updated_at),
})

const participantOf = (row: Row): Participant => ({
  id: Number(row.id),
  meetingId: Number(row.meeting_id),
  identityId: Number(row.identity_id),
  displayName: str(row.display_name),
  email: str(row.email),
  role: str(row.role),
  joinedAt: int(row.joined_at),
  leftAt: int(row.left_at),
  durationMs: int(row.duration_ms),
  sessions: fromJson(row.sessions),
  externalId: str(row.external_id),
  metadata: fromJson(row.metadata),
  createdAt: Number(row.created_at),
  updatedAt: Number(row.updated_at),
})

const chatOf = (row: Row): ChatLine => ({
  id: Number(row.id),
  meetingId: Number(row.meeting_id),
  externalId: str(row.external_id),
  sentAt: Number(row.sent_at),
  senderParticipantId: int(row.sender_participant_id),
  senderName: str(row.sender_name),
  recipient: str(row.recipient),
  text: String(row.text),
  normalizedText: str(row.normalized_text),
  metadata: fromJson(row.metadata),
  createdAt: Number(row.created_at),
  updatedAt: Number(row.updated_at),
})

export const attachmentOf = (row: Row): Attachment => ({
  id: Number(row.id),
  attachableType: "meeting",
  attachableId: Number(row.attachable_id),
  position: Number(row.position),
  kind: String(row.kind),
  mime: str(row.mime),
  name: str(row.name),
  title: str(row.title),
  url: str(row.url),
  size: int(row.size),
  width: int(row.width),
  height: int(row.height),
  duration: int(row.duration),
  providerRef: fromJson(row.provider_ref),
  localPath: str(row.local_path),
  text: str(row.text),
  normalizedText: str(row.normalized_text),
  extraction: str(row.extraction),
  extractor: str(row.extractor),
  extractionError: str(row.extraction_error),
  contentSha256: str(row.content_sha256),
  extractedAt: int(row.extracted_at),
  createdAt: Number(row.created_at),
  updatedAt: Number(row.updated_at),
})

const details = (database: CacheDatabase, id: number): MeetingDetails | null => {
  const row = database.prepare("SELECT * FROM meetings WHERE id = ?").get(id)
  if (!row) return null
  const meeting = meetingOf(row)
  const series =
    meeting.meetingSeriesId === null
      ? null
      : seriesOf(database.prepare("SELECT * FROM meeting_series WHERE id = ?").get(meeting.meetingSeriesId) as Row)
  const rowsOf = database.prepare(
    "SELECT * FROM meeting_transcript_rows WHERE meeting_transcript_id = ? ORDER BY position",
  )
  return {
    meeting,
    series,
    participants: database
      .prepare("SELECT * FROM meeting_participants WHERE meeting_id = ? ORDER BY id")
      .all(id)
      .map(participantOf),
    transcripts: database
      .prepare("SELECT * FROM meeting_transcripts WHERE meeting_id = ? ORDER BY id")
      .all(id)
      .map((t) => ({ transcript: transcriptOf(t), rows: rowsOf.all(Number(t.id)).map(transcriptRowOf) })),
    chat: database.prepare("SELECT * FROM meeting_chat_messages WHERE meeting_id = ? ORDER BY id").all(id).map(chatOf),
    summaries: database
      .prepare("SELECT * FROM meeting_summaries WHERE meeting_id = ? ORDER BY id")
      .all(id)
      .map(summaryOf),
    attachments: database
      .prepare("SELECT * FROM attachments WHERE attachable_type = 'meeting' AND attachable_id = ? ORDER BY position")
      .all(id)
      .map(attachmentOf),
  }
}

/** Inserts or updates the row the key finds; `values` are the columns besides the key and the times. */
const upsert = (
  database: CacheDatabase,
  table: string,
  key: Record<string, SqlValue>,
  values: Record<string, SqlValue>,
  now: number,
): number => {
  const keys = Object.keys(key)
  const where = keys.map((k) => `${k} IS ?`).join(" AND ")
  const found = database
    .prepare(`SELECT id FROM ${table} WHERE ${where} ORDER BY id LIMIT 1`)
    .get(...Object.values(key))
  const columns = Object.keys(values)
  if (found) {
    database
      .prepare(`UPDATE ${table} SET ${[...columns, "updated_at"].map((c) => `${c} = ?`).join(", ")} WHERE id = ?`)
      .run(...Object.values(values), now, found.id as number)
    return Number(found.id)
  }
  const all = [...keys, ...columns, "created_at", "updated_at"]
  return Number(
    database
      .prepare(`INSERT INTO ${table} (${all.join(", ")}) VALUES (${all.map(() => "?").join(", ")}) RETURNING id`)
      .get(...Object.values(key), ...Object.values(values), now, now)?.id,
  )
}

/** An attachment as its parent's save gives it: the parent sets the type and id. */
export type AttachmentInput = Omit<NewRecord<Attachment>, "attachableType" | "attachableId">

/** Inserts or updates an attachment of any parent, found by its position. */
export const saveAttachment = (
  database: CacheDatabase,
  type: string,
  parentId: number,
  a: AttachmentInput,
  now: number,
): number =>
  upsert(
    database,
    "attachments",
    { attachable_type: type, attachable_id: parentId, position: a.position },
    {
      kind: a.kind,
      mime: a.mime,
      name: a.name,
      name_folded: folded(a.name),
      title: a.title,
      url: a.url,
      size: a.size,
      width: a.width,
      height: a.height,
      duration: a.duration,
      provider_ref: toJson(a.providerRef),
      local_path: a.localPath,
      local_path_folded: folded(a.localPath),
      text: a.text,
      normalized_text: a.normalizedText,
      extraction: a.extraction,
      extractor: a.extractor,
      extraction_error: a.extractionError,
      content_sha256: a.contentSha256,
      extracted_at: a.extractedAt,
    },
    now,
  )

const FILE_SOURCE = "file"
const SAME_OCCURRENCE_MS = 15 * 60_000

/** The account's record of this occurrence under another key: same series, the nearest start within 15 minutes. */
const sameOccurrence = (
  database: StoreContext["database"],
  meeting: MeetingSave["meeting"],
  seriesKey: string | undefined,
) => {
  if (!seriesKey || meeting.startedAt === null) return undefined
  const row = database
    .prepare(
      `SELECT m.id,m.external_id,m.meeting_series_id,
       EXISTS (SELECT 1 FROM meeting_transcripts t WHERE t.meeting_id=m.id AND t.source=?) AND
       NOT EXISTS (SELECT 1 FROM meeting_transcripts t WHERE t.meeting_id=m.id AND t.source!=?) AS from_file
       FROM meetings m JOIN meeting_series s ON s.id=m.meeting_series_id
       WHERE m.account_id=? AND s.account_id=? AND s.external_id=? AND m.deleted_at IS NULL
       AND m.started_at BETWEEN ? AND ? ORDER BY abs(m.started_at-?),m.id LIMIT 1`,
    )
    .get(
      FILE_SOURCE,
      FILE_SOURCE,
      meeting.accountId,
      meeting.accountId,
      seriesKey,
      meeting.startedAt - SAME_OCCURRENCE_MS,
      meeting.startedAt + SAME_OCCURRENCE_MS,
      meeting.startedAt,
    )
  return row
    ? {
        id: row.id,
        externalId: row.external_id,
        seriesId: row.meeting_series_id,
        fromFile: Number(row.from_file) === 1,
      }
    : undefined
}

/** A file's copy of an occurrence the provider already gave: its transcript only, and only where there is none. */
const fillGap = (context: StoreContext, input: MeetingSave, meetingId: number): number => {
  const { database } = context
  const held = database
    .prepare("SELECT 1 FROM meeting_transcripts WHERE meeting_id = ? AND superseded_at IS NULL AND deleted_at IS NULL")
    .get(meetingId)
  if (held || !input.transcripts?.length) return meetingId
  const participantIds = (input.participants ?? []).map(({ identity, ...p }) =>
    upsert(
      database,
      "meeting_participants",
      {
        meeting_id: meetingId,
        identity_id: meetingIdentityPk({ ...context, now: () => input.now }, input.meeting.accountId, identity),
      },
      { display_name: p.displayName, email: p.email, role: p.role, external_id: p.externalId },
      input.now,
    ),
  )
  saveTranscripts(
    database,
    meetingId,
    input.transcripts,
    (position) => (position === null ? null : (participantIds[position] ?? null)),
    input.now,
  )
  return meetingId
}

const save = (context: StoreContext, input: MeetingSave): number => {
  const { database } = context
  const {
    meeting: { series: seriesInput, ...meeting },
    now,
  } = input
  if (!Number.isSafeInteger(meeting.accountId) || meeting.accountId <= 0 || !meeting.externalId)
    throw new Error("Invalid meeting key")
  let existing = database
    .prepare("SELECT id, meeting_series_id FROM meetings WHERE account_id = ? AND external_id = ?")
    .get(meeting.accountId, meeting.externalId)
  const same = existing ? undefined : sameOccurrence(database, meeting, seriesInput?.externalId)
  if (same?.fromFile === false && input.fromFile) return fillGap(context, input, Number(same.id))
  if (same && (same.fromFile || input.fromFile)) {
    // A provider record takes over a record made from files; two files of one occurrence share the first one's key.
    if (input.fromFile) meeting.externalId = String(same.externalId)
    else
      database
        .prepare("UPDATE meetings SET external_id = ?, updated_at = ? WHERE id = ?")
        .run(meeting.externalId, now, Number(same.id))
    existing = { id: same.id, meeting_series_id: same.seriesId }
  }
  let seriesId = existing ? int(existing.meeting_series_id) : null
  if (seriesInput) {
    if (!seriesInput.externalId) throw new Error("Invalid series key")
    seriesId = upsert(
      database,
      "meeting_series",
      { account_id: meeting.accountId, external_id: seriesInput.externalId },
      {
        title: seriesInput.title,
        description: seriesInput.description,
        kind: seriesInput.kind,
        recurrence: toJson(seriesInput.recurrence),
        host_identity_id: seriesInput.hostIdentityId,
        join_url: seriesInput.joinUrl,
        metadata: toJson(seriesInput.metadata),
        deleted_at: seriesInput.deletedAt,
      },
      now,
    )
  }
  const meetingId = upsert(
    database,
    "meetings",
    { account_id: meeting.accountId, external_id: meeting.externalId },
    {
      meeting_series_id: seriesId,
      title: meeting.title,
      title_folded: folded(meeting.title),
      description: meeting.description,
      location: meeting.location,
      join_url: meeting.joinUrl,
      join_key: meeting.joinUrl ? (joinKeyOf(meeting.joinUrl) ?? "") : null,
      started_at: meeting.startedAt,
      ended_at: meeting.endedAt,
      duration_ms: meeting.durationMs,
      timezone: meeting.timezone,
      host_identity_id: meeting.hostIdentityId,
      ...(meeting.participantsCount === undefined ? {} : { participants_count: meeting.participantsCount }),
      metadata: toJson(meeting.metadata),
      deleted_at: meeting.deletedAt,
    },
    now,
  )

  const participantIds = (input.participants ?? []).map(({ identity, ...p }) =>
    upsert(
      database,
      "meeting_participants",
      {
        meeting_id: meetingId,
        identity_id: meetingIdentityPk({ ...context, now: () => now }, meeting.accountId, identity),
      },
      {
        display_name: p.displayName,
        email: p.email,
        role: p.role,
        joined_at: p.joinedAt,
        left_at: p.leftAt,
        duration_ms: p.durationMs,
        sessions: toJson(p.sessions),
        external_id: p.externalId,
        metadata: toJson(p.metadata),
      },
      now,
    ),
  )
  const participantId = (position: number | null) => {
    if (position === null) return null
    const id = participantIds[position]
    if (id === undefined) throw new Error("Invalid participant position")
    return id
  }

  saveTranscripts(database, meetingId, input.transcripts ?? [], participantId, now)
  if ((input.transcripts ?? []).some((transcript) => transcript.source !== FILE_SOURCE))
    database
      .prepare(
        "UPDATE meeting_transcripts SET superseded_at = ?, updated_at = ? WHERE meeting_id = ? AND source = ? AND superseded_at IS NULL",
      )
      .run(now, now, meetingId, FILE_SOURCE)

  for (const { senderParticipantPosition, ...line } of input.chat ?? []) {
    const values = {
      sent_at: line.sentAt,
      sender_participant_id: participantId(senderParticipantPosition),
      sender_name: line.senderName,
      recipient: line.recipient,
      text: line.text,
      normalized_text: line.normalizedText,
      metadata: toJson(line.metadata),
    }
    // A line without the source's id is the same line when its time, sender and text all match.
    const key: Record<string, SqlValue> =
      line.externalId !== null
        ? { meeting_id: meetingId, external_id: line.externalId }
        : {
            meeting_id: meetingId,
            external_id: null,
            sent_at: line.sentAt,
            sender_name: line.senderName,
            text: line.text,
          }
    upsert(database, "meeting_chat_messages", key, values, now)
  }

  for (const s of input.summaries ?? [])
    upsert(
      database,
      "meeting_summaries",
      { meeting_id: meetingId, source: s.source },
      {
        title: s.title,
        overview: s.overview,
        sections: JSON.stringify(s.sections),
        next_steps: JSON.stringify(s.nextSteps),
        content: s.content,
        doc_url: s.docUrl,
        external_created_at: s.externalCreatedAt,
        external_updated_at: s.externalUpdatedAt,
        metadata: toJson(s.metadata),
      },
      now,
    )

  for (const a of input.attachments ?? []) saveAttachment(database, "meeting", meetingId, a, now)
  return meetingId
}

const saveTranscripts = (
  database: CacheDatabase,
  meetingId: number,
  transcripts: NonNullable<MeetingSave["transcripts"]>,
  participantId: (position: number | null) => number | null,
  now: number,
): { insertedTranscripts: number; replayedTranscripts: number; supersededTranscripts: number } => {
  const counts = { insertedTranscripts: 0, replayedTranscripts: 0, supersededTranscripts: 0 }
  const sameContent = database.prepare(
    "SELECT 1 FROM meeting_transcripts WHERE meeting_id = ? AND source = ? AND content_hash = ?",
  )
  const supersede = database.prepare(
    `UPDATE meeting_transcripts SET superseded_at = ?, updated_at = ?
       WHERE meeting_id = ? AND source = ? AND superseded_at IS NULL`,
  )
  const insertTranscript = database.prepare(
    `INSERT INTO meeting_transcripts (meeting_id, source, format, language, content_hash, external_created_at,
       metadata, created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
  )
  const insertRow = database.prepare(
    `INSERT INTO meeting_transcript_rows (meeting_transcript_id, position, start_ms, end_ms, speaker_participant_id,
       speaker_name, text, normalized_text, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  for (const { rows, ...t } of transcripts) {
    if (t.contentHash !== null && sameContent.get(meetingId, t.source, t.contentHash)) {
      counts.replayedTranscripts++
      continue
    }
    for (const row of rows)
      if (!Number.isSafeInteger(row.position) || row.position < 0) throw new Error("Invalid transcript position")
    counts.supersededTranscripts += Number(supersede.run(now, now, meetingId, t.source).changes)
    counts.insertedTranscripts++
    const transcriptId = Number(
      insertTranscript.get(
        meetingId,
        t.source,
        t.format,
        t.language,
        t.contentHash,
        t.externalCreatedAt,
        toJson(t.metadata),
        now,
        now,
        t.deletedAt,
      )?.id,
    )
    for (const row of rows)
      insertRow.run(
        transcriptId,
        row.position,
        row.startMs,
        row.endMs,
        participantId(row.speakerParticipantPosition),
        row.speakerName,
        row.text,
        row.normalizedText,
        toJson(row.metadata),
        now,
      )
  }
  return counts
}

const append = (context: StoreContext, input: TranscriptAppend): TranscriptAppendReceipt => {
  const invalid = (message: string): never => {
    throw new MeetingError("validation_error", message)
  }
  if (
    !Number.isSafeInteger(input.accountId) ||
    input.accountId <= 0 ||
    !input.externalId?.trim() ||
    !Number.isSafeInteger(input.now) ||
    !Array.isArray(input.transcripts) ||
    input.transcripts.length === 0
  )
    invalid("Invalid transcript append")
  if (
    input.create &&
    (!Number.isSafeInteger(input.create.startedAt) || Math.abs(input.create.startedAt) > 8640000000000000)
  )
    invalid("Invalid meeting start")
  const sources = new Set<string>()
  for (const transcript of input.transcripts) {
    if (!transcript.source?.trim() || !transcript.contentHash?.trim() || sources.has(transcript.source))
      invalid("Expected distinct transcript sources and nonempty hashes")
    sources.add(transcript.source)
    for (const row of transcript.rows)
      if ("speakerParticipantPosition" in row || "speakerParticipantId" in row)
        invalid("Appended transcript rows must be unlinked")
  }
  const { database } = context
  return write(database, () => {
    const existing = database
      .prepare("SELECT id, deleted_at FROM meetings WHERE account_id = ? AND external_id = ?")
      .get(input.accountId, input.externalId)
    if (existing?.deleted_at != null || (!existing && !input.create))
      throw new MeetingError("not_found", "Meeting not found")
    const meetingId = existing
      ? Number(existing.id)
      : save(context, {
          meeting: {
            accountId: input.accountId,
            externalId: input.externalId,
            title: input.create?.title ?? null,
            startedAt: input.create?.startedAt ?? null,
            timezone: input.create?.timezone ?? null,
            description: null,
            location: null,
            joinUrl: null,
            endedAt: null,
            durationMs: null,
            hostIdentityId: null,
            participantsCount: null,
            metadata: null,
            deletedAt: null,
          },
          now: input.now,
        })
    const counts = saveTranscripts(
      database,
      meetingId,
      input.transcripts.map((t) => ({
        ...t,
        rows: t.rows.map((row) => ({ ...row, speakerParticipantPosition: null })),
      })),
      () => null,
      input.now,
    )
    return { meeting: details(database, meetingId) as MeetingDetails, created: !existing, ...counts }
  })
}

const MEETING_COLUMNS = {
  id: { type: "kw", sql: "CAST(id AS TEXT)" },
  title: { type: "kw", sql: "title_folded", folded: true },
  started_at: { type: "time", sql: "started_at" },
  ended_at: { type: "time", sql: "ended_at" },
  duration_ms: { type: "num", sql: "duration_ms" },
  participants_count: { type: "num", sql: "participants_count" },
  created_at: { type: "time", sql: "created_at" },
  updated_at: { type: "time", sql: "updated_at" },
} as const satisfies ColumnMap

const filtered = (filter: MeetingFilter = {}) => {
  const where: string[] = []
  const params: SqlValue[] = []
  const add = (sql: string, value: SqlValue) => {
    where.push(sql)
    params.push(value)
  }
  if (!filter.includeDeleted) where.push("deleted_at IS NULL")
  if (filter.accountId !== undefined) add("account_id = ?", filter.accountId)
  if (filter.eventId !== undefined) add("event_id = ?", filter.eventId)
  if (filter.meetingSeriesId !== undefined) add("meeting_series_id = ?", filter.meetingSeriesId)
  if (filter.since !== undefined) add("started_at >= ?", filter.since)
  if (filter.until !== undefined) add("started_at <= ?", filter.until)
  if (filter.query !== undefined) {
    const compiled = queryFilter(filter.query, MEETING_COLUMNS, { command: "meetings list" })
    where.push(`(${compiled.sql})`)
    params.push(...compiled.params)
  }
  const [limit, offset] = page(filter)
  return {
    sql: `SELECT * FROM meetings${where.length ? ` WHERE ${where.join(" AND ")}` : ""}
      ORDER BY coalesce(started_at, 0) DESC, id LIMIT ? OFFSET ?`,
    params: [...params, limit, offset],
  }
}

/**
 * Indexes what the queue holds, words only. A superseded transcript or a deleted meeting stays indexed and is
 * left out when searching, so changing them does not have to queue every row again.
 */
const legacyTextBytes = (database: CacheDatabase, type: string, id: number): number => {
  const columns = type === "meeting_summary" ? ["title", "overview", "sections", "next_steps", "content"] : ["text"]
  const table =
    type === "meeting_transcript_row"
      ? "meeting_transcript_rows"
      : type === "meeting_chat_message"
        ? "meeting_chat_messages"
        : "meeting_summaries"
  const expression = columns.map((column) => `coalesce(length(CAST(${column} AS BLOB)),0)`).join("+")
  return Number(database.prepare(`SELECT ${expression} AS bytes FROM ${table} WHERE id=?`).get(id)?.bytes ?? 0)
}
const legacyBudget = (size: number): void => {
  if (!Number.isSafeInteger(size) || size < 0 || size > 64 * 1024 ** 2)
    throw new CliError(
      "validation_error",
      "Meeting text exceeds legacy search limits; use bounded searchHits/indexSearch pages",
    )
}

export const drainMeetingIndex = (database: CacheDatabase, batch = 500): number => {
  const next = database.prepare("SELECT indexable_type, id FROM meeting_index_pending LIMIT ?")
  const drop = database.prepare("DELETE FROM meeting_words WHERE rowid = ?")
  const insert = database.prepare("INSERT INTO meeting_words (rowid, normalized_text, scope) VALUES (?, ?, ?)")
  const dequeue = database.prepare("DELETE FROM meeting_index_pending WHERE indexable_type = ? AND id = ?")
  let done = 0
  for (;;) {
    const count = write(database, () => {
      const queued = next.all(batch)
      for (const { indexable_type: type, id } of queued) {
        const kind = String(type)
        if (kind in INDEX_CODES) {
          legacyBudget(legacyTextBytes(database, kind, Number(id)))
          invalidateMeetingStems(database, kind, Number(id))
          const rowid = meetingRowid(kind as Indexable, Number(id))
          drop.run(rowid)
          const words = normalize(indexedText(database, kind, Number(id)) ?? "")
          if (words) insert.run(rowid, words, kind)
        }
        dequeue.run(kind, Number(id))
      }
      return queued.length
    })
    if (count === 0) return done
    done += count
  }
}

/** Each word of the query, as a prefix, all required. */
export const wordsQuery = (query: string): string | null => {
  const words = normalize(query)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
  return words.length ? words.map((word) => `"${word}"*`).join(" AND ") : null
}

/** Pages over meetings, then lists their hits, as the reference store does. */
const search = (database: CacheDatabase, query: string, filter?: MeetingFilter): SearchHit[] => {
  const match = wordsQuery(query)
  if (match === null) return []
  drainMeetingIndex(database)
  return read(database, () => {
    const picked = filtered(filter)
    const rows = database
      .prepare(
        `WITH hit AS (SELECT rowid AS r FROM meeting_words WHERE meeting_words MATCH ?),
       picked AS (SELECT id, row_number() OVER (ORDER BY coalesce(started_at, 0) DESC, id) AS n FROM (${picked.sql}))
       SELECT p.n, 0 AS kind, t.id AS a, r.position AS b, r.id, t.meeting_id, r.start_ms, coalesce(length(CAST(r.text AS BLOB)),0) AS bytes,
              r.speaker_name AS speaker, m.account_id
         FROM hit h JOIN meeting_transcript_rows r ON h.r % 4 = 1 AND r.id = h.r / 4
         JOIN meeting_transcripts t ON t.id = r.meeting_transcript_id
           AND t.superseded_at IS NULL AND t.deleted_at IS NULL
         JOIN picked p ON p.id = t.meeting_id JOIN meetings m ON m.id = t.meeting_id
       UNION ALL
       SELECT p.n, 1, c.id, 0, c.id, c.meeting_id, NULL, coalesce(length(CAST(c.text AS BLOB)),0), NULL, NULL
         FROM hit h JOIN meeting_chat_messages c ON h.r % 4 = 2 AND c.id = h.r / 4
         JOIN picked p ON p.id = c.meeting_id
       UNION ALL
       SELECT p.n, 2, s.id, 0, s.id, s.meeting_id, NULL, coalesce(length(CAST(s.title AS BLOB)),0)+coalesce(length(CAST(s.overview AS BLOB)),0)+coalesce(length(CAST(s.sections AS BLOB)),0)+coalesce(length(CAST(s.next_steps AS BLOB)),0)+coalesce(length(CAST(s.content AS BLOB)),0), NULL, NULL
         FROM hit h JOIN meeting_summaries s ON h.r % 4 = 3 AND s.id = h.r / 4
         JOIN picked p ON p.id = s.meeting_id
       ORDER BY 1, 2, 3, 4 LIMIT 10001`,
      )
      .all(`normalized_text : (${match})`, ...picked.params)
    if (rows.length > 10000)
      throw new CliError("validation_error", "Meeting search exceeds 10000 legacy hits; use bounded searchHits pages")
    let total = 0
    for (const row of rows) {
      total += Number(row.bytes)
      legacyBudget(total)
    }
    const scopes = ["transcript", "chat", "summary"] as const
    return rows.map((row) => {
      const scope = scopes[Number(row.kind)] as SearchHit["scope"]
      const cue =
        scope === "transcript"
          ? {
              ref: formatMeetingReference({
                type: "meeting",
                accountId: Number(row.account_id),
                meetingId: Number(row.meeting_id),
                transcriptId: Number(row.a),
                cuePosition: Number(row.b),
              }),
              speakerName: row.speaker === null ? null : String(row.speaker),
            }
          : {}
      return {
        ...cue,
        meetingId: Number(row.meeting_id),
        scope,
        id: Number(row.id),
        text:
          indexedText(
            database,
            scope === "transcript"
              ? "meeting_transcript_row"
              : scope === "chat"
                ? "meeting_chat_message"
                : "meeting_summary",
            Number(row.id),
          ) ?? "",
        startMs: int(row.start_ms),
      }
    })
  })
}

const participants = (database: CacheDatabase, query: string, accountId?: number): Participant[] => {
  const term = query.toLocaleLowerCase()
  const rows = database
    .prepare(
      `SELECT p.* FROM meeting_participants p JOIN meetings m ON m.id = p.meeting_id
        WHERE ? IS NULL OR m.account_id = ? ORDER BY p.id`,
    )
    .all(accountId ?? null, accountId ?? null)
  // In JS: SQLite's lower() folds only ASCII, and names here are often Cyrillic.
  return rows
    .map(participantOf)
    .filter((p) => `${p.displayName ?? ""} ${p.email ?? ""}`.toLocaleLowerCase().includes(term))
}

export type StoredMeetings = MeetingStore &
  MeetingPreparationContextStore &
  MeetingPreparationKnowledgeStore &
  MeetingPreparationNotesStore &
  MeetingRelatedHistoryStore &
  MeetingSeriesHistoryStore &
  MeetingTranscriptStore &
  MeetingReadCapabilities &
  MeetingContextReadCapabilities &
  MeetingParticipantSearchStore &
  MeetingSearchStore &
  MeetingTranscriptReceiptStore &
  MeetingContextStore &
  MeetingSearchIndexStore &
  MeetingStatsStore &
  MeetingReviewStore &
  MeetingChatLinesStore

/** The `MeetingStore` of `src/meetings/` over the shared store. */
export const meetingStoreOver = (context: StoreContext): StoredMeetings => {
  const { database } = context
  return {
    ...meetingReadsOver(context),
    ...meetingSeriesHistoryOver(context),
    ...meetingPreparationContextOver(context),
    ...meetingPreparationKnowledgeOver(context),
    ...meetingPreparationNotesOver(context),
    ...meetingRelatedHistoryOver(context),
    ...meetingHitSearchOver(context),
    ...meetingStatsOver(context),
    ...meetingReviewOver(context),
    ...meetingChatLinesOver(context),
    ...meetingParticipantSearchOver(context),
    ...meetingHitIndexOver(context),
    ...meetingContextLinksOver(context),
    async appendTranscriptsWithReceipt(input) {
      try {
        return append(context, input)
      } catch (error) {
        if (error instanceof MeetingError) throw new CliError(error.code, error.message)
        throw error
      }
    },
    async appendTranscripts(input) {
      return append(context, input).meeting
    },
    async saveMeeting(input) {
      const id = write(database, () => save(context, input))
      return details(database, id) as MeetingDetails
    },
    async meetings(filter) {
      const { sql, params } = filtered(filter)
      return database
        .prepare(sql)
        .all(...params)
        .map(meetingOf)
    },
    async account(id) {
      const row = database.prepare("SELECT provider, external_id FROM accounts WHERE id = ?").get(id)
      return row ? { provider: String(row.provider), account: String(row.external_id) } : null
    },
    async meeting(id) {
      return details(database, id)
    },
    async participants(query, accountId) {
      return participants(database, query, accountId)
    },
    async search(query, filter) {
      return search(database, query, filter)
    },
    async events() {
      return eventQueries.events(database)
    },
    async queryEvents(query) {
      return eventQueries.events(database, query)
    },
    async eventCandidates(filter) {
      return eventQueries.eventCandidates(database, filter)
    },
    async createEvent(input, now) {
      return eventQueries.createEvent(database, input, now)
    },
    async createEventSeries(input, now) {
      return eventQueries.createEventSeries(database, input, now)
    },
    async setEventSeries(meetingSeriesId, eventSeriesId, now) {
      eventQueries.setEventSeries(database, meetingSeriesId, eventSeriesId, now)
    },
    async linkMeeting(id, eventId, now, mode) {
      eventQueries.linkMeeting(database, id, eventId, now, mode)
    },
    async reviewMeetingLink(meetingId, eventIds, now) {
      write(database, () =>
        reviewLink(database, { type: "meeting", id: meetingId }, "event", eventIds, "join-key", now),
      )
    },
    async cursor(accountId) {
      return str(
        database.prepare("SELECT value FROM sync_cursors WHERE account_id = ? AND key = ?").get(accountId, CURSOR_KEY)
          ?.value,
      )
    },
    async setCursor(accountId, value, now) {
      database
        .prepare(
          `INSERT INTO sync_cursors (account_id, key, value, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (account_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        )
        .run(accountId, CURSOR_KEY, value, now, now)
    },
  }
}
