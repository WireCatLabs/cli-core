import type { Event, EventSeries, MeetingSeries } from "../model.js"
import type { MeetingDetails, MeetingFilter, MeetingSave, MeetingStore, SearchHit } from "../store.js"

interface State {
  nextId: number
  meetings: MeetingDetails[]
  series: MeetingSeries[]
  identities: { id: number; provider: string; externalId: string }[]
  events: Event[]
  eventSeries: EventSeries[]
  cursors: Map<number, string>
}
const overlap = (start: number | null, end: number | null, from: number, to: number) =>
  start !== null && end !== null && start <= to && end >= from
const filterMeetings = (rows: MeetingDetails[], filter: MeetingFilter = {}) => {
  if (filter.limit !== undefined && (!Number.isInteger(filter.limit) || filter.limit < 0))
    throw new Error("Invalid limit")
  if (filter.offset !== undefined && (!Number.isInteger(filter.offset) || filter.offset < 0))
    throw new Error("Invalid offset")
  return rows
    .filter(
      ({ meeting: m }) =>
        (filter.includeDeleted || m.deletedAt === null) &&
        (filter.accountId === undefined || m.accountId === filter.accountId) &&
        (filter.eventId === undefined || m.eventId === filter.eventId) &&
        (filter.meetingSeriesId === undefined || m.meetingSeriesId === filter.meetingSeriesId) &&
        (filter.since === undefined || (m.startedAt !== null && m.startedAt >= filter.since)) &&
        (filter.until === undefined || (m.startedAt !== null && m.startedAt <= filter.until)),
    )
    .sort((a, b) => (b.meeting.startedAt ?? 0) - (a.meeting.startedAt ?? 0) || a.meeting.id - b.meeting.id)
    .slice(filter.offset ?? 0, filter.limit === undefined ? undefined : (filter.offset ?? 0) + filter.limit)
}

export const memoryMeetingStore = (): MeetingStore => {
  let state: State = {
    nextId: 1,
    meetings: [],
    series: [],
    identities: [],
    events: [],
    eventSeries: [],
    cursors: new Map(),
  }
  const requireMeeting = (id: number) => {
    const details = state.meetings.find((d) => d.meeting.id === id)
    if (!details) throw new Error("Meeting not found")
    return details
  }
  return {
    async saveMeeting(input) {
      const draft = structuredClone(state)
      const saved = save(draft, structuredClone(input))
      state = draft
      return structuredClone(saved)
    },
    async meetings(filter) {
      return structuredClone(filterMeetings(state.meetings, filter).map((d) => d.meeting))
    },
    async meeting(id) {
      return structuredClone(state.meetings.find((d) => d.meeting.id === id) ?? null)
    },
    async participants(query, accountId) {
      const term = query.toLocaleLowerCase()
      return structuredClone(
        state.meetings
          .filter((d) => accountId === undefined || d.meeting.accountId === accountId)
          .flatMap((d) => d.participants)
          .filter((p) => `${p.displayName ?? ""} ${p.email ?? ""}`.toLocaleLowerCase().includes(term)),
      )
    },
    async search(query, filter) {
      const term = query.trim().toLocaleLowerCase()
      if (!term) return []
      return filterMeetings(state.meetings, filter).flatMap((d) => {
        const rows: SearchHit[] = d.transcripts
          .filter((t) => t.transcript.supersededAt === null && t.transcript.deletedAt === null)
          .flatMap((t) =>
            t.rows.map((r) => ({
              meetingId: d.meeting.id,
              scope: "transcript" as const,
              id: r.id,
              text: r.text,
              startMs: r.startMs,
            })),
          )
        rows.push(
          ...d.chat.map((r) => ({
            meetingId: d.meeting.id,
            scope: "chat" as const,
            id: r.id,
            text: r.text,
            startMs: null,
          })),
        )
        const hits = [
          ...rows,
          ...d.summaries.map((s) => ({
            meetingId: d.meeting.id,
            scope: "summary" as const,
            id: s.id,
            text: [s.title, s.overview, ...s.sections.map((p) => p.text), ...s.nextSteps, s.content]
              .filter(Boolean)
              .join("\n"),
            startMs: null,
          })),
        ]
        return hits.filter((r) => r.text.toLocaleLowerCase().includes(term))
      })
    },
    async events() {
      return structuredClone(state.events.filter((e) => e.deletedAt === null))
    },
    async eventCandidates(filter) {
      const series = state.series.find((s) => s.id === filter.meetingSeriesId)
      return structuredClone(
        state.events.filter(
          (e) =>
            e.deletedAt === null &&
            overlap(e.startsAt, e.endsAt, filter.startsAt, filter.endsAt) &&
            ((series?.eventSeriesId != null && e.eventSeriesId === series.eventSeriesId) ||
              state.meetings.some(
                (d) =>
                  d.meeting.eventId === e.id &&
                  d.meeting.deletedAt === null &&
                  filter.joinUrl !== null &&
                  d.meeting.joinUrl === filter.joinUrl,
              )),
        ),
      )
    },
    async createEvent(input, now) {
      const event = { ...structuredClone(input), id: state.nextId++, createdAt: now, updatedAt: now }
      if (event.eventSeriesId !== null && !state.eventSeries.some((s) => s.id === event.eventSeriesId))
        throw new Error("Event series not found")
      state.events.push(event)
      return structuredClone(event)
    },
    async createEventSeries(input, now) {
      const series = { ...structuredClone(input), id: state.nextId++, createdAt: now, updatedAt: now }
      state.eventSeries.push(series)
      return structuredClone(series)
    },
    async setEventSeries(meetingSeriesId, eventSeriesId, now) {
      const series = state.series.find((s) => s.id === meetingSeriesId)
      if (!series || !state.eventSeries.some((s) => s.id === eventSeriesId)) throw new Error("Series not found")
      series.eventSeriesId = eventSeriesId
      series.updatedAt = now
      for (const d of state.meetings) if (d.series?.id === meetingSeriesId) d.series = structuredClone(series)
    },
    async linkMeeting(id, eventId, now, mode = "auto") {
      const d = requireMeeting(id)
      if (!state.events.some((e) => e.id === eventId)) throw new Error("Event not found")
      if (mode === "owner" || d.meeting.eventId === null) {
        d.meeting.eventId = eventId
        d.meeting.updatedAt = now
      }
    },
    async cursor(accountId) {
      return state.cursors.get(accountId) ?? null
    },
    async setCursor(accountId, value) {
      state.cursors.set(accountId, value)
    },
  }
}

