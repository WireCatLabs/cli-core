import type { Message } from "../../domain/models.js"
import { isImportedProvider } from "../../domain/providers.js"
import type { CALL_DIRECTIONS, SMS_DIRECTIONS } from "../../domain/record-types.js"
import type { EnvelopeSource } from "../../domain/records.js"
import { formatReference, parseReference } from "../../domain/references.js"
import type { EntryInput } from "../../meetings/index.js"
import type { AccountKey } from "../types.js"
import { calendarWritesOver } from "./calendar.js"
import { chatPkFor, findChatPk, raiseLastMessageAt, upsertChat, writeMembers } from "./chats.js"
import { seenIdentity } from "./identities.js"
import { COUNTERPART_ROLE, linkKind } from "./link-kinds.js"
import { tombstone, upsertMessage } from "./messages.js"
import { requiredThing } from "./notes.js"
import type { StoreContext } from "./open.js"
import { e164Of, importedIdentity, linkToPerson } from "./record-matching.js"
import {
  entityOf,
  given,
  importedBy,
  type Projection,
  type ProjectionTools,
  type RecordProjector,
  type Row,
  refusal,
} from "./record-projection.js"

const CALLS_CALENDAR = "calls"

/**
 * A messenger's or a calendar's account is its sync's: an SMS or a call written there would land in a real chat or
 * calendar. Only a provider marked import-only (`imported`, as the seeded `phone`) takes them.
 */
export const importOnly = (source: EnvelopeSource, type: string): void => {
  if (!isImportedProvider(source.provider))
    refusal(
      `a ${type} is imported only under an import-only provider such as phone; ${source.provider} is not one`,
      "record.provider-not-imported",
      "type",
    )
}

/** E.164 as a person record's phone reads, so the thread and the person agree; as written otherwise (a short code). */
const numberOf = ({ options }: Projection, typed: string): string =>
  e164Of(typed, options.phone_region?.toLowerCase()) ?? typed.trim()

/** The import's own account holds its SMS and calls too, so one `provider:account` in a group reaches all of it. */
const sourceAccount = ({ source, accountId }: Projection): AccountKey & { pk: number } => ({
  provider: source.provider,
  account: source.account,
  pk: accountId,
})

const counterpartOf = (projection: Projection, { context }: ProjectionTools): number | undefined => {
  const ref = entityOf(projection, "counterpart")
  return ref === undefined ? undefined : requiredThing(context.database, ref).id
}

/** The schema checks the shape only: a 13th month passes it, and must refuse this record, not the run. */
const millis = (fields: Row, name: string): number => {
  const at = Date.parse(String(fields[name]))
  return Number.isNaN(at) ? refusal(`fields.${name} is no moment`, "record.invalid", ["fields", name]) : at
}

const threadOf = (projection: Projection) =>
  given<string>(projection.fields, "thread") ?? numberOf(projection, String(projection.fields.phone))

const saveSms = (projection: Projection, tools: ProjectionTools): string => {
  importOnly(projection.source, "message")
  const { context } = tools
  const { fields, externalId, source } = projection
  const sentAt = millis(fields, "sent_at")
  const account = sourceAccount(projection)
  const phone = numberOf(projection, String(fields.phone))
  const name = given<string>(fields, "name") ?? null
  const incoming = (fields.direction as (typeof SMS_DIRECTIONS)[number]) === "in"
  const chatId = threadOf(projection)
  const held = findChatPk(context, account.pk, chatId)
  const membership =
    held === undefined
      ? undefined
      : context.database.prepare("SELECT membership_state FROM chats WHERE id = ?").get(held)
  if (membership !== undefined && membership.membership_state !== "imported")
    refusal(`chat ${chatId} of ${account.provider}:${account.account} is not an imported one`, "record.chat", [
      "fields",
      "thread",
    ])
  const identity = importedIdentity(context, {
    provider: account.provider,
    externalId: phone,
    name,
    ...(phone.startsWith("+") ? { phone } : {}),
  })
  const person = counterpartOf(projection, tools)
  // Linked before the identity is seen: the messenger path gives an identity with no person one of its own.
  if (person !== undefined) linkToPerson(context, person, identity, source)
  seenIdentity(context, account.pk, account.provider, phone, name)
  upsertChat(context, account.pk, { id: chatId, kind: "dialog", title: name ?? phone, membershipState: "imported" })
  writeMembers(context, account, account.pk, chatId, [phone])
  const chatKey = chatPkFor(context, account.pk, chatId)
  const read = given<boolean>(fields, "read")
  const message: Message = {
    id: externalId,
    chatId,
    senderId: incoming ? phone : null,
    senderName: incoming ? name : null,
    timestamp: new Date(sentAt).toISOString(),
    editedAt: null,
    text: String(fields.body),
    outgoing: !incoming,
    attachments: [],
    replyTo: null,
    forwardedFrom: null,
    reactions: null,
    ...(read === undefined ? {} : { providerMetadata: { read } }),
  }
  upsertMessage(context, account, account.pk, chatKey, message, importedBy(source).source)
  raiseLastMessageAt(context, chatKey, sentAt)
  return formatReference({
    type: "message",
    provider: account.provider,
    account: account.account,
    chat: chatId,
    message: externalId,
  })
}

