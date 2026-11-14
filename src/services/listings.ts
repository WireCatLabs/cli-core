import { CliError } from "@wirecat/cli-base"
import type { QueryAst } from "@wirecat/cli-base/query"
import type * as v from "valibot"
import { eventIdOf } from "../calendar/index.js"
import { providerLabel } from "../domain/providers.js"
import type {
  documentEntry,
  documentEntryDetails,
  documentSource,
  meetingEntry,
  meetingEntryDetails,
} from "../entities/listings.js"
import { formatMeetingReference, type MeetingReference, parseMeetingReference } from "../meetings/index.js"
import { type SearchTotal, TOTAL_CAP } from "../search/total.js"
import type { DocumentListRow, ListedAccount, MeetingRow, MeetingRowKind, MessageStore } from "../store/index.js"
import { storeQuery } from "./notes-search.js"

export type DocumentEntry = v.InferOutput<typeof documentEntry>
export type DocumentEntryDetails = v.InferOutput<typeof documentEntryDetails>
export type DocumentSourceEntry = v.InferOutput<typeof documentSource>
export type MeetingEntry = v.InferOutput<typeof meetingEntry>
export type MeetingEntryDetails = v.InferOutput<typeof meetingEntryDetails>

/** How many documents a text term may match before the list counts them as "at least". */
export const DOCUMENT_TEXT_CANDIDATES = 2_000

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString())

const sourceName = ({ provider, account }: Pick<ListedAccount, "provider" | "account">) => `${provider}:${account}`

const sourceOf = (account: Pick<ListedAccount, "provider" | "account" | "name">) => ({
  provider: account.provider,
  account: account.account,
  source: sourceName(account),
  label: `${providerLabel(account.provider)} · ${account.name ?? account.account}`,
})

/**
 * The accounts `source:` terms name, among those holding what is listed: `provider:account`, or every account of a
 * provider. One that names none is refused with the choices, never dropped.
 */
const chosenAccounts = (held: readonly ListedAccount[], sources: readonly string[] | undefined, what: string) => {
  if (!sources?.length) return held
  const chosen = new Map<number, ListedAccount>()
  for (const wanted of sources) {
    const found = held.filter((account) => sourceName(account) === wanted || account.provider === wanted)
    if (found.length === 0)
      throw new CliError(
        "not_found",
        `source:${wanted} names no account holding ${what} — the store holds ${held.map(sourceName).join(", ") || "none"}`,
        { reason: "listing.source-not-found" },
      )
    for (const account of found) chosen.set(account.id, account)
  }
  return [...chosen.values()]
}

export interface DocumentListRequest {
  /** `source:` terms; every account holding documents when none. */
  sources?: readonly string[]
  /** Words searched as `search notes` searches them, in the document text and titles. */
  text?: string
  /** The other terms, over the store's document fields (`kind`, `folder`, `source_modified_at`, `tag`, `person`). */
  query?: QueryAst
  zone?: string
  now?: number
  limit: number
  offset: number
}

export interface Listed<T> {
  items: T[]
  total: SearchTotal
  /** Every account read, `provider:account`. */
  accounts: string[]
}

const documentItem = (row: DocumentListRow, accounts: ReadonlyMap<number, ListedAccount>): DocumentEntry => ({
  ref: `document:${row.id}`,
  id: String(row.id),
  title: row.title,
  file_name: row.fileName,
  kind: row.kind,
  mime: row.mime,
  size: row.size,
  source: sourceOf(
    accounts.get(row.accountId) ?? { provider: row.provider, account: row.account, name: row.accountName },
  ),
  folder: row.folder,
  path: row.path,
  url: row.url,
  local_path: row.localPath,
  source_modified_at: iso(row.modifiedAt),
  stored_at: new Date(row.storedAt).toISOString(),
  has_text: row.hasText,
  untrusted: ["title", "file_name", "folder", "path"],
})

