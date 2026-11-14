import { CliError } from "@wirecat/cli-base"
import {
  calendarText,
  type Event,
  joinKeyOf,
  type MeetingSource,
  type MeetingStore,
  pull,
  type RunReport,
  type SourceMeeting,
  type SummaryContent,
} from "../meetings/index.js"
import type { Email, EmailFacts, MessageStore } from "../store/index.js"
import { mailAccountKey } from "./account-key.js"
import { factsOf } from "./facts.js"
import { type MailRule, matches } from "./rules.js"
import { listedOf } from "./stored.js"

const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS

interface NotesKind {
  /** Who mails them: what `rules add --meeting-notes <provider>` matches when no sender is given. */
  senders: readonly string[]
  /** The meeting's day, from the subject; null when the subject does not say. */
  day(subject: string): { year: number; month: number; day: number } | null
  /**
   * The UTC offsets, in hours, the subject's day may be written in. The day window spans all of them and the
   * computer's own zone, so a meeting just after midnight in one is still found.
   */
  offsets: readonly number[]
  /** The headings the notes are split under, in the case they are written. */
  headings: readonly string[]
  overview: string
  /** The first line of the notes, before any heading; not part of them. */
  title: string
  /** The lines where the provider's own footer starts: the notes end before the first of them. */
  ends: readonly string[]
}

/** The meeting-notes mail each provider sends. A provider not here cannot be named by a rule. */
export const MEETING_NOTES: Readonly<Record<string, NotesKind>> = {
  telemost: {
    senders: ["keeper@telemost.yandex.ru"],
    day: (subject) => {
      const found = /(\d{2})\.(\d{2})\.(\d{4})/u.exec(subject)
      return found ? { day: Number(found[1]), month: Number(found[2]), year: Number(found[3]) } : null
    },
    // Moscow, Yandex's default; the zone of the owner's Yandex account is not known here.
    offsets: [3],
    headings: ["Итоги", "Что обсудили", "Задачи", "Открытые вопросы", "Следующая встреча"],
    overview: "Итоги",
    title: "Конспект встречи",
    ends: ["Оцените точность конспекта"],
  },
}

export const MEETING_NOTES_PROVIDERS = Object.keys(MEETING_NOTES)

