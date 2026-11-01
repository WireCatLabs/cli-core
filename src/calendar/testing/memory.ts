import { CliError } from "@wirecat/cli-base"
import type {
  EntryAttachment,
  EntryInput,
  EntryRevision,
  EventFilter,
  EventStore,
  LinkReview,
  StoredCalendar,
  StoredEntry,
  StoredParticipant,
} from "../../meetings/index.js"
import {
  calendarText,
  type Event,
  entryInWindow,
  eventChange,
  joinKeyOf,
  joinUrlWithoutQuery,
} from "../../meetings/index.js"

type Entry = StoredEntry & { updatedAt: number }

const TRACKED = ["title", "startsAt", "endsAt", "location", "status", "recurrence", "recurrenceEndsAt"] as const

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/**
 * An `EventStore` in memory, for CLI and engine tests: it passes `eventStoreContract`. Rule 4 (an entry adopting a
 * Zoom meeting's event by its room) needs meetings, which this store does not hold; a person is one contact.
 */
export const memoryEventStore = (): EventStore => {
  const calendars: StoredCalendar[] = []
  const entries: Entry[] = []
  const events = new Map<number, Event>()
  const series = new Map<number, { id: number; title: string | null; recurrence: string[] | null }>()
  const revisions: EntryRevision[] = []
  let participants: StoredParticipant[] = []
  let attachments: EntryAttachment[] = []
  const reviews: LinkReview[] = []
  const cursors = new Map<number, string>()
  const unlinked = new Set<number>()
  const contacts = new Map<string, number>()
  let nextId = 1

  const calendarOf = (id: number) => {
    const calendar = calendars.find((one) => one.id === id)
    if (!calendar) throw new CliError("not_found", `no calendar ${id} in the local store`)
    return calendar
  }
  const contactOf = (email: string) => {
    const address = email.trim().toLowerCase()
    if (!contacts.has(address)) contacts.set(address, nextId++)
    return contacts.get(address) as number
  }
  const stored = ({ updatedAt: _, ...entry }: Entry): StoredEntry => ({ ...entry })
  const entityOf = (entry: Entry) => (entry.kind === "series" ? entry.eventSeriesId : entry.eventId)
  const setEntity = (entry: Entry, to: number | null, now: number) => {
    if (entry.kind === "series") entry.eventSeriesId = to
    else entry.eventId = to
    entry.updatedAt = now
  }
  const revise = (entry: Entry, now: number) =>
    revisions.push({
      entryId: entry.id,
      title: entry.title,
      startsAt: entry.startsAt,
      endsAt: entry.endsAt,
      location: entry.location,
      status: entry.status,
      recurrence: entry.recurrence,
      recurrenceEndsAt: entry.recurrenceEndsAt,
      externalUpdatedAt: entry.externalUpdatedAt,
      createdAt: now,
    })

  const candidatesFor = (entry: Entry): number[] => {
    if (!entry.icalUid) return []
    const ids = entries
      .filter(
        (one) =>
          one.icalUid === entry.icalUid &&
          one.calendarId !== entry.calendarId &&
          one.kind === entry.kind &&
          one.deletedAt === null &&
          entityOf(one) !== null &&
          one.originalStartsAt === entry.originalStartsAt,
      )
      .map((one) => entityOf(one) as number)
    return [...new Set(ids)].sort((a, b) => a - b)
  }

  const link = (entry: Entry, now: number) => {
    if (entityOf(entry) !== null || unlinked.has(entry.id)) return
    const ids = candidatesFor(entry)
    if (ids.length > 1) {
      const entity = entry.kind === "series" ? "event_series" : "event"
      const open = reviews.find(
        (one) => one.linkableType === "calendar_entry" && one.linkableId === entry.id && one.entityType === entity,
      )
      if (!open)
        reviews.push({
          id: nextId++,
          linkableType: "calendar_entry",
          linkableId: entry.id,
          calendarId: entry.calendarId,
          entityType: entity,
          candidates: ids,
          reason: "ical-uid",
          status: "open",
          chosenId: null,
          decidedBy: null,
          decidedAt: null,
          createdAt: now,
        })
      else if (open.status === "open") open.candidates = ids
      return
    }
    if (ids.length === 1) return setEntity(entry, ids[0] as number, now)
    if (entry.status === "cancelled") return
    setEntity(entry, newEntity(entry, now), now)
  }

  const newEntity = (entry: Entry, now: number) => {
    const id = nextId++
    if (entry.kind === "series") series.set(id, { id, title: entry.title, recurrence: entry.recurrence })
    else
      events.set(id, {
        id,
        eventSeriesId: null,
        title: entry.title,
        description: null,
        location: null,
        startsAt: entry.startsAt,
        endsAt: entry.endsAt,
        timezone: entry.timezone,
        origin: "calendar",
        deletedAt: null,
        status: null,
        allDay: false,
        sourceDeletedAt: null,
        createdAt: now,
        updatedAt: now,
      })
    return id
  }

  const hasText = (entry: Entry) =>
    `${entry.title ?? ""}${entry.description ?? ""}${entry.location ?? ""}`.trim() !== ""
  const own = (entry: Entry) => participants.some((p) => p.entryId === entry.id && p.self && p.organizer)

  const refreshEvent = (eventId: number, now: number) => {
    const event = events.get(eventId)
    if (!event) return
    const live = entries
      .filter((one) => one.eventId === eventId && one.deletedAt === null)
      .sort(
        (a, b) =>
          Number(hasText(b)) - Number(hasText(a)) ||
          Number(own(b)) - Number(own(a)) ||
          (b.externalUpdatedAt ?? b.updatedAt) - (a.externalUpdatedAt ?? a.updatedAt) ||
          b.id - a.id,
      )
    const preferred = live[0]
    if (!preferred) {
      if (!entries.some((one) => one.eventId === eventId)) return
      if (event.startsAt !== null && event.startsAt < now) event.sourceDeletedAt ??= now
      else event.status = "cancelled"
      event.updatedAt = now
      return
    }
    const cancelled = live.every((one) => one.status === "cancelled")
    const startsAt = preferred.startsAt ?? event.startsAt
    const past = startsAt !== null && startsAt < now
    const seriesEntry =
      preferred.seriesEntryId === null ? null : entries.find((one) => one.id === preferred.seriesEntryId)
    if (!(cancelled && past))
      Object.assign(event, {
        title: preferred.title,
        description: preferred.description,
        location: preferred.location,
        startsAt: preferred.startsAt,
        endsAt: preferred.endsAt,
      })
    event.timezone = preferred.timezone
    event.allDay = preferred.allDay
    event.status = cancelled ? (past ? event.status : "cancelled") : preferred.status
    event.sourceDeletedAt = cancelled && past ? (event.sourceDeletedAt ?? now) : null
    event.eventSeriesId = seriesEntry?.eventSeriesId ?? event.eventSeriesId
    event.updatedAt = now
  }

  const refreshSeries = (seriesId: number) => {
    const preferred = entries
      .filter((one) => one.eventSeriesId === seriesId && one.deletedAt === null)
      .sort((a, b) => (b.externalUpdatedAt ?? b.updatedAt) - (a.externalUpdatedAt ?? a.updatedAt) || b.id - a.id)[0]
    const held = series.get(seriesId)
    if (preferred && held) Object.assign(held, { title: preferred.title, recurrence: preferred.recurrence })
  }

  const refreshAround = (ids: number[], now: number) => {
    const touched = entries.filter(
      (one) => ids.includes(one.id) || (one.seriesEntryId !== null && ids.includes(one.seriesEntryId)),
    )
    for (const one of touched) {
      if (one.eventSeriesId !== null) refreshSeries(one.eventSeriesId)
      if (one.eventId !== null) refreshEvent(one.eventId, now)
    }
  }

  const cancel = (entry: Entry, now: number) => {
    revise(entry, now)
    entry.status = "cancelled"
    entry.updatedAt = now
  }
  const cancelOccurrences = (seriesEntryId: number, now: number) => {
    for (const one of entries)
      if (one.seriesEntryId === seriesEntryId && one.status !== "cancelled" && one.deletedAt === null) cancel(one, now)
  }

  const existingFor = (calendarId: number, input: EntryInput, seriesEntryId: number | null) => {
    const found = entries.find((one) => one.calendarId === calendarId && one.externalId === input.externalId)
    if (found || input.kind !== "occurrence" || input.originalStartsAt == null) return found
    return entries.find((one) =>
      seriesEntryId !== null
        ? one.seriesEntryId === seriesEntryId && one.originalStartsAt === input.originalStartsAt
        : one.calendarId === calendarId &&
          one.seriesEntryId === null &&
          one.originalStartsAt === input.originalStartsAt &&
          one.seriesExternalId === (input.seriesExternalId ?? null),
    )
  }

  const saveEntry = (calendarId: number, input: EntryInput, now: number): Entry => {
    if (input.startsAt != null && input.endsAt != null && input.endsAt < input.startsAt)
      throw new CliError("validation_error", `calendar entry ${input.externalId} ends before it starts`)
    const seriesEntry =
      input.kind === "occurrence" && input.seriesExternalId
        ? entries.find(
            (one) =>
              one.calendarId === calendarId && one.externalId === input.seriesExternalId && one.kind === "series",
          )
        : undefined
    const seriesEntryId = seriesEntry?.id ?? null
    const joinUrl = joinUrlWithoutQuery(input.joinUrl)
    const values = {
      kind: input.kind,
      seriesEntryId,
      seriesExternalId: input.kind === "occurrence" ? (input.seriesExternalId ?? null) : null,
      externalId: input.externalId,
      icalUid: input.icalUid ?? null,
      originalStartsAt: input.originalStartsAt ?? null,
      exception: input.exception === true,
      status: input.status,
      title: calendarText(input.title, { dropSecretLines: false }),
      description: calendarText(input.description),
      location: calendarText(input.location),
      startsAt: input.startsAt ?? null,
      endsAt: input.endsAt ?? null,
      allDay: input.allDay === true,
      startDate: input.startDate ?? null,
      endDate: input.endDate ?? null,
      timezone: input.timezone ?? null,
      recurrence: input.recurrence ?? null,
      recurrenceEndsAt: input.recurrenceEndsAt ?? null,
      eventType: input.eventType ?? null,
      transparency: input.transparency ?? null,
      ownResponse: input.ownResponse ?? null,
      organizerIdentityId: input.organizer ? contactOf(input.organizer.email) : null,
      joinUrl,
      joinKey: joinUrl ? (joinKeyOf(joinUrl) ?? "") : null,
      url: input.url ?? null,
      externalUpdatedAt: input.externalUpdatedAt ?? null,
      etag: input.etag ?? null,
      seenAt: now,
      deletedAt: null,
      updatedAt: now,
    }
    let entry = existingFor(calendarId, input, seriesEntryId)
    if (entry) {
      const found = entry
      if (TRACKED.some((key) => !same(found[key], values[key]))) revise(found, now)
      Object.assign(found, values)
    } else {
      entry = { id: nextId++, calendarId, eventId: null, eventSeriesId: null, createdAt: now, ...values }
      entries.push(entry)
    }
    const id = entry.id
    if (input.participants) {
      const kept = new Map<string, StoredParticipant>()
      for (const one of input.participants) {
        const email = one.email.trim().toLowerCase()
        if (!email || kept.has(email)) continue
        kept.set(email, {
          entryId: id,
          identityId: one.resource ? null : contactOf(email),
          email,
          name: one.name ?? null,
          response: one.response ?? null,
          optional: one.optional === true,
          organizer: one.organizer === true,
          self: one.self === true,
          resource: one.resource === true,
        })
      }
      participants = [
        ...participants.filter((p) => p.entryId !== id),
        ...[...kept.values()].sort((a, b) => a.email.localeCompare(b.email)),
      ]
    }
    if (input.attachments) {
      const files = [...new Set(input.attachments.map(({ fileId }) => fileId.trim()).filter(Boolean))]
      attachments = [
        ...attachments.filter((a) => a.entryId !== id),
        ...files.map((fileId) => ({
          entryId: id,
          fileId,
          title: input.attachments?.find((a) => a.fileId.trim() === fileId)?.title ?? null,
          documentId: null,
        })),
      ]
    }
    if (input.kind === "series")
      for (const one of entries)
        if (
          one.calendarId === calendarId &&
          one.kind === "occurrence" &&
          one.seriesEntryId === null &&
          one.seriesExternalId === input.externalId
        )
          one.seriesEntryId = id
    return entry
  }

  const entryOf = (id: number) => {
    const entry = entries.find((one) => one.id === id)
    if (!entry) throw new CliError("not_found", `no calendar entry ${id} in the local store`)
    return entry
  }

  const store: EventStore = {
    async saveCalendars(accountId, list, now) {
      return list.map((one) => {
        let calendar = calendars.find((held) => held.accountId === accountId && held.externalId === one.externalId)
        if (!calendar) {
          calendar = {
            id: nextId++,
            accountId,
            externalId: one.externalId,
            title: null,
            timezone: null,
            accessRole: null,
            primary: false,
            synced: one.syncByDefault,
            seenAt: null,
            deletedAt: null,
          }
          calendars.push(calendar)
        }
        Object.assign(calendar, {
          title: one.title,
          timezone: one.timezone,
          accessRole: one.accessRole,
          primary: one.primary,
          seenAt: now,
          deletedAt: null,
        })
        return { ...calendar }
      })
    },
    async calendars(accountId) {
      return calendars
        .filter((one) => one.accountId === accountId)
        .sort(
          (a, b) =>
            Number(b.primary) - Number(a.primary) || (a.title ?? "").localeCompare(b.title ?? "") || a.id - b.id,
        )
        .map((one) => ({ ...one }))
    },
    async setCalendarSynced(calendarId, synced) {
      calendarOf(calendarId).synced = synced
    },
    async saveEntries(calendarId, list, now) {
      calendarOf(calendarId)
      for (const input of list)
        if (input.startsAt != null && input.endsAt != null && input.endsAt < input.startsAt)
          throw new CliError("validation_error", `calendar entry ${input.externalId} ends before it starts`)
      const ordered = [...list].sort((a, b) => Number(b.kind === "series") - Number(a.kind === "series"))
      const saved = new Map<EntryInput, Entry>()
      for (const input of ordered) saved.set(input, saveEntry(calendarId, input, now))
      for (const entry of saved.values())
        if (entry.kind === "series" && entry.status === "cancelled") cancelOccurrences(entry.id, now)
      for (const entry of saved.values()) link(entry, now)
      refreshAround(
        [...saved.values()].map(({ id }) => id),
        now,
      )
      return list.map((input) => stored(saved.get(input) as Entry))
    },
    async removeEntries(calendarId, externalIds, now) {
      calendarOf(calendarId)
      const removed = entries.filter(
        (one) =>
          one.calendarId === calendarId &&
          externalIds.includes(one.externalId) &&
          one.status !== "cancelled" &&
          one.deletedAt === null,
      )
      for (const one of removed) {
        cancel(one, now)
        one.seenAt = now
        if (one.kind === "series") cancelOccurrences(one.id, now)
      }
      refreshAround(
        removed.map(({ id }) => id),
        now,
      )
      return removed.length
    },
    async markUnseen(calendarId, seenBefore, window, now) {
      const marked = entries.filter(
        (one) =>
          one.calendarId === calendarId &&
          one.deletedAt === null &&
          (one.seenAt === null || one.seenAt < seenBefore) &&
          entryInWindow(one, window),
      )
      for (const one of marked) Object.assign(one, { deletedAt: now, updatedAt: now })
      for (const eventId of new Set(marked.map(({ eventId }) => eventId)))
        if (eventId !== null) refreshEvent(eventId, now)
      return marked.length
    },
    async restoreUnseen(calendarId, windowAt, now) {
      const restored = entries.filter(
        (one) =>
          one.calendarId === calendarId && one.deletedAt !== null && !entryInWindow(one, windowAt(one.deletedAt)),
      )
      for (const one of restored) Object.assign(one, { deletedAt: null, updatedAt: now })
      refreshAround(
        restored.map(({ id }) => id),
        now,
      )
      return restored.length
    },
    async entry(calendarId, externalId) {
      const found = entries.find((one) => one.calendarId === calendarId && one.externalId === externalId)
      return found ? stored(found) : null
    },
    async slotsOf(calendarId, seriesExternalId, window) {
      return entries
        .filter(
          (one) =>
            one.calendarId === calendarId &&
            one.kind === "occurrence" &&
            one.seriesExternalId === seriesExternalId &&
            one.originalStartsAt !== null &&
            one.originalStartsAt >= window.from &&
            one.originalStartsAt < window.to &&
            one.deletedAt === null,
        )
        .sort((a, b) => (a.originalStartsAt as number) - (b.originalStartsAt as number))
        .map(stored)
    },
    async saveSlots(calendarId, groups, window, cursor, now) {
      let [saved, removed] = [0, 0]
      for (const { series, slots } of groups) {
        const held = entries.filter(
          (one) =>
            one.calendarId === calendarId &&
            one.kind === "occurrence" &&
            one.seriesExternalId === series &&
            one.originalStartsAt !== null &&
            one.originalStartsAt >= window.from &&
            one.originalStartsAt < window.to &&
            one.deletedAt === null,
        )
        if (slots === null) {
          for (const one of held) one.seenAt = now
          continue
        }
        if (slots.length) saved += (await store.saveEntries(calendarId, slots, now)).length
        const given = new Set(slots.map(({ externalId }) => externalId))
        const stale = held
          .filter((one) => !one.exception && one.status !== "cancelled" && !given.has(one.externalId))
          .map(({ externalId }) => externalId)
        if (stale.length) removed += await store.removeEntries(calendarId, stale, now)
      }
      await store.setCursor(calendarId, cursor, now)
      return { saved, removed }
    },
    async cursor(calendarId) {
      return cursors.get(calendarId) ?? null
    },
    async setCursor(calendarId, value) {
      calendarOf(calendarId)
      if (value === null) cursors.delete(calendarId)
      else cursors.set(calendarId, value)
    },
    async events(filter: EventFilter = {}) {
      const limit = filter.limit ?? 100
      const offset = filter.offset ?? 0
      if (!Number.isInteger(limit) || limit < 1 || limit > 1000 || !Number.isInteger(offset) || offset < 0)
        throw new CliError("validation_error", "limit takes 1–1000 and offset 0 or more")
      const has = (event: Event, check: (entry: Entry) => boolean) =>
        entries.some((one) => one.eventId === event.id && check(one))
      if (filter.accountIds !== undefined && filter.accountId !== undefined)
        throw new CliError("validation_error", "an event filter takes accountId or accountIds, not both")
      if (filter.accountIds?.length === 0) throw new CliError("validation_error", "accountIds names no account")
      const accounts = filter.accountIds ?? (filter.accountId === undefined ? undefined : [filter.accountId])
      const inAccounts = (one: Entry) =>
        accounts === undefined || accounts.includes(calendarOf(one.calendarId).accountId)
      const copiesOf = (event: Event) => entries.filter((one) => one.eventId === event.id && inAccounts(one))
      const busy = (event: Event) =>
        event.deletedAt === null &&
        event.status !== "cancelled" &&
        !event.allDay &&
        event.startsAt !== null &&
        event.endsAt !== null &&
        copiesOf(event).some(
          (one) =>
            one.deletedAt === null &&
            one.status !== "cancelled" &&
            one.ownResponse !== "declined" &&
            one.transparency !== "transparent" &&
            one.eventType !== "working-location",
        )
      const clashes = (event: Event) =>
        busy(event) &&
        [...events.values()].some(
          (other) =>
            other.id !== event.id &&
            busy(other) &&
            (other.startsAt as number) < (event.endsAt as number) &&
            (other.endsAt as number) > (event.startsAt as number),
        )
      return [...events.values()]
        .filter(
          (event) =>
            event.deletedAt === null &&
            (filter.from === undefined ||
              (event.allDay && filter.fromDate !== undefined
                ? has(event, (one) => (one.endDate ?? "") > (filter.fromDate ?? ""))
                : (event.endsAt ?? (event.startsAt ?? 0) + 1) > filter.from)) &&
            (filter.to === undefined ||
              (event.allDay && filter.toDate !== undefined
                ? has(event, (one) => one.startDate !== null && one.startDate < (filter.toDate ?? ""))
                : event.startsAt !== null && event.startsAt < filter.to)) &&
            (filter.startsFrom === undefined ||
              (event.allDay && filter.startsFromDate !== undefined
                ? has(event, (one) => one.startDate !== null && one.startDate >= (filter.startsFromDate ?? ""))
                : event.startsAt !== null && event.startsAt >= filter.startsFrom)) &&
            (filter.calendarId === undefined || has(event, (one) => one.calendarId === filter.calendarId)) &&
            (accounts === undefined || has(event, inAccounts)) &&
            (filter.personId === undefined ||
              has(event, (one) =>
                participants.some((p) => p.entryId === one.id && p.identityId === filter.personId),
              )) &&
            (filter.changedSince === undefined ||
              eventChange(event, copiesOf(event), revisions, filter.changedSince) !== null) &&
            (filter.overlapping === undefined || clashes(event) === filter.overlapping),
        )
        .sort((a, b) => ((a.startsAt ?? -1) - (b.startsAt ?? -1) || a.id - b.id) * (filter.newest ? -1 : 1))
        .slice(offset, offset + limit)
        .map((event) => ({ ...event }))
    },
    async historyOf(eventIds, calendarIds, since) {
      const copies = entries.filter(
        (one) => one.eventId !== null && eventIds.includes(one.eventId) && calendarIds.includes(one.calendarId),
      )
      const ids = new Set(copies.map(({ id }) => id))
      return {
        entries: copies.map(stored),
        revisions: revisions.filter((one) => ids.has(one.entryId) && one.createdAt >= since).map((one) => ({ ...one })),
      }
    },
    async participantsOf(eventIds, calendarIds) {
      const wanted = new Map(
        entries
          .filter(
            (one) => one.eventId !== null && eventIds.includes(one.eventId) && calendarIds.includes(one.calendarId),
          )
          .map((one) => [one.id, one.eventId as number]),
      )
      return participants
        .filter((one) => wanted.has(one.entryId))
        .map((one) => ({ ...one, eventId: wanted.get(one.entryId) as number }))
        .sort((a, b) => a.eventId - b.eventId || a.entryId - b.entryId || a.email.localeCompare(b.email))
    },
    async event(id) {
      const event = events.get(id)
      if (!event) return null
      const held = entries.filter((one) => one.eventId === id).sort((a, b) => a.id - b.id)
      const ids = new Set(held.map(({ id }) => id))
      return {
        event: { ...event },
        entries: held.map(stored),
        participants: participants
          .filter((p) => ids.has(p.entryId))
          .sort((a, b) => a.entryId - b.entryId || a.email.localeCompare(b.email))
          .map((p) => ({ ...p })),
        revisions: revisions.filter((r) => ids.has(r.entryId)).map((r) => ({ ...r })),
        attachments: attachments.filter((a) => ids.has(a.entryId)).map((a) => ({ ...a })),
      }
    },
    async linkEntry(entryId, eventId, now) {
      const entry = entryOf(entryId)
      if (!(entry.kind === "series" ? series.has(eventId) : events.has(eventId)))
        throw new CliError("not_found", `no ${entry.kind === "series" ? "event series" : "event"} ${eventId}`)
      unlinked.delete(entryId)
      setEntity(entry, eventId, now)
      if (entry.kind !== "series") refreshEvent(eventId, now)
    },
    async unlinkEntry(entryId, now) {
      const entry = entryOf(entryId)
      unlinked.add(entryId)
      setEntity(entry, null, now)
    },
    async reviews(filter = {}) {
      return reviews
        .filter((one) => !filter.status || one.status === filter.status)
        .map((one) => ({ ...one, candidates: [...one.candidates] }))
    },
    async resolveReview(id, decision, now) {
      const review = reviews.find((one) => one.id === id)
      if (!review) throw new CliError("not_found", `no review ${id} in the local store`)
      if (review.status !== "open") throw new CliError("validation_error", `review ${id} is already ${review.status}`)
      if ("choose" in decision && !review.candidates.includes(decision.choose))
        throw new CliError("validation_error", `${decision.choose} is not one of review ${id}'s candidates`)
      const chosen = "choose" in decision ? decision.choose : null
      if (review.linkableType === "calendar_entry") {
        const entry = entryOf(review.linkableId)
        setEntity(entry, chosen ?? newEntity(entry, now), now)
        if (chosen !== null && review.entityType === "event") refreshEvent(chosen, now)
      }
      Object.assign(review, {
        status: chosen === null ? "apart" : "linked",
        chosenId: chosen,
        decidedBy: "owner",
        decidedAt: now,
      })
      return { ...review, candidates: [...review.candidates] }
    },
  }
  return store
}