/** A changed thread or number would make a second message: the one stored stays where it is. */
const updateSms = (ref: string, projection: Projection, tools: ProjectionTools): boolean => {
  const stored = parseReference(ref)
  if (stored.type === "message" && stored.chat !== threadOf(projection))
    refusal(
      `an SMS stays in its thread (${stored.chat}): delete it and send it again under a new external_id`,
      "record.moved",
      ["fields", "thread"],
    )
  saveSms(projection, tools)
  return true
}

const DESCRIPTIONS: Record<(typeof CALL_DIRECTIONS)[number], string> = {
  in: "incoming call",
  out: "outgoing call",
  missed: "missed call",
}

/**
 * The account's calls calendar, made on its first call. One the owner deleted stays deleted: an import, often an
 * agent's, never undoes the owner's decision, so its calls are refused until the owner restores it. One indexed read
 * per call: the calendar is written only on the first.
 */
const callsCalendar = (context: StoreContext, account: AccountKey & { pk: number }): number => {
  const row = context.database
    .prepare("SELECT id, deleted_at FROM calendars WHERE account_id = ? AND external_id = ?")
    .get(account.pk, CALLS_CALENDAR)
  if (row && row.deleted_at != null)
    refusal(
      `the owner deleted the calls calendar of ${account.provider}:${account.account}; ` +
        `store.calendar.restoreCalendar(${Number(row.id)}) brings it back, then import the calls again`,
      "record.calendar-deleted",
      "type",
    )
  return row !== undefined
    ? Number(row.id)
    : calendarWritesOver(context).saveCalendar(
        account.pk,
        {
          externalId: CALLS_CALENDAR,
          title: "Calls",
          timezone: null,
          accessRole: "owner",
          primary: true,
          syncByDefault: false,
        },
        context.now(),
      ).id
}

const relinkCounterpart = (context: StoreContext, eventId: number, person: number | undefined) => {
  const at = context.now()
  context.database
    .prepare(
      `DELETE FROM links WHERE from_type = 'event' AND from_id = ? AND to_type = 'person' AND kind = ${linkKind("related-to")}
         AND role = ? AND source = 'import'`,
    )
    .run(eventId, COUNTERPART_ROLE)
  if (person !== undefined)
    context.database
      .prepare(
        `INSERT INTO links (from_type, from_id, to_type, to_id, kind, role, source, confirmed, created_at, author,
           updated_at) VALUES ('event', ?, 'person', ?, ${linkKind("related-to")}, ?, 'import', 1, ?, 'import', ?)`,
      )
      .run(eventId, person, COUNTERPART_ROLE, at, at)
}

const saveCall = (projection: Projection, tools: ProjectionTools): string => {
  importOnly(projection.source, "event")
  const { context } = tools
  const { fields, externalId } = projection
  const startsAt = millis(fields, "started_at")
  const calendarId = callsCalendar(context, sourceAccount(projection))
  const phone = numberOf(projection, String(fields.phone))
  const direction = fields.direction as (typeof CALL_DIRECTIONS)[number]
  const seconds = given<number>(fields, "duration") ?? 0
  const entry: EntryInput = {
    externalId,
    kind: "single",
    status: "confirmed",
    title: given<string>(fields, "name") ?? phone,
    description: DESCRIPTIONS[direction],
    startsAt,
    endsAt: startsAt + seconds * 1000,
    allDay: false,
    eventType: "call",
    // A call never makes the owner busy in a plan or overlaps a meeting: it is history, not a booking.
    transparency: "transparent",
    participants: [],
    metadata: { callDirection: direction, callSeconds: seconds, callNumber: phone },
  }
  const [saved] = calendarWritesOver(context).saveAll(calendarId, [entry], context.now())
  const eventId = Number(saved?.eventId)
  relinkCounterpart(context, eventId, counterpartOf(projection, tools))
  return `event:${eventId}`
}

/** A deleted record's SMS or call goes as a messenger's deleted message goes: the copy is a tombstone. */
const removeSms = (ref: string, { context }: ProjectionTools) => {
  tombstone(context, requiredThing(context.database, ref).id)
}

const removeCall = (ref: string, { context }: ProjectionTools) => {
  const eventId = requiredThing(context.database, ref).id
  const writes = calendarWritesOver(context)
  for (const row of context.database
    .prepare("SELECT calendar_id, external_id FROM calendar_entries WHERE event_id = ? AND event_type = 'call'")
    .all(eventId))
    writes.removeAll(Number(row.calendar_id), [String(row.external_id)], context.now())
  context.database
    .prepare("UPDATE events SET deleted_at = coalesce(deleted_at, ?), updated_at = ? WHERE id = ?")
    .run(context.now(), context.now(), eventId)
}

export const PHONE_PROJECTORS = {
  message: { create: saveSms, update: updateSms, remove: removeSms },
  event: {
    create: saveCall,
    update: (_ref, projection, tools) => {
      saveCall(projection, tools)
      return true
    },
    remove: removeCall,
  },
} as const satisfies Record<string, RecordProjector>