const LINK = /https?:\/\/[^\s<>"')\]]+/giu

const textOf = (email: Email): string =>
  calendarText(email.bodyText?.trim() ? email.bodyText : email.bodyHtml)?.replace(/\r\n?/gu, "\n") ?? ""

const headingOf = (line: string, headings: readonly string[]): string | undefined => {
  const plain = line
    .replace(/^(?:[\s#*>-]|\p{Extended_Pictographic}|️)+/u, "")
    .replace(/[\s:*]+$/u, "")
    .toLowerCase()
  return headings.find((heading) => heading.toLowerCase() === plain)
}

/**
 * The notes cut at their headings, without the provider's footer. Older notes have no overview heading: their
 * overview is the text before the first heading.
 */
export const notesOf = (
  text: string,
  kind: Pick<NotesKind, "headings" | "overview" | "title" | "ends">,
): SummaryContent => {
  const all = text.split("\n")
  const end = all.findIndex((line) => kind.ends.includes(line.trim()))
  const lines = end === -1 ? all : all.slice(0, end)
  const lead: string[] = []
  const parts: { label: string; lines: string[] }[] = []
  for (const line of lines) {
    const heading = headingOf(line, kind.headings)
    if (heading !== undefined) parts.push({ label: heading, lines: [] })
    else (parts.at(-1)?.lines ?? lead).push(line)
  }
  const sections = parts
    .map(({ label, lines }) => ({ label, text: lines.join("\n").trim() }))
    .filter(({ text }) => text !== "")
  const opening = lead
    .filter((line) => line.trim() !== kind.title)
    .join("\n")
    .trim()
  return {
    title: null,
    overview: sections.find(({ label }) => label === kind.overview)?.text ?? (opening || null),
    sections: sections.filter(({ label }) => label !== kind.overview),
    nextSteps: [],
    content: lines.join("\n").trim() || null,
  }
}

/** The first link in the notes that names a meeting room, as `joinKeyOf` reads it: never a plain page link. */
const roomOf = (text: string): string | null => {
  for (const [url] of text.matchAll(LINK)) if (/\/j\/[^/]+$/u.test(url) && joinKeyOf(url)) return url
  return null
}

/** The day as a window: from its first midnight in any of the zones to its last. */
const dayWindow = (kind: NotesKind, date: { year: number; month: number; day: number }) => {
  const local = new Date(date.year, date.month - 1, date.day).getTime()
  const utc = Date.UTC(date.year, date.month - 1, date.day)
  const starts = [local, ...kind.offsets.map((offset) => utc - offset * HOUR_MS)]
  const start = starts.reduce((low, at) => Math.min(low, at))
  const end = starts.reduce((high, at) => Math.max(high, at)) + DAY_MS
  return { start, end, local }
}

interface Note {
  meeting: SourceMeeting
  summary: SummaryContent
}

/** The stored mail the rules can be matching: by sender when every rule names one, else the whole window. */
const candidateFacts = async (store: MessageStore, accountId: number, since: number, rules: readonly MailRule[]) => {
  const senders = rules.map(({ match }) => match.from)
  if (senders.some((sender) => sender === undefined)) return store.mail.emailFacts({ accountId, since })
  const found = new Map<string, EmailFacts>()
  for (const sender of new Set(senders as string[]))
    for (const facts of await store.mail.emailFacts({ accountId, since, participant: sender }))
      found.set(facts.externalId, facts)
  return [...found.values()]
}

/**
 * Meetings read from stored mail a meeting-notes rule matches, for `pull`. The notes give the day, not the hours:
 * the event the meeting is already linked to, or the one event in the same room that day, gives its times; otherwise
 * it starts at the day's start, says so in `metadata.time_precision`, and no event is made for it.
 */
export const mailMeetingSource = ({
  store,
  meetings,
  address,
  rules,
  provider,
  accountId,
}: {
  store: MessageStore
  meetings: Pick<MeetingStore, "eventCandidates" | "meetings" | "events">
  address: string
  rules: readonly MailRule[]
  provider: string
  /** The provider's account the meetings are saved in; absent before its first save. */
  accountId?: number
}): MeetingSource => {
  const kind = MEETING_NOTES[provider]
  const ruling = rules.filter((rule) => rule.meeting_notes === provider)
  const notes = new Map<string, Note>()
  const none = async () => null
  return {
    provider,
    name: "mail",
    createsEvents: false,
    async meetings(since) {
      if (kind === undefined || ruling.length === 0) return []
      const stored = await store.accounts.storedAccount(mailAccountKey(address)).catch((error: unknown) => {
        if (error instanceof CliError && error.code === "not_found") return null
        throw error
      })
      if (stored === null) return []
      const listed = (await candidateFacts(store, stored.id, Date.parse(since), ruling)).map(listedOf)
      const factsFor = await factsOf(listed, ruling, (addresses) => store.mail.writtenTo(addresses))
      const saved = accountId === undefined ? [] : await meetings.meetings({ accountId, includeDeleted: true })
      const linked = new Map(
        saved.flatMap(({ externalId, eventId }) => (eventId === null ? [] : [[externalId, eventId]])),
      )
      const events = new Map<number, Event>(
        linked.size ? (await meetings.events()).map((event) => [event.id, event] as const) : [],
      )
      const found: SourceMeeting[] = []
      for (const item of listed) {
        if (!ruling.some((rule) => matches(rule.match, factsFor(item)))) continue
        const email = await store.mail.email(stored.id, item.messageId)
        if (email === null || email.deletedAt !== null) continue
        const subject = email.subject ?? ""
        const sent = email.sentAt ?? email.receivedAt
        const date =
          kind.day(subject) ??
          (sent === null
            ? null
            : {
                year: new Date(sent).getFullYear(),
                month: new Date(sent).getMonth() + 1,
                day: new Date(sent).getDate(),
              })
        if (date === null) continue
        const window = dayWindow(kind, date)
        if (!Number.isFinite(window.local)) continue
        const text = textOf(email)
        const joinUrl = roomOf(text)
        const linkedId = linked.get(email.externalId)
        const linkedEvent: Event | undefined = linkedId === undefined ? undefined : events.get(linkedId)
        const candidates =
          linkedEvent !== undefined || joinUrl === null
            ? []
            : await meetings.eventCandidates({
                meetingSeriesId: null,
                joinUrl,
                startsAt: window.start,
                endsAt: window.end,
              })
        const timed = linkedEvent ?? (candidates.length === 1 ? candidates[0] : undefined)
        const startsAt = timed?.startsAt ?? null
        const meeting: SourceMeeting = {
          joinUrl,
          metadata: { email: email.externalId, time_precision: startsAt === null ? "day" : "event" },
          series: null,
          occurrence: {
            id: email.externalId,
            seriesId: email.externalId,
            title: timed?.title ?? (subject || null),
            startedAt: new Date(startsAt ?? window.local).toISOString(),
            endedAt: startsAt === null || timed?.endsAt == null ? null : new Date(timed.endsAt).toISOString(),
          },
        }
        notes.set(email.externalId, { meeting, summary: notesOf(text, kind) })
        found.push(meeting)
      }
      return found
    },
    participants: none,
    transcript: none,
    chat: none,
    summary: async (id) => notes.get(id)?.summary ?? null,
    files: none,
  }
}

/**
 * Saves as meetings the stored mail each meeting-notes rule matches, from `since`, into the provider's account named
 * by the mailbox's address. Mail stored before the rule was made is read the same way, with an early `since`. A
 * provider that fails is a warning in its report: the mail it was read from is already saved.
 */
export const saveMeetingNotes = async (
  store: MessageStore,
  address: string,
  rules: readonly MailRule[],
  { since, now = Date.now() }: { since: string; now?: number },
): Promise<Record<string, RunReport>> => {
  const reports: Record<string, RunReport> = {}
  for (const provider of new Set(rules.flatMap(({ meeting_notes }) => (meeting_notes ? [meeting_notes] : [])))) {
    if (MEETING_NOTES[provider] === undefined) continue
    try {
      const key = { provider, account: address.toLowerCase() }
      const accountId = await store.accounts.saveAccount(key, { name: address.toLowerCase() })
      const source = mailMeetingSource({ store, meetings: store.meetings, address, rules, provider, accountId })
      reports[provider] = await pull(source, store.meetings, { accountId, since, now })
    } catch (error) {
      const message = error instanceof Error ? error.message : "meeting notes could not be saved"
      reports[provider] = {
        meetings: 0,
        participants: 0,
        transcriptRows: 0,
        summaries: 0,
        warnings: [{ externalId: "", message }],
      }
    }
  }
  return reports
}