const save = (state: State, input: MeetingSave): MeetingDetails => {
  const {
    meeting: { series: seriesInput, ...meeting },
    now,
  } = input
  if (!Number.isSafeInteger(meeting.accountId) || meeting.accountId <= 0 || !meeting.externalId)
    throw new Error("Invalid meeting key")
  let details = state.meetings.find(
    (d) => d.meeting.accountId === meeting.accountId && d.meeting.externalId === meeting.externalId,
  )
  let series = details?.series ?? null
  if (seriesInput) {
    series =
      state.series.find((s) => s.accountId === meeting.accountId && s.externalId === seriesInput.externalId) ?? null
    if (series) Object.assign(series, seriesInput, { updatedAt: now })
    else {
      series = {
        ...seriesInput,
        id: state.nextId++,
        accountId: meeting.accountId,
        eventSeriesId: null,
        createdAt: now,
        updatedAt: now,
      }
      state.series.push(series)
    }
  }
  if (series)
    for (const stored of state.meetings) if (stored.meeting.meetingSeriesId === series.id) stored.series = series
  if (details) Object.assign(details.meeting, meeting, { updatedAt: now, meetingSeriesId: series?.id ?? null })
  else {
    details = {
      meeting: {
        ...meeting,
        id: state.nextId++,
        meetingSeriesId: series?.id ?? null,
        eventId: null,
        createdAt: now,
        updatedAt: now,
      },
      series,
      participants: [],
      transcripts: [],
      chat: [],
      summaries: [],
      attachments: [],
    }
    state.meetings.push(details)
  }
  details.series = series
  const meetingId = details.meeting.id
  const participantIds = (input.participants ?? []).map(({ identity, ...p }) => {
    if (!identity.provider || !identity.externalId) throw new Error("Invalid identity key")
    let stored = state.identities.find((i) => i.provider === identity.provider && i.externalId === identity.externalId)
    if (!stored) {
      stored = { id: state.nextId++, provider: identity.provider, externalId: identity.externalId }
      state.identities.push(stored)
    }
    let participant = details.participants.find((r) => r.identityId === stored.id)
    if (participant) Object.assign(participant, p, { updatedAt: now })
    else {
      participant = { ...p, id: state.nextId++, identityId: stored.id, meetingId, createdAt: now, updatedAt: now }
      details.participants.push(participant)
    }
    return participant.id
  })
  const participantId = (position: number | null) => {
    if (position === null) return null
    const id = participantIds[position]
    if (id === undefined) throw new Error("Invalid participant position")
    return id
  }
  for (const { rows, ...transcript } of input.transcripts ?? []) {
    if (
      transcript.contentHash !== null &&
      details.transcripts.some(
        (t) => t.transcript.source === transcript.source && t.transcript.contentHash === transcript.contentHash,
      )
    )
      continue
    const positions = new Set<number>()
    for (const row of rows) {
      if (!Number.isSafeInteger(row.position) || row.position < 0 || positions.has(row.position))
        throw new Error("Invalid transcript position")
      positions.add(row.position)
    }
    for (const old of details.transcripts)
      if (old.transcript.source === transcript.source && old.transcript.supersededAt === null) {
        old.transcript.supersededAt = now
        old.transcript.updatedAt = now
      }
    const stored = { ...transcript, id: state.nextId++, meetingId, supersededAt: null, createdAt: now, updatedAt: now }
    details.transcripts.push({
      transcript: stored,
      rows: rows.map(({ speakerParticipantPosition, ...r }) => ({
        ...r,
        id: state.nextId++,
        meetingTranscriptId: stored.id,
        speakerParticipantId: participantId(speakerParticipantPosition),
        createdAt: now,
      })),
    })
  }
  for (const { senderParticipantPosition, ...line } of input.chat ?? []) {
    let old = details.chat.find((r) =>
      line.externalId !== null
        ? r.externalId === line.externalId
        : r.externalId === null && r.sentAt === line.sentAt && r.senderName === line.senderName && r.text === line.text,
    )
    const fields = { ...line, senderParticipantId: participantId(senderParticipantPosition) }
    if (old) Object.assign(old, fields, { updatedAt: now })
    else {
      old = { ...fields, id: state.nextId++, meetingId, createdAt: now, updatedAt: now }
      details.chat.push(old)
    }
  }
  for (const summary of input.summaries ?? []) {
    const old = details.summaries.find((s) => s.source === summary.source)
    if (old) Object.assign(old, summary, { updatedAt: now })
    else details.summaries.push({ ...summary, id: state.nextId++, meetingId, createdAt: now, updatedAt: now })
  }
  for (const attachment of input.attachments ?? []) {
    const old = details.attachments.find((a) => a.position === attachment.position)
    if (old) Object.assign(old, attachment, { updatedAt: now })
    else
      details.attachments.push({
        ...attachment,
        id: state.nextId++,
        attachableType: "meeting",
        attachableId: meetingId,
        createdAt: now,
        updatedAt: now,
      })
  }
  return details
}
