import { typedPhone } from "../../domain/mentions.js"
import type { Message } from "../../domain/models.js"
import type { CALL_DIRECTIONS, SMS_DIRECTIONS } from "../../domain/record-types.js"
import { formatReference } from "../../domain/references.js"
import type { EntryInput } from "../../meetings/index.js"
import type { AccountKey } from "../types.js"
import { accountPk } from "./accounts.js"
import { calendarWritesOver } from "./calendar.js"
import { chatPkFor, upsertChat } from "./chats.js"
import { COUNTERPART_ROLE, linkKind } from "./link-kinds.js"
import { upsertMessage } from "./messages.js"
import { requiredThing } from "./notes.js"
import type { StoreContext } from "./open.js"
import { storePhoneCountries } from "./phone-countries.js"
import { importedIdentity, linkToPerson } from "./record-matching.js"
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

export const SMS_PROVIDER = "sms"
export const CALLS_PROVIDER = "calls"
const CALLS_CALENDAR = "calls"

/** E.164 when the number reads as one with the store's countries; as written otherwise (a short code, a name). */
const numberOf = ({ database }: StoreContext, typed: string): string => {
  const value = typedPhone(typed, { phoneCountries: storePhoneCountries(database) })?.value
  return value?.startsWith("+") ? value : typed.trim()
}

/** The account a phone kind is kept in: one per source account, in the source account's scope. */
const kindAccount = (
  { context }: ProjectionTools,
  provider: string,
  projection: Projection,
): AccountKey & { pk: number } => {
  const scope = context.database.prepare("SELECT scope FROM accounts WHERE id = ?").get(projection.accountId)?.scope
  const key: AccountKey = {
    provider,
    account: projection.source.account,
    ...(scope === "work" || scope === "personal" ? { scope } : {}),
  }
  return { ...key, pk: accountPk(context, key) }
}

const counterpartOf = (projection: Projection, { context }: ProjectionTools): number | undefined => {
  const ref = entityOf(projection, "counterpart")
  return ref === undefined ? undefined : requiredThing(context.database, ref).id
}

/** The schema checks the shape only: a 13th month passes it, and must refuse this record, not the run. */
const millis = (fields: Row, name: string): number => {
  const at = Date.parse(String(fields[name]))
  return Number.isNaN(at) ? refusal(`fields.${name} is no moment`, "record.invalid", ["fields", name]) : at
}

const saveSms = (projection: Projection, tools: ProjectionTools): string => {
  const { context } = tools
  const { fields, externalId, source } = projection
  const sentAt = millis(fields, "sent_at")
  const account = kindAccount(tools, SMS_PROVIDER, projection)
  const phone = numberOf(context, String(fields.phone))
  const name = given<string>(fields, "name") ?? null
  const incoming = (fields.direction as (typeof SMS_DIRECTIONS)[number]) === "in"
  const identity = importedIdentity(context, {
    provider: SMS_PROVIDER,
    externalId: phone,
    name,
    ...(phone.startsWith("+") ? { phone } : {}),
  })
  const person = counterpartOf(projection, tools)
  // Linked before the message is saved: the messenger path gives an identity with no person one of its own.
  if (person !== undefined) linkToPerson(context, person, identity, source)
  const at = context.now()
  context.database
    .prepare(
      "INSERT OR IGNORE INTO account_identities (account_id, identity_id, created_at, updated_at) VALUES (?, ?, ?, ?)",
    )
    .run(account.pk, identity, at, at)
  const chatId = given<string>(fields, "thread") ?? phone
  upsertChat(context, account.pk, { id: chatId, kind: "dialog", title: name ?? phone, membershipState: "imported" })
  const chatKey = chatPkFor(context, account.pk, chatId)
  context.database
    .prepare("INSERT OR IGNORE INTO chat_members (chat_id, identity_id, created_at) VALUES (?, ?, ?)")
    .run(chatKey, identity, at)
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
  context.database
    .prepare("UPDATE chats SET last_message_at = max(coalesce(last_message_at, 0), ?) WHERE id = ?")
    .run(sentAt, chatKey)
  return formatReference({
    type: "message",
    provider: SMS_PROVIDER,
    account: account.account,
    chat: chatId,
    message: externalId,
  })
}

const DESCRIPTIONS: Record<(typeof CALL_DIRECTIONS)[number], string> = {
  in: "incoming call",
  out: "outgoing call",
  missed: "missed call",
}

/** The account's calls calendar, its sync marked complete: no provider syncs it, so nothing is missing from it. */
const callsCalendar = (context: StoreContext, accountId: number, writes: ReturnType<typeof calendarWritesOver>) => {
  const at = context.now()
  const id = Number(
    context.database
      .prepare(
        `INSERT INTO calendars (account_id, external_id, title, access_role, primary_calendar, synced, seen_at,
           created_at, updated_at) VALUES (?, ?, 'Calls', 'owner', 1, 1, ?, ?, ?)
         ON CONFLICT (account_id, external_id) DO UPDATE SET seen_at = excluded.seen_at RETURNING id`,
      )
      .get(accountId, CALLS_CALENDAR, at, at, at)?.id,
  )
  const cursor = {
    v: 2,
    token: null,
    window: { from: 0, to: 8.64e15 },
    fullAt: at,
    updatedAt: at,
    done: 0,
    round: null,
  }
  writes.putCursor(id, JSON.stringify(cursor), at)
  return id
}

const saveCall = (projection: Projection, tools: ProjectionTools): string => {
  const { context } = tools
  const { fields, externalId } = projection
  const startsAt = millis(fields, "started_at")
  const account = kindAccount(tools, CALLS_PROVIDER, projection)
  const writes = calendarWritesOver(context)
  const calendarId = callsCalendar(context, account.pk, writes)
  const phone = numberOf(context, String(fields.phone))
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
  writes.saveAll(calendarId, [entry], context.now())
  const eventId = Number(
    context.database
      .prepare("SELECT event_id FROM calendar_entries WHERE calendar_id = ? AND external_id = ?")
      .get(calendarId, externalId)?.event_id,
  )
  const at = context.now()
  context.database
    .prepare(
      `DELETE FROM links WHERE from_type = 'event' AND from_id = ? AND to_type = 'person' AND kind = ${linkKind("related-to")}
         AND role = ? AND source = 'import'`,
    )
    .run(eventId, COUNTERPART_ROLE)
  const person = counterpartOf(projection, tools)
  if (person !== undefined)
    context.database
      .prepare(
        `INSERT INTO links (from_type, from_id, to_type, to_id, kind, role, source, confirmed, created_at, author,
           updated_at) VALUES ('event', ?, 'person', ?, ${linkKind("related-to")}, ?, 'import', 1, ?, 'import', ?)`,
      )
      .run(eventId, person, COUNTERPART_ROLE, at, at)
  return `event:${eventId}`
}

const upserting = (save: (projection: Projection, tools: ProjectionTools) => string): RecordProjector => ({
  create: save,
  update: (_ref, projection, tools) => {
    save(projection, tools)
    return true
  },
})

export const PHONE_PROJECTORS = {
  message: upserting(saveSms),
  event: upserting(saveCall),
} as const satisfies Record<string, RecordProjector>
