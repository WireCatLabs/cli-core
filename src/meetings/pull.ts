import { linkEvent } from "./events.js"
import { speakerPosition, timestamp, transcriptInput } from "./ingest.js"
import type { Meeting, SourceChatLine, SourceMeeting, SummaryContent, TranscriptLine } from "./model.js"
import type { MeetingSource, SourceParticipant } from "./source.js"
import type {
  MeetingDetails,
  MeetingDocumentInput,
  MeetingInput,
  MeetingSave,
  MeetingStore,
  ParticipantInput,
} from "./store.js"

export interface RunReport {
  meetings: number
  participants: number
  transcriptRows: number
  summaries: number
  warnings: { externalId: string; message: string }[]
  /** An import whose files all read their start time in one zone names it; files carry no zone of their own. */
  timezone?: string
  /** A pull stopped by its budget before every meeting it listed: why, and how many it did not reach. */
  stopped?: MeetingBudgetStop
  remaining?: number
}

export type MeetingBudgetStop = "requests" | "deadline" | "cancelled"

/** One meeting more, or why not: `runBudgetOf(command)` from `@wirecat/cli-core/cli` fits. */
export interface MeetingBudget {
  take(): MeetingBudgetStop | null
}
export interface PullOptions {
  accountId: number
  since?: string
  now?: number
  /** Revisit recent occurrences; integer milliseconds from 0 through 31 days. Defaults to the source's `overlapMs`. */
  lookbackMs?: number
  /** Start from 30 days back, not from the cursor. */
  rescan?: boolean
  /** Asked before each meeting; a stop keeps what is saved and moves the cursor to the first meeting not reached. */
  budget?: MeetingBudget
}
const participantInput = (
  p: SourceParticipant,
  provider: string,
  occurrenceId: string,
  position: number,
  accountId: number,
): ParticipantInput => {
  const { identityExternalId, phone, ...fields } = p
  const externalId =
    identityExternalId ??
    (p.email ? `email:${p.email.toLowerCase()}` : p.externalId) ??
    `name:${p.displayName ?? "unknown"}@${accountId}/${occurrenceId}:${position}`
  return {
    ...fields,
    identity: {
      provider,
      externalId,
      name: p.displayName,
      ...(phone?.trim() ? { phone } : {}),
      metadata: p.metadata,
      associatePerson: Boolean(identityExternalId?.trim() || p.email?.trim() || p.externalId?.trim()),
    },
  }
}

const participantInputs = (provider: string, occurrenceId: string, list: SourceParticipant[], accountId: number) =>
  list.map((p, i) => participantInput(p, provider, occurrenceId, i, accountId))

/** What was read of one meeting besides the meeting itself; `undefined` is not read, `null` is unavailable. */
export interface SourceMeetingParts {
  participants?: SourceParticipant[] | null
  transcript?: TranscriptLine[] | null
  chat?: SourceChatLine[] | null
  summary?: SummaryContent | null
  files?: NonNullable<MeetingSave["attachments"]> | null
  documents?: MeetingDocumentInput[] | null
}

/**
 * The meetings row of a meeting the service returned. With `kept`, the stored row, a field the record leaves empty
 * keeps the stored value and the metadata merges: a live read's record may be thinner than what sync stored.
 */
