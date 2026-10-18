import { calendarKey } from "../domain/calendar.js"
import type { ChatEvents, Id, Message } from "../domain/models.js"
import type { ChatCompleteness, MemberCount } from "../store/store.js"
import { questions } from "./questions.js"

export const TOP_POSTS = 5

export type StatsPeriod = "day" | "week"

export interface TopPost {
  messageId: Id
  timestamp: string
  reactions: number
  /** Telegram channel posts only; absent where the messenger did not say. */
  views?: number
  forwards?: number
  /** Comments under a channel post. */
  comments?: number
}

export interface MemberChanges {
  joined: number
  left: number
  net: number
  /** Of those who joined in the period, how many wrote at least once afterwards. */
  wrote: number
  /** `null` when nobody who joined wrote. */
  medianMinutesToFirstMessage: number | null
  /** The messenger stopped reading its history before `since`: the counts are lower bounds. */
  more: boolean
}

export interface StatsRow {
  key: string
  messages: number
  senders: number
  joined?: number
  left?: number
}

export interface ChatStats {
  chatId: Id
  since: string
  until: string
  /** The store holds the chat whole and the messenger read every join and leave; otherwise lower bounds. */
  complete: boolean
  completeness: ChatCompleteness
  /** The command that fetches what the store lacks; only when it does not hold the chat whole. */
  fetch?: string
  messages: number
  senders: number
  replies: number
  /** Messages that are not replies themselves and got at least one reply in the period. */
  threads: number
  reactions: number
  /** Present only when some stored message carries the number. */
  views?: number
  forwards?: number
  comments?: number
  topPosts: TopPost[]
  questions: {
    asked: number
    answered: number
    medianMinutesToAnswer: number | null
    answeredBy: "owner" | "owner-and-admins"
  }
  /** The tracked member count per day in the period, from `chats members fetch`; absent when none was recorded. */
  memberCounts?: MemberCount[]
  /** Absent where the messenger was not asked: `--offline`, or one that does not say who joined. */
  members?: MemberChanges
  /**
   * The messenger's history lives in the store and the store holds no chat event for this chat yet, so `members` is
   * left out rather than counted as nobody joining.
   */
  membersUnrecorded?: true
  series?: StatsRow[]
}

const JOINS = new Set(["join", "add"])
const LEAVES = new Set(["leave", "remove"])

export const chatStats = (
  messages: Message[],
  {
    chatId,
    since,
    until,
    completeness,
    events,
    admins,
    by,
    timezone,
  }: {
    chatId: Id
    since: number
    until: number
    completeness: ChatCompleteness
    events?: ChatEvents
    admins: Id[] | null
    by?: StatsPeriod
    timezone: string
  },
): ChatStats => {
  const service = new Set(events?.events.map(({ messageId }) => messageId))
  const held = messages.filter(
    (one) =>
      !service.has(one.id) &&
      one.providerMetadata?.action === undefined &&
      !one.attachments.some(({ kind }) => kind === "control"),
  )
  const replied = new Set(held.flatMap((one) => one.replyToId ?? one.replyTo?.id ?? []))
  const asked = questions(held, { answerers: new Set(admins ?? []) })
  const answered = asked.flatMap(({ question, answer }) =>
    answer ? [(Date.parse(answer.timestamp) - Date.parse(question.timestamp)) / 60_000] : [],
  )

  return {
    chatId,
    since: new Date(since).toISOString(),
    until: new Date(until).toISOString(),
    complete: completeness.state === "complete" && events?.more !== true,
    completeness,
    messages: held.length,
    senders: sendersOf(held),
    replies: held.filter((one) => (one.replyToId ?? one.replyTo?.id) !== undefined).length,
    threads: held.filter((one) => replied.has(one.id) && (one.replyToId ?? one.replyTo?.id) === undefined).length,
    reactions: sum(held.map(reactionsOf)),
    ...summed(held, "views"),
    ...summed(held, "forwards"),
    ...summed(held, "comments"),
    topPosts: topPosts(held),
    questions: {
      asked: asked.length,
      answered: answered.length,
      medianMinutesToAnswer: median(answered),
      answeredBy: admins === null ? "owner" : "owner-and-admins",
    },
    ...(events ? { members: membersOf(events, held, since) } : {}),
    ...(by ? { series: seriesOf(held, events, by, timezone) } : {}),
  }
}