/** Every document of every account, or of the `source:` accounts, newest change first; a text term ranks nothing. */
export const listDocuments = async (
  store: MessageStore,
  request: DocumentListRequest,
): Promise<Listed<DocumentEntry>> => {
  const held = await store.listings.documentAccounts()
  const accounts = chosenAccounts(held, request.sources, "documents")
  const narrowed = request.sources?.length ? accounts.map(({ id }) => id) : undefined
  let ids: number[] | undefined
  let capped = false
  if (request.text?.trim()) {
    const { root, stemmer } = await storeQuery(store, request.text, request.zone ? { timezone: request.zone } : {})
    const found = await store.notes.matchingRefs({
      root,
      limit: DOCUMENT_TEXT_CANDIDATES,
      source: "file",
      ...(narrowed ? { folderIds: narrowed.map(String) } : {}),
      ...(stemmer ? { stemmer } : {}),
    })
    ids = found.refs.flatMap((ref) => (ref.startsWith("document:") ? [Number(ref.slice(9))] : []))
    capped = found.hasMore
  }
  const page = await store.listings.documents({
    ...(narrowed ? { accountIds: narrowed } : {}),
    ...(request.query ? { query: request.query } : {}),
    ...(ids ? { ids } : {}),
    ...(request.zone ? { zone: request.zone } : {}),
    ...(request.now ? { now: request.now } : {}),
    limit: request.limit,
    offset: request.offset,
  })
  const byId = new Map(held.map((account) => [account.id, account]))
  return {
    items: page.items.map((row) => documentItem(row, byId)),
    total:
      page.total > TOTAL_CAP || capped
        ? { value: Math.min(page.total, TOTAL_CAP), relation: "gte" }
        : { value: page.total, relation: "eq" },
    accounts: accounts.map(sourceName),
  }
}

/** The accounts holding documents, each with its folders flattened parents first, for a page's left panel. */
export const listDocumentSources = async (
  store: MessageStore,
  { sources, depth }: { sources?: readonly string[]; depth: number },
): Promise<DocumentSourceEntry[]> => {
  const held = await store.listings.documentAccounts()
  const accounts = chosenAccounts(held, sources, "documents")
  const tree = await store.listings.documentSources({
    ...(sources?.length ? { accountIds: accounts.map(({ id }) => id) } : {}),
    depth,
  })
  type Node = (typeof tree)[number]["folders"][number]
  const flat = (nodes: Node[], level: number): DocumentSourceEntry["folders"] =>
    nodes.flatMap((node) => [
      { path: node.path, name: node.name, depth: level, count: node.count },
      ...flat(node.folders, level + 1),
    ])
  return tree.map((account) => ({
    ...sourceOf(account),
    name: account.name,
    count: account.count,
    loose: account.loose,
    folders: flat(account.folders, 1),
  }))
}

const documentId = (reference: string) => {
  const match = /^document:([1-9]\d*)$/u.exec(reference.trim())
  if (!match) throw new CliError("validation_error", `${reference} is not a document; give its document:<id>`)
  return Number(match[1])
}

/** One document with `limit` characters of its text from `offset`, its tags, people, meetings and events. */
export const showDocument = async (
  store: MessageStore,
  reference: string,
  text: { offset: number; limit: number },
): Promise<DocumentEntryDetails> => {
  const found = await store.listings.document(documentId(reference), text)
  if (!found) throw new CliError("not_found", `no document ${reference} in the store`, { reason: "document.not-found" })
  const accounts = new Map((await store.listings.documentAccounts()).map((account) => [account.id, account]))
  return {
    ...documentItem(found, accounts),
    text: found.text,
    text_offset: Math.min(text.offset, found.textLength),
    text_length: found.textLength,
    // SQLite's substr and length count code points; a JavaScript string's length counts UTF-16 units.
    has_more: found.text !== null && text.offset + [...found.text].length < found.textLength,
    extraction: found.extraction,
    extraction_error: found.extractionError,
    language: found.language,
    tags: found.tags,
    people: found.people,
    meetings: found.meetings.map(({ ref, title, at, role }) => ({ ref, title, at: iso(at), role })),
    events: found.events.map(({ ref, title, at, role }) => ({ ref, title, at: iso(at), role })),
    untrusted: ["title", "file_name", "folder", "path", "text", "meetings.title", "events.title"],
  }
}

