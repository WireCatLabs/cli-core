import { defineQuery, queryError } from "@wirecat/cli-base/query"
import type { Meta, Missing, NextStep } from "@wirecat/cli-base/standards"
import type { ChatKind, Inbox, Message, Review } from "../../domain/models.js"
import { kindsOf } from "../../services/inbox.js"
import { type Hearing, heard, hearingMissing } from "../../speech/hearing.js"
import type { AccountKey } from "../../store/store.js"
import { listOf } from "../envelope.js"
import { listQuery, nativeField, nativeTerms, type QueryWords, timeBounds, typedQuery } from "../list-query.js"
import { nextStep } from "../steps.js"
import { messageItem } from "./message-items.js"

const date = nativeField({ name: "date", type: "time", operators: ["range"], example: "date>2h" })

const kind = nativeField({ name: "kind", type: "kw", operators: ["term", "phrase"], example: "kind:group,channel" })

/** Where `inbox` starts reading: everything after a time. */
export const INBOX_QUERY = defineQuery({ entity: "message", backend: "native", fields: [date, kind] })

/** Where `review` starts, and the one chat it reads. */
export const REVIEW_QUERY = defineQuery({
  entity: "message",
  backend: "native",
  fields: [date, kind, nativeField({ name: "chat", type: "kw", operators: ["term", "phrase"], example: "chat:7" })],
})

/** The query's start and chat. A catch-up reads forward from one point, so an end is refused. */
export const catchUpQuery = (
  words: QueryWords,
  registry: typeof INBOX_QUERY,
  command: string,
): { since?: number; chat?: string; kinds?: ChatKind[]; meta?: Partial<Meta> } => {
  const terms = nativeTerms(listQuery(typedQuery(words), registry, command), command)
  const term = terms.get("date")
  const { since, until, meta } = timeBounds(term)
  if (term && (until !== undefined || since === undefined))
    queryError("query.unsupported-operator", term.span, `${command} reads from a point on: date>2h, not an end`, {
      command,
    })
  const chat = terms.get("chat")?.value
  const kinds = terms.get("kind")?.value
  return {
    ...(since === undefined ? {} : { since }),
    ...(chat === undefined ? {} : { chat }),
    ...(kinds === undefined ? {} : { kinds: kindsOf(kinds, "kind:") }),
    ...(meta === undefined ? {} : { meta }),
  }
}

type Read = Message & { chatTitle?: string | null }

const summaryOf = (message: Read, reader: AccountKey) => {
  const { ref, chat_id, chat_title, timestamp, sender_name, sender_is_me, outgoing, text, transcript, attachments } =
    messageItem(message, reader)
  return {
    ref,
    chat_id,
    chat_title,
    timestamp,
    sender_name,
    sender_is_me,
    outgoing,
    text,
    ...(transcript === undefined ? {} : { transcript }),
    attachments,
  }
}

interface Shared {
  chats: { id: string; title: string | null; messages: Message[]; more: boolean }[]
  skipped: { id: string; title: string | null }[]
  partial: boolean
  quiet: number
}

const nameOf = (chat: { id: string; title: string | null }) => chat.title ?? chat.id

/**
 * What every catch-up answer shares: the messages, oldest first, each naming its chat; what was left out as
 * `missing`; and a chat cut short as a `messages.list` step, after the steps the command puts first.
 */
const catchUpList = (
  command: "inbox" | "review",
  found: Shared,
  hearing: Hearing | undefined,
  reader: AccountKey,
  {
    transcribe,
    first = [],
    meta = {},
    left = [],
  }: { transcribe: boolean; first?: NextStep[]; meta?: Partial<Meta>; left?: Missing[] },
) => {
  const read = found.chats
    .flatMap((chat) => heard(chat.messages, hearing).map((message) => ({ ...message, chatTitle: chat.title })))
    .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp))
  const cut = found.chats.filter((chat) => chat.more)
  const missing: Missing[] = [
    ...(cut.length > 0
      ? [{ field: "items", why: `only the newest of ${cut.map(nameOf).join(", ")}`, step: "messages.list" }]
      : []),
    ...(found.skipped.length > 0
      ? [
          {
            field: "items",
            why: `skipped ${found.skipped.length} chats — too many at once: ${found.skipped.map(nameOf).join(", ")}`,
            step: "messages.list",
          },
        ]
      : []),
    ...(found.quiet > 0
      ? [{ field: "items", why: `${found.quiet} muted or archived chats left out`, step: `${command}.all` }]
      : []),
    ...hearingMissing(hearing, transcribe),
    ...left,
  ]
  return listOf(command, {
    items: read.map((message) => summaryOf(message, reader)),
    limit: Math.max(1, read.length),
    has_more: false,
    next: [...first, ...cut.map((chat) => nextStep("messages.list", { args: { chat: chat.id } }))],
    missing,
    meta: { ...meta, ...(found.partial ? { truncated: true } : {}) },
  })
}

export const inboxAnswer = (
  inbox: Inbox,
  hearing: Hearing | undefined,
  reader: AccountKey,
  transcribe: boolean,
  meta: Partial<Meta> = {},
) => catchUpList("inbox", inbox, hearing, reader, { transcribe, meta })

/** What `review --offline` cannot see. */
export const OFFLINE_REVIEW =
  "offline: only what was already synced to the local store; run review without --offline for the rest"

const quoted = (value: string) => `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`

/**
 * A review the next one goes on from: from `until` when nothing was left out, else from the same start again.
 * Saved points (`--new`) carry this themselves, and an `--unanswered` look is not a review to continue.
 */
export const reviewAnswer = (
  found: Review,
  hearing: Hearing | undefined,
  reader: AccountKey,
  { transcribe, fresh, chat, meta }: { transcribe: boolean; fresh: boolean; chat?: string; meta?: Partial<Meta> },
) => {
  const continues = !fresh && found.unanswered === undefined
  const query = [
    `date>${quoted(found.complete ? found.until : found.since)}`,
    ...(chat === undefined ? [] : [`chat:${quoted(chat)}`]),
  ]
  return catchUpList("review", found, hearing, reader, {
    transcribe,
    first: continues ? [nextStep("review.next", { args: { query: query.join(" ") } })] : [],
    ...(found.offline ? { left: [{ field: "items", why: OFFLINE_REVIEW }] } : {}),
    ...(meta === undefined ? {} : { meta }),
  })
}