const sendersOf = (messages: Message[]) => new Set(messages.flatMap(({ senderId }) => senderId ?? [])).size

const reactionsOf = ({ reactions }: Message) => reactions?.total ?? 0

type Counted = "views" | "forwards" | "comments"

const counted = (message: Message, name: Counted): number | undefined => {
  const value = message.providerMetadata?.[name]
  return typeof value === "number" ? value : undefined
}

const summed = (messages: Message[], name: Counted) => {
  const values = messages.flatMap((one) => counted(one, name) ?? [])
  return values.length === 0 ? {} : { [name]: sum(values) }
}

const topPosts = (messages: Message[]): TopPost[] =>
  messages
    .map((one) => {
      const views = counted(one, "views")
      const forwards = counted(one, "forwards")
      const comments = counted(one, "comments")
      return {
        messageId: one.id,
        timestamp: one.timestamp,
        reactions: reactionsOf(one),
        ...(views === undefined ? {} : { views }),
        ...(forwards === undefined ? {} : { forwards }),
        ...(comments === undefined ? {} : { comments }),
      }
    })
    .filter((one) => one.reactions > 0 || (one.views ?? 0) > 0)
    .sort((a, b) => b.reactions - a.reactions || (b.views ?? 0) - (a.views ?? 0))
    .slice(0, TOP_POSTS)

const membersOf = ({ events, more }: ChatEvents, messages: Message[], since: number): MemberChanges => {
  const inPeriod = events.filter(({ timestamp }) => Date.parse(timestamp) >= since)
  const people = (names: Set<string>) =>
    inPeriod
      .filter(({ event }) => names.has(event))
      .flatMap(({ timestamp, people }) => people.map(({ id }) => ({ id, at: Date.parse(timestamp) })))
  const joined = people(JOINS)
  const left = people(LEAVES)
  const firstWords = joined.flatMap(({ id, at }) => {
    const first = messages.find((one) => one.senderId === id && Date.parse(one.timestamp) >= at)
    return first ? [(Date.parse(first.timestamp) - at) / 60_000] : []
  })
  return {
    joined: joined.length,
    left: left.length,
    net: joined.length - left.length,
    wrote: firstWords.length,
    medianMinutesToFirstMessage: median(firstWords),
    more,
  }
}

const seriesOf = (
  messages: Message[],
  events: ChatEvents | undefined,
  by: StatsPeriod,
  timezone: string,
): StatsRow[] => {
  const dayOf = calendarKey(timezone, "day")
  const keyOf = (timestamp: string) => {
    const day = dayOf(Date.parse(timestamp))
    if (by === "day") return day
    const date = new Date(`${day}T00:00:00Z`)
    date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7))
    return date.toISOString().slice(0, 10)
  }
  const rows = new Map<string, { messages: Message[]; joined: number; left: number }>()
  const row = (key: string) => {
    const found = rows.get(key) ?? { messages: [], joined: 0, left: 0 }
    rows.set(key, found)
    return found
  }
  for (const one of messages) row(keyOf(one.timestamp)).messages.push(one)
  for (const { timestamp, event, people } of events?.events ?? []) {
    if (JOINS.has(event)) row(keyOf(timestamp)).joined += people.length
    if (LEAVES.has(event)) row(keyOf(timestamp)).left += people.length
  }
  return [...rows.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, found]) => ({
      key,
      messages: found.messages.length,
      senders: sendersOf(found.messages),
      ...(events ? { joined: found.joined, left: found.left } : {}),
    }))
}

const sum = (values: number[]) => values.reduce((total, value) => total + value, 0)

const median = (values: number[]): number | null => {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  const upper = sorted[middle] ?? 0
  return Math.round(sorted.length % 2 === 0 ? ((sorted[middle - 1] ?? upper) + upper) / 2 : upper)
}