export interface MeetingListRequest {
  sources?: readonly string[]
  kinds?: readonly MeetingRowKind[]
  /** `person:<id>`. */
  person?: string
  hasTranscript?: boolean
  titleWords?: readonly string[]
  /** Rows that end after this instant; `fromDate` is the same bound as a local day, for all-day events. */
  from?: number
  to?: number
  fromDate?: string
  toDate?: string
  newest?: boolean
  limit: number
  offset: number
}

const ref = ({ id, accountId }: { id: number; accountId: number }) =>
  formatMeetingReference({ type: "meeting", accountId, meetingId: id })

const meetingItem = (row: MeetingRow, accounts: ReadonlyMap<string, ListedAccount>): MeetingEntry => {
  const meetings = row.meetings.map(({ id, accountId }) => ref({ id, accountId }))
  const named = (provider: string, account: string) =>
    accounts.get(`${provider}:${account}`) ?? { provider, account, name: null }
  return {
    ref: row.type === "event" ? `event:${row.id}` : (meetings[0] as string),
    kind: row.kind,
    title: row.title,
    started_at: iso(row.startsAt),
    ended_at: iso(row.endsAt),
    duration_ms:
      row.startsAt !== null && row.endsAt !== null && row.endsAt >= row.startsAt ? row.endsAt - row.startsAt : null,
    all_day: row.allDay,
    timezone: row.timezone,
    status: row.status,
    url: row.url,
    links: row.links,
    sources: row.sources.map((source) => ({
      ...sourceOf(named(source.provider, source.account)),
      via: source.via,
      calendar: source.calendar,
      ref: source.ref,
    })),
    meetings,
    participants: row.participants,
    participants_count: row.participants.length,
    has_recording: row.hasRecording,
    has_transcript: row.hasTranscript,
    has_summary: row.hasSummary,
    documents: row.documents,
    pending_findings: row.pendingFindings,
    untrusted: ["title", "participants.name", "sources.calendar", "documents.title"],
  }
}

const personIdOf = (value: string) => {
  const match = /^(?:person:)?([1-9]\d*)$/u.exec(value.trim())
  if (!match) throw new CliError("validation_error", `person:${value} is not a person; give person:<id>`)
  return Number(match[1])
}

/**
 * Meetings, calls and calendar events of every account (or the `source:` ones) as one row per real meeting, in a
 * time window. A calendar event and its Zoom or Meet record share a row when the store linked them or their rooms
 * (`join_key`) are the same and their times overlap.
 */
export const listMeetingEntries = async (
  store: MessageStore,
  request: MeetingListRequest,
): Promise<Listed<MeetingEntry> & { read: readonly ListedAccount[] }> => {
  const held = await store.listings.meetingAccounts()
  const accounts = chosenAccounts(held, request.sources, "calendars or meetings")
  const page = await store.listings.meetingRows({
    ...(request.sources?.length ? { accountIds: accounts.map(({ id }) => id) } : {}),
    ...(request.kinds?.length ? { kinds: request.kinds } : {}),
    ...(request.person === undefined ? {} : { personId: personIdOf(request.person) }),
    ...(request.hasTranscript === undefined ? {} : { hasTranscript: request.hasTranscript }),
    ...(request.titleWords?.length ? { titleWords: request.titleWords } : {}),
    ...(request.from === undefined ? {} : { from: request.from }),
    ...(request.to === undefined ? {} : { to: request.to }),
    ...(request.fromDate === undefined ? {} : { fromDate: request.fromDate }),
    ...(request.toDate === undefined ? {} : { toDate: request.toDate }),
    ...(request.newest === undefined ? {} : { newest: request.newest }),
    limit: request.limit,
    offset: request.offset,
  })
  const byName = new Map(held.map((account) => [sourceName(account), account]))
  return {
    items: page.items.map((row) => meetingItem(row, byName)),
    total: { value: page.total, relation: "eq" },
    accounts: accounts.map(sourceName),
    read: accounts,
  }
}

