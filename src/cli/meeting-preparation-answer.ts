import { CliError } from "@wirecat/cli-base"
import * as v from "valibot"
import { meetingPreparation } from "../entities/index.js"
import type { MeetingPreparation } from "../services/index.js"
import { itemOf, metaNow, sealed, snakeKeys } from "./envelope.js"

const id = (value: number | null) => (value === null ? null : String(value))
const at = (value: number | null) => (value === null ? null : new Date(value).toISOString())

const mapMeeting = (meeting: MeetingPreparation["items"][number]["meeting"]) => {
  return {
    ...meeting,
    id: id(meeting.id),
    eventId: id(meeting.eventId),
    startedAt: at(meeting.startedAt),
    endedAt: at(meeting.endedAt),
    updatedAt: at(meeting.updatedAt),
  }
}
const mapEvidence = (evidence: MeetingPreparation["items"][number]["evidence"]) => {
  return {
    ...evidence,
    coverage: { ...evidence.coverage, nextTranscriptId: id(evidence.coverage.nextTranscriptId) },
    items: evidence.items.map(({ reference, startMs, ...cue }) => ({
      ...cue,
      ref: reference,
      offsetMs: startMs,
      transcriptId: id(cue.transcriptId),
      speakerParticipantId: id(cue.speakerParticipantId),
    })),
  }
}

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
    ...(packet.knowledge
      ? {
          knowledge: {
            ...packet.knowledge,
            items: packet.knowledge.items.map((fact) => ({ ...fact, updatedAt: at(fact.updatedAt) })),
          },
        }
      : {}),
    related: {
      ...packet.related,
      items: packet.related.items.map(({ reference, ...entry }) => ({
        ...entry,
        ref: reference,
        meeting: mapMeeting(entry.meeting),
        evidence: mapEvidence(entry.evidence),
      })),
    },
    meetings: packet.items.map((entry) => ({
      ref: entry.reference,
      meeting: mapMeeting(entry.meeting),
      evidence: mapEvidence(entry.evidence),
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
  for (const entry of [...item.meetings, ...item.related.items])
    entry.evidence.content_bytes = Buffer.byteLength(JSON.stringify(entry.evidence.items), "utf8")
  const size = () => Buffer.byteLength(JSON.stringify(item), "utf8")
  while (size() > item.limits.bytes && item.knowledge?.items.length) {
    item.knowledge.items.pop()
    item.knowledge.coverage.output_limited = item.coverage.output_limited = true
  }
  if (size() > item.limits.bytes && item.knowledge) {
    delete item.knowledge
    item.coverage.output_limited = true
  }
  while (size() > item.limits.bytes && item.related.items.length) {
    item.related.items.pop()
    item.related.output_limited = item.coverage.output_limited = true
  }
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
