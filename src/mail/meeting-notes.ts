import {
  joinKeyOf,
  joinUrlWithoutQuery,
  type MeetingSource,
  type MeetingStore,
  pull,
  type RunReport,
  type SourceMeeting,
  type SummaryContent,
} from "../meetings/index.js"
import type { Email, MessageStore } from "../store/index.js"
import { mailAccountKey } from "./account-key.js"
import { factsOf } from "./facts.js"
import { htmlToText } from "./parse.js"
import { type MailRule, matches } from "./rules.js"
import { listedOf } from "./stored.js"

const DAY_MS = 86_400_000

interface NotesKind {
  /** Who mails them: what `rules add --meeting-notes <provider>` matches when no sender is given. */
  senders: readonly string[]
  /** The meeting's day, from the subject; null when the subject does not say. */
  day(subject: string): { year: number; month: number; day: number } | null
  /** The headings the notes are split under, in the case they are written. */
  headings: readonly string[]
  overview: string
}

/** The meeting-notes mail each provider sends. A provider not here cannot be named by a rule. */
export const MEETING_NOTES: Readonly<Record<string, NotesKind>> = {
  telemost: {
    senders: ["keeper@telemost.yandex.ru"],
    day: (subject) => {
      const found = /(\d{2})\.(\d{2})\.(\d{4})/u.exec(subject)
      return found ? { day: Number(found[1]), month: Number(found[2]), year: Number(found[3]) } : null
    },
    headings: ["Итоги", "Что обсудили", "Задачи", "Открытые вопросы", "Следующая встреча"],
    overview: "Итоги",
  },
}

export const MEETING_NOTES_PROVIDERS = Object.keys(MEETING_NOTES)

const LINK = /https?:\/\/[^\s<>"')\]]+/gu

// A link's query may carry a passcode: the meeting keeps the notes with every link cut to its path.
const textOf = (email: Email): string =>
  (email.bodyText?.trim() ? email.bodyText : email.bodyHtml ? htmlToText(email.bodyHtml) : "")
    .replace(/\r\n?/gu, "\n")
    .replace(LINK, (url) => joinUrlWithoutQuery(url) ?? url)

const headingOf = (line: string, headings: readonly string[]): string | undefined => {
  const plain = line
    .replace(/^(?:[\s#*>-]|\p{Extended_Pictographic}|️)+/u, "")
    .replace(/[\s:*]+$/u, "")
    .toLowerCase()
  return headings.find((heading) => heading.toLowerCase() === plain)
}

/** The notes cut at their headings; text before the first heading stays only in `content`. */
export const notesOf = (text: string, kind: NotesKind): SummaryContent => {
  const parts: { label: string; lines: string[] }[] = []
  for (const line of text.split("\n")) {
    const heading = headingOf(line, kind.headings)
    if (heading !== undefined) parts.push({ label: heading, lines: [] })
    else parts.at(-1)?.lines.push(line)
  }
  const sections = parts
    .map(({ label, lines }) => ({ label, text: lines.join("\n").trim() }))
    .filter(({ text }) => text !== "")
  return {
    title: null,
    overview: sections.find(({ label }) => label === kind.overview)?.text ?? null,
    sections: sections.filter(({ label }) => label !== kind.overview),
    nextSteps: [],
    content: text.trim() || null,
  }
}

const roomOf = (text: string): string | null => {
  for (const [url] of text.matchAll(LINK)) if (joinKeyOf(url)?.startsWith("telemost:")) return joinUrlWithoutQuery(url)
  return null
}

interface Note {
  meeting: SourceMeeting
  summary: SummaryContent
}

/**
 * Meetings read from stored mail a meeting-notes rule matches, for `pull`. The notes give the day, not the hours:
 * one event of the owner's on that day in the same room gives the meeting its times; otherwise it starts at the
 * day's start, says so in `metadata.time_precision`, and no event is made for it.
 */
export const mailMeetingSource = ({
  store,
  meetings,
  address,
  rules,
  provider,
}: {
  store: MessageStore
  meetings: Pick<MeetingStore, "eventCandidates">
  address: string
  rules: readonly MailRule[]
  provider: string
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
      const stored = await store.accounts.storedAccount(mailAccountKey(address)).catch(() => null)
      if (stored === null) return []
      const facts = await store.mail.emailFacts({ accountId: stored.id, since: Date.parse(since) })
      const listed = facts.map(listedOf)
      const factsFor = factsOf(listed, ruling)
      const found: SourceMeeting[] = []
      for (const item of listed) {
        if (!ruling.some((rule) => matches(rule.match, factsFor(item)))) continue
        const email = await store.mail.email(stored.id, item.messageId)
        if (email === null || email.deletedAt !== null) continue
        const subject = email.subject ?? ""
        const date = kind.day(subject)
        const sent = email.sentAt ?? email.receivedAt
        const dayStart = date
          ? new Date(date.year, date.month - 1, date.day).getTime()
          : sent === null
            ? null
            : new Date(new Date(sent).setHours(0, 0, 0, 0)).getTime()
        if (dayStart === null || !Number.isFinite(dayStart)) continue
        const text = textOf(email)
        const joinUrl = roomOf(text)
        const [event, ...more] = joinUrl
          ? await meetings.eventCandidates({
              meetingSeriesId: null,
              joinUrl,
              startsAt: dayStart,
              endsAt: dayStart + DAY_MS,
            })
          : []
        const timed = event?.startsAt != null && more.length === 0 ? event : undefined
        const meeting: SourceMeeting = {
          joinUrl,
          metadata: { email: email.externalId, time_precision: timed ? "event" : "day" },
          series: null,
          occurrence: {
            id: email.externalId,
            seriesId: email.externalId,
            title: timed?.title ?? (subject || null),
            startedAt: new Date(timed?.startsAt ?? dayStart).toISOString(),
            endedAt: timed?.endsAt == null ? null : new Date(timed.endsAt).toISOString(),
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
 * by the mailbox's address. Mail stored before the rule was made is read the same way, with an early `since`.
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
    const key = { provider, account: address.toLowerCase() }
    const accountId = await store.accounts.saveAccount(key, { name: address.toLowerCase() })
    const source = mailMeetingSource({ store, meetings: store.meetings, address, rules, provider })
    reports[provider] = await pull(source, store.meetings, { accountId, since, now })
  }
  return reports
}