const targetOf = (reference: string): { event: number } | MeetingReference => {
  const text = reference.trim()
  if (text.startsWith("event:")) return { event: eventIdOf(text) }
  if (text.startsWith("meeting:") && text.split("/").length === 2) return parseMeetingReference(text)
  throw new CliError("validation_error", `${reference} is not a meeting; give its event:<id> or meeting:<account>/<id>`)
}

/**
 * One row as `listMeetingEntries` shows it, with the calendar's text, every meeting's summaries, the findings citing
 * them and `limit` transcript lines from `offset` of its first meeting with a transcript.
 */
export const showMeetingEntry = async (
  store: MessageStore,
  reference: string,
  lines: { offset: number; limit: number },
): Promise<MeetingEntryDetails> => {
  const target = targetOf(reference)
  const row = await store.listings.meetingRow("event" in target ? target : { meeting: target.meetingId })
  const asked = (one: { id: number; accountId: number }) =>
    "meetingId" in target && one.id === target.meetingId && one.accountId === target.accountId
  if (!row || ("meetingId" in target && !row.meetings.some(asked)))
    throw new CliError("not_found", `no meeting ${reference} in the store`, { reason: "meeting.not-found" })
  const byName = new Map((await store.listings.meetingAccounts()).map((account) => [sourceName(account), account]))
  const event = row.type === "event" ? await store.calendar.event(row.id) : null
  const details = []
  for (const { id } of row.meetings) {
    const one = await store.meetings.meeting(id)
    if (one) details.push(one)
  }
  const live = event?.entries.find(({ deletedAt }) => deletedAt === null) ?? event?.entries[0]
  const first = details[0]?.meeting
  const spoken = details.flatMap((one) =>
    one.transcripts
      .filter(({ transcript }) => transcript.deletedAt === null && transcript.supersededAt === null)
      .map((transcript) => ({ meeting: one, ...transcript })),
  )[0]
  const people = new Map(
    (spoken?.meeting.participants ?? []).map((participant) => [participant.id, participant.person ?? null]),
  )
  return {
    ...meetingItem(row, byName),
    description: live?.description ?? event?.event.description ?? first?.description ?? null,
    location: live?.location ?? event?.event.location ?? first?.location ?? null,
    summaries: details.flatMap((one) =>
      one.summaries.map((summary) => ({
        meeting: ref(one.meeting),
        source: summary.source,
        title: summary.title,
        overview: summary.overview,
        sections: summary.sections,
        next_steps: summary.nextSteps,
        url: summary.docUrl,
      })),
    ),
    transcript: spoken
      ? {
          meeting: ref(spoken.meeting.meeting),
          source: spoken.transcript.source,
          language: spoken.transcript.language,
          offset: lines.offset,
          total: spoken.rows.length,
          has_more: lines.offset + lines.limit < spoken.rows.length,
          lines: spoken.rows.slice(lines.offset, lines.offset + lines.limit).map((line) => {
            const person = line.speakerParticipantId === null ? null : (people.get(line.speakerParticipantId) ?? null)
            return {
              position: line.position,
              offset_ms: line.startMs,
              end_ms: line.endMs,
              speaker: line.speakerName,
              person: person === null ? null : { ref: `person:${person.uid}`, name: person.name ?? null },
              text: line.text,
            }
          }),
        }
      : null,
    findings: row.findings,
    untrusted: [
      "title",
      "description",
      "location",
      "participants.name",
      "sources.calendar",
      "documents.title",
      "summaries",
      "transcript.lines.speaker",
      "transcript.lines.text",
    ],
  }
}
