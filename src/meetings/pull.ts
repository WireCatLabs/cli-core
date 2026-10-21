import { linkEvent } from "./events.js"
import { speakerPosition, timestamp, transcriptInput } from "./ingest.js"
import type { MeetingSource, SourceParticipant } from "./source.js"
import type { MeetingInput, MeetingStore, ParticipantInput } from "./store.js"

export interface RunReport {
  meetings: number
  participants: number
  transcriptRows: number
  summaries: number
  warnings: { externalId: string; message: string }[]
  /** An import whose files all read their start time in one zone names it; files carry no zone of their own. */
  timezone?: string
}
export interface PullOptions {
  accountId: number
  since?: string
  now?: number
  /** Revisit recent occurrences; integer milliseconds from 0 through 31 days. Defaults to 0. */
  lookbackMs?: number
}
const participantInput = (
  p: SourceParticipant,
  provider: string,
  occurrenceId: string,
  position: number,
  accountId: number,
): ParticipantInput => {
  const { identityExternalId, ...fields } = p
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
      metadata: p.metadata,
      associatePerson: Boolean(identityExternalId?.trim() || p.email?.trim() || p.externalId?.trim()),
    },
  }
}

export const pull = async (source: MeetingSource, store: MeetingStore, options: PullOptions): Promise<RunReport> => {
  const now = options.now ?? Date.now()
  const lookbackMs = options.lookbackMs ?? 0
  if (!Number.isSafeInteger(lookbackMs) || lookbackMs < 0 || lookbackMs > 31 * 86400000)
    throw new Error("lookbackMs must be an integer from 0 through 31 days")
  const since = options.since ?? (await store.cursor(options.accountId)) ?? new Date(now - 30 * 86400000).toISOString()
  timestamp(since)
  const report: RunReport = { meetings: 0, participants: 0, transcriptRows: 0, summaries: 0, warnings: [] }
  let failed = false
  const from = timestamp(since) - lookbackMs
  const meetings = await source.meetings(lookbackMs === 0 ? since : new Date(from).toISOString())
  for (const m of meetings) {
    const id = m.occurrence.id
    const read = async <T>(part: string, call: () => Promise<T | null>): Promise<T | null | undefined> => {
      try {
        return await call()
      } catch (error) {
        failed = true
        const message = error instanceof Error ? error.message : "could not be read"
        report.warnings.push({ externalId: id, message: `${part}: ${message}` })
        return undefined
      }
    }
    try {
      const sourceParticipants = await read("participants", () => source.participants(id))
      const participants = (sourceParticipants ?? []).map((p, i) =>
        participantInput(p, source.provider, id, i, options.accountId),
      )
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
      const startedAt = timestamp(m.occurrence.startedAt)
      const endedAt = m.occurrence.endedAt === null ? null : timestamp(m.occurrence.endedAt)
      if (endedAt !== null && endedAt < startedAt) throw new Error("Meeting ends before it starts")
      const meeting: MeetingInput = {
        accountId: options.accountId,
        externalId: id,
        title: m.occurrence.title,
        description: m.description ?? null,
        location: m.location ?? null,
        joinUrl: m.joinUrl ?? m.series?.joinUrl ?? null,
        startedAt,
        endedAt,
        durationMs: endedAt === null ? null : endedAt - startedAt,
        timezone: m.timezone ?? null,
        hostIdentityId: null,
        ...(sourceParticipants === undefined ? {} : { participantsCount: sourceParticipants?.length ?? null }),
        metadata: m.metadata ?? null,
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
        attachments: attachments ?? undefined,
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
      await linkEvent(store, details, now)
      report.meetings++
      report.participants += participants.length
      report.transcriptRows += lines?.length ?? 0
      report.summaries += summary ? 1 : 0
    } catch (error) {
      failed = true
      report.warnings.push({ externalId: id, message: error instanceof Error ? error.message : "Meeting pull failed" })
    }
  }
  // A failed occurrence must remain inside the next pull's retry window.
  if (!failed) await store.setCursor(options.accountId, new Date(now).toISOString(), now)
  return report
}
