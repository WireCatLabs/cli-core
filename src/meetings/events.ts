import type { Event } from "./model.js"
import type { MeetingDetails, MeetingStore } from "./store.js"

export const linkEvent = async (
  store: MeetingStore,
  details: MeetingDetails,
  now = Date.now(),
): Promise<Event | null> => {
  const current = await store.meeting(details.meeting.id)
  if (!current) return null
  const { meeting, series } = current
  if (meeting.eventId !== null) return (await store.events()).find((e) => e.id === meeting.eventId) ?? null
  const candidates =
    meeting.startedAt === null
      ? []
      : await store.eventCandidates({
          meetingSeriesId: meeting.meetingSeriesId,
          joinUrl: meeting.joinUrl,
          startsAt: meeting.startedAt,
          endsAt: meeting.endedAt ?? meeting.startedAt,
        })
  let event = candidates.length === 1 ? candidates[0] : undefined
  if (!event) {
    let eventSeriesId = series?.eventSeriesId ?? null
    if (series?.kind === "recurring" && eventSeriesId === null) {
      const created = await store.createEventSeries({ title: series.title, recurrence: null, origin: "auto" }, now)
      eventSeriesId = created.id
      await store.setEventSeries(series.id, eventSeriesId, now)
    }
    event = await store.createEvent(
      {
        eventSeriesId,
        title: meeting.title,
        description: meeting.description,
        location: meeting.location,
        startsAt: meeting.startedAt,
        endsAt: meeting.endedAt,
        timezone: meeting.timezone,
        origin: "auto",
        deletedAt: null,
      },
      now,
    )
  }
  await store.linkMeeting(meeting.id, event.id, now)
  const linked = await store.meeting(meeting.id)
  return (await store.events()).find((e) => e.id === linked?.meeting.eventId) ?? null
}