export const sourceMeetingInput = (
  m: SourceMeeting,
  accountId: number,
  participantsCount: number | null | undefined,
  kept?: Meeting,
): MeetingInput => {
  const startedAt = timestamp(m.occurrence.startedAt)
  const given = m.occurrence.endedAt === null ? null : timestamp(m.occurrence.endedAt)
  if (given !== null && given < startedAt) throw new Error("Meeting ends before it starts")
  const keptEnd = kept?.endedAt ?? null
  const endedAt = given ?? (keptEnd !== null && keptEnd >= startedAt ? keptEnd : null)
  const count = participantsCount === null && kept ? kept.participantsCount : participantsCount
  const metadata =
    kept?.metadata && m.metadata ? { ...kept.metadata, ...m.metadata } : (m.metadata ?? kept?.metadata ?? null)
  const meeting: MeetingInput = {
    accountId,
    externalId: m.occurrence.id,
    title: m.occurrence.title,
    description: m.description ?? kept?.description ?? null,
    location: m.location ?? kept?.location ?? null,
    joinUrl: m.joinUrl ?? m.series?.joinUrl ?? kept?.joinUrl ?? null,
    startedAt,
    endedAt,
    durationMs: endedAt === null ? null : endedAt - startedAt,
    timezone: m.timezone ?? kept?.timezone ?? null,
    hostIdentityId: kept?.hostIdentityId ?? null,
    ...(count === undefined ? {} : { participantsCount: count }),
    metadata,
    deletedAt: null,
  }
  if (m.series)
    meeting.series = {
      externalId: m.series.id,
      title: m.series.title,
      description: null,
      kind: m.series.kind ?? null,
      recurrence: m.series.recurrence ?? null,
      hostIdentityId: null,
      joinUrl: m.series.joinUrl ?? null,
      metadata: null,
      deletedAt: null,
    }
  return meeting
}

/**
 * Saves one meeting as `meetings sync` does, keyed by its occurrence id, and links its event: `sync` and the reads that
 * keep what the service returned write the same row. It never moves the sync's cursor. A live read passes `kept`, the
 * stored row, so a thinner record does not empty what sync stored (`sourceMeetingInput`).
 */
export const saveSourceMeeting = async (
  source: Pick<MeetingSource, "provider" | "name" | "transcriptFormat" | "createsEvents">,
  store: MeetingStore,
  m: SourceMeeting,
  parts: SourceMeetingParts,
  { accountId, now, kept }: { accountId: number; now: number; kept?: Meeting },
): Promise<MeetingDetails> => {
  const id = m.occurrence.id
  const { participants: sourceParticipants, transcript: lines, chat, summary } = parts
  const participants = participantInputs(source.provider, id, sourceParticipants ?? [], accountId)
  const meeting = sourceMeetingInput(
    m,
    accountId,
    sourceParticipants === undefined ? undefined : (sourceParticipants?.length ?? null),
    kept,
  )
  const linked = sourceParticipants !== undefined
  const format = source.transcriptFormat ?? null
  const transcripts =
    lines && linked ? [await transcriptInput(lines, participants, source.name, undefined, format)] : undefined
  const details = await store.saveMeeting({
    meeting,
    participants: sourceParticipants ? participants : undefined,
    transcripts,
    chat: chat?.map((line) => ({
      externalId: null,
      sentAt: timestamp(line.sentAt),
      senderParticipantPosition: speakerPosition(line.sender, participants),
      senderName: line.sender,
      recipient: null,
      text: line.text,
      normalizedText: null,
      metadata: null,
    })),
    summaries: summary
      ? [
          {
            ...summary,
            source: summary.source ?? source.name,
            content: summary.content ?? null,
            docUrl: summary.docUrl ?? null,
            externalCreatedAt: summary.externalCreatedAt ?? null,
            externalUpdatedAt: summary.externalUpdatedAt ?? null,
            metadata: summary.metadata ?? null,
          },
        ]
      : undefined,
    attachments: parts.files ?? undefined,
    documents: parts.documents ?? undefined,
    now,
  })
  // Without participants the rows cannot be linked: they are saved only when the meeting has no current
  // transcript to downgrade, under a distinct hash so the retry that reads participants is not a replay.
  if (
    lines &&
    !linked &&
    !details.transcripts.some((t) => t.transcript.source === source.name && t.transcript.supersededAt === null)
  )
    await store.saveMeeting({
      meeting,
      transcripts: [await transcriptInput(lines, [], source.name, `${JSON.stringify(lines)}\nunlinked`, format)],
      now,
    })
  await linkEvent(store, details, now, { create: source.createsEvents !== false })
  return details
}

/** A start that does not parse sorts last; its own save reports it. */
const startOf = (m: SourceMeeting): number => {
  const at = Date.parse(m.occurrence.startedAt)
  return Number.isFinite(at) ? at : Number.POSITIVE_INFINITY
}

