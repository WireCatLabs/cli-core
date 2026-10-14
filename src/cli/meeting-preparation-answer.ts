import { CliError } from "@wirecat/cli-base"
import * as v from "valibot"
import { meetingPreparation } from "../entities/index.js"
import type { MeetingPreparation } from "../services/index.js"
import { itemOf, metaNow, sealed, snakeKeys } from "./envelope.js"

const id = (value: number | null) => (value === null ? null : String(value))
const at = (value: number | null) => (value === null ? null : new Date(value).toISOString())

export const meetingPreparationAnswer = (packet: MeetingPreparation) => {
  const candidate = packet.upcoming.candidate
  const mapped = snakeKeys({
    ...packet,
    kind: "meeting_preparation",
    accountId: String(packet.accountId),
    upcoming: {
      ...packet.upcoming,
      after: at(packet.upcoming.after),
      until: at(packet.upcoming.until),
      candidate: candidate && { ...candidate, startAt: at(candidate.startAt), endAt: at(candidate.endAt) },
    },
    series: packet.series && {
      ...packet.series,
      id: id(packet.series.id),
      eventSeriesId: id(packet.series.eventSeriesId),
      updatedAt: at(packet.series.updatedAt),
    },
    historyWindow: { after: at(packet.historyWindow.after), before: at(packet.historyWindow.before) },
    meetings: packet.items.map((entry) => ({
      ref: entry.reference,
      meeting: {
        ...entry.meeting,
        id: id(entry.meeting.id),
        eventId: id(entry.meeting.eventId),
        startedAt: at(entry.meeting.startedAt),
        endedAt: at(entry.meeting.endedAt),
        updatedAt: at(entry.meeting.updatedAt),
      },
      evidence: {
        ...entry.evidence,
        coverage: { ...entry.evidence.coverage, nextTranscriptId: id(entry.evidence.coverage.nextTranscriptId) },
        items: entry.evidence.items.map(({ reference, startMs, ...cue }) => ({
          ...cue,
          ref: reference,
          offsetMs: startMs,
          transcriptId: id(cue.transcriptId),
          speakerParticipantId: id(cue.speakerParticipantId),
        })),
      },
      context: {
        participants: {
          ...entry.context.participants,
          items: entry.context.participants.items.map((p) => ({ ...p, id: id(p.id), identityId: id(p.identityId) })),
        },
        projects: {
          ...entry.context.projects,
          items: entry.context.projects.items.map((p) => ({ ...p, linkId: id(p.linkId) })),
        },
        facts: {
          ...entry.context.facts,
          items: entry.context.facts.items.map((f) => ({ ...f, updatedAt: at(f.updatedAt) })),
        },
        tasks: entry.context.tasks,
      },
    })),
  }) as Record<string, unknown>
  delete mapped.items
  const parsed = v.safeParse(meetingPreparation, mapped)
  if (!parsed.success) throw new CliError("invalid_response", "Meeting preparation does not match its answer contract")
  const item = parsed.output
  for (const entry of item.meetings)
    entry.evidence.content_bytes = Buffer.byteLength(JSON.stringify(entry.evidence.items), "utf8")
  const size = () => Buffer.byteLength(JSON.stringify(item), "utf8")
  while (size() > item.limits.bytes && item.meetings.length) {
    item.meetings.pop()
    item.coverage.output_limited = true
  }
  if (size() > item.limits.bytes)
    throw new CliError("validation_error", "Preparation metadata exceeds bytes; increase the output budget")
  return sealed(
    itemOf(item, {
      meta: metaNow({
        complete: item.coverage.skipped_unavailable.length === 0,
        ...(item.coverage.skipped_unavailable.length
          ? { issues: item.coverage.skipped_unavailable.map((source) => ({ code: "not_found" as const, source })) }
          : {}),
        ...(item.coverage.output_limited ? { truncated: true } : {}),
      }),
    }),
  )
}