export const pull = async (source: MeetingSource, store: MeetingStore, options: PullOptions): Promise<RunReport> => {
  const now = options.now ?? Date.now()
  for (const [name, ms] of [
    ["lookbackMs", options.lookbackMs ?? 0],
    ["overlapMs", source.overlapMs ?? 0],
  ] as const)
    if (!Number.isSafeInteger(ms) || ms < 0 || ms > 31 * 86400000)
      throw new Error(`${name} must be an integer from 0 through 31 days`)
  const lookbackMs = Math.max(options.lookbackMs ?? 0, source.overlapMs ?? 0)
  const cursor = options.rescan ? undefined : await store.cursor(options.accountId)
  const since = options.since ?? cursor ?? new Date(now - 30 * 86400000).toISOString()
  timestamp(since)
  const report: RunReport = { meetings: 0, participants: 0, transcriptRows: 0, summaries: 0, warnings: [] }
  let failed = false
  /** The start of the first meeting that failed: the cursor of a stopped pull goes no further. */
  let firstFailed: number | undefined
  const callers = new Set<string>()
  const linkCallers = async () => {
    if (callers.size === 0 || !store.linkCallers) return
    try {
      await store.linkCallers(source.provider, [...callers])
    } catch (error) {
      report.warnings.push({
        externalId: source.provider,
        message: `callers not linked to people: ${error instanceof Error ? error.message : "failed"}`,
      })
    }
  }
  const from = timestamp(since) - lookbackMs
  // Oldest first, so a stopped pull leaves everything before its cursor done.
  const meetings = (await source.meetings(lookbackMs === 0 ? since : new Date(from).toISOString())).toSorted(
    (a, b) => startOf(a) - startOf(b),
  )
  for (const [index, m] of meetings.entries()) {
    const stop = options.budget?.take() ?? null
    if (stop) {
      report.stopped = stop
      report.remaining = meetings.length - index
      const reached = Math.min(startOf(m), firstFailed ?? Number.POSITIVE_INFINITY)
      if (Number.isFinite(reached) && reached > timestamp(since))
        await store.setCursor(options.accountId, new Date(reached).toISOString(), now)
      await linkCallers()
      return report
    }
    const id = m.occurrence.id
    const failedHere = () => {
      failed = true
      firstFailed ??= startOf(m)
    }
    const read = async <T>(part: string, call: () => Promise<T | null>): Promise<T | null | undefined> => {
      try {
        return await call()
      } catch (error) {
        failedHere()
        const message = error instanceof Error ? error.message : "could not be read"
        report.warnings.push({ externalId: id, message: `${part}: ${message}` })
        return undefined
      }
    }
    try {
      const sourceParticipants = await read("participants", () => source.participants(id))
      const participants = participantInputs(source.provider, id, sourceParticipants ?? [], options.accountId)
      const names = new Map<string, Set<string>>()
      for (const p of participants)
        if (p.displayName !== null) {
          const identities = names.get(p.displayName) ?? new Set<string>()
          identities.add(p.identity.externalId)
          names.set(p.displayName, identities)
        }
      if ([...names.values()].some((ids) => ids.size > 1))
        report.warnings.push({ externalId: id, message: "Participant names are ambiguous" })
      const lines = await read("transcript", () => source.transcript(id))
      const chat = await read("chat", () => source.chat(id))
      const summary = await read("summary", () => source.summary(id))
      const attachments = await read("files", () => source.files(id))
      const listDocuments = source.documents?.bind(source)
      const documents = listDocuments ? await read("documents", () => listDocuments(id)) : undefined
      await saveSourceMeeting(
        source,
        store,
        m,
        { participants: sourceParticipants, transcript: lines, chat, summary, files: attachments, documents },
        { accountId: options.accountId, now },
      )
      for (const p of participants) if (p.identity.phone) callers.add(p.identity.externalId)
      report.meetings++
      report.participants += participants.length
      report.transcriptRows += lines?.length ?? 0
      report.summaries += summary ? 1 : 0
    } catch (error) {
      failedHere()
      report.warnings.push({ externalId: id, message: error instanceof Error ? error.message : "Meeting pull failed" })
    }
  }
  await linkCallers()
  // A failed occurrence must remain inside the next pull's retry window.
  if (!failed) await store.setCursor(options.accountId, new Date(now).toISOString(), now)
  return report
}
