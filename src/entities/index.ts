import { isoTime, jsonSchemaOf } from "@wirecat/cli-base/standards"
import * as v from "valibot"
import { FACT_STATUSES, FACT_TYPES } from "../store/sqlite/facts.js"
import { MEMORY_KINDS, MEMORY_SCOPES, MEMORY_STATUSES } from "../store/sqlite/memories.js"
import { TASK_TYPES } from "../store/sqlite/work-tasks.js"
import { TASK_ORIGINS, TASK_STATES } from "../tasks/index.js"

/**
 * One schema per thing a command can answer with. A command returns an entity or one of its views — a
 * subset of its fields, never a renamed one. Commands move onto these one by one; until then, a schema
 * is the target, not a description of today's output.
 */

const text = v.string()
const id = v.pipe(v.string(), v.minLength(1))
const time = isoTime
const count = v.pipe(v.number(), v.integer(), v.minValue(0))

/** The typed name of a stored thing, `msg:telegram/1/2/3` or `note:42`: what every other command takes. */
export const reference = v.pipe(v.string(), v.regex(/^[a-z]+:\S+$/, "a reference such as `note:42`"))

const providerMetadata = v.optional(v.record(v.string(), v.unknown()))

const author = v.strictObject({
  type: v.picklist(["person", "bot"]),
  id,
  name: v.nullable(text),
})

export const attachment = v.strictObject({
  /** Lower-cased: `photo`, `video`, `file`, `voice`… */
  kind: text,
  /** Its place among the message's attachments, from 0. */
  position: v.optional(count),
  url: v.optional(text),
  name: v.optional(text),
  title: v.optional(text),
  mime: v.optional(text),
  size: v.optional(count),
  width: v.optional(count),
  height: v.optional(count),
  /** Seconds, for audio and video. */
  duration: v.optional(v.number()),
  /** The text read out of it; how it was read is `extraction`. */
  text: v.optional(text),
  extraction: v.optional(v.strictObject({ origin: text, extractor: text, chars: count, error: v.optional(text) })),
  localPath: v.optional(text),
})

const quoted = v.strictObject({
  id,
  senderId: v.nullable(id),
  senderName: v.nullable(text),
  timestamp: v.nullable(time),
  text,
  attachments: v.array(attachment),
  outgoing: v.nullable(v.boolean()),
})

const mailPerson = v.strictObject({ name: v.nullable(text), address: text, ref: v.nullable(reference) })

export const message = v.strictObject({
  /** The message's locator. */
  ref: reference,
  id,
  provider: v.optional(text),
  account: v.optional(text),
  chatId: id,
  chatTitle: v.optional(v.nullable(text)),
  senderId: v.nullable(id),
  senderName: v.nullable(text),
  senderUsername: v.optional(text),
  senderIsChat: v.optional(v.boolean()),
  mentions: v.optional(v.array(id)),
  /** When it was sent. */
  timestamp: time,
  editedAt: v.nullable(time),
  text,
  /** A stretch of the text, transcript, file name or file text around what a search matched. */
  excerpt: v.optional(text),
  matchedIn: v.optional(v.picklist(["text", "transcript", "filename", "file"])),
  score: v.optional(v.number()),
  outgoing: v.nullable(v.boolean()),
  attachments: v.array(attachment),
  replyTo: v.nullable(quoted),
  /** The id a reply answers, also when the provider sent no copy of that message. */
  replyToId: v.optional(id),
  forwardedFrom: v.nullable(quoted),
  threadId: v.optional(id),
  threadRootId: v.optional(id),
  reactions: v.optional(
    v.nullable(
      v.strictObject({
        counts: v.array(v.strictObject({ reaction: text, count })),
        mine: v.nullable(text),
        total: count,
      }),
    ),
  ),
  scheduledFor: v.optional(time),
  email: v.optional(
    v.strictObject({
      subject: v.nullable(text),
      from: v.nullable(mailPerson),
      to: v.array(mailPerson),
      cc: v.array(mailPerson),
      bcc: v.array(mailPerson),
      replyTo: v.array(mailPerson),
      labels: v.array(text),
      /** The thread as a `chat:` reference. */
      thread: reference,
      read: v.nullable(v.boolean()),
      flagged: v.nullable(v.boolean()),
    }),
  ),
  providerMetadata,
})

export const chat = v.strictObject({
  ref: reference,
  id,
  provider: v.optional(text),
  account: v.optional(text),
  title: v.nullable(text),
  kind: v.picklist(["dialog", "group", "channel", "saved", "unknown"]),
  unreadCount: v.nullable(count),
  unreadMentions: v.optional(count),
  lastMessageAt: v.nullable(time),
  participantsCount: v.nullable(count),
  muted: v.optional(v.boolean()),
  archived: v.optional(v.boolean()),
  membershipState: v.optional(v.picklist(["joined", "left", "public", "imported", "archived", "external"])),
  parentChatId: v.optional(id),
  scope: v.optional(v.picklist(["personal", "work"])),
  providerMetadata,
})

/** One account of a person in one messenger or mailbox. */
export const identity = v.strictObject({
  ref: reference,
  provider: text,
  account: text,
  /** The messenger's own id for them. */
  id,
  name: v.nullable(text),
  username: v.nullable(text),
  /** The `person:` they are linked to, when one is. */
  person: v.optional(v.nullable(reference)),
})

/** Somebody in a messenger's contact list. */
export const contact = v.strictObject({
  ref: reference,
  id,
  name: v.nullable(text),
  username: v.nullable(text),
  alias: v.optional(v.nullable(text)),
  displayName: v.optional(v.nullable(text)),
  /** Whatever they wrote about themselves. */
  description: v.nullable(text),
  /** The newest message in a one-to-one chat with them. */
  lastMessagedAt: v.nullable(time),
})

/** One human across messengers and mailboxes. */
export const person = v.strictObject({
  ref: reference,
  name: v.nullable(text),
  identities: v.optional(v.array(identity)),
})

/** Who a profile is signed in as. `id` is the messenger's own id, never the store's row number. */
export const account = v.strictObject({
  provider: text,
  id,
  name: v.nullable(text),
  username: v.nullable(text),
  phone: v.optional(v.nullable(text)),
  scope: v.optional(v.picklist(["personal", "work"])),
})

export const note = v.strictObject({
  ref: reference,
  id,
  source: v.picklist(["file", "internal"]),
  folderId: v.nullable(id),
  path: v.nullable(text),
  title: v.nullable(text),
  text,
  createdAt: time,
  /** When the store's copy last changed. */
  updatedAt: time,
  deletedAt: v.optional(v.nullable(time)),
})

/** A file kept elsewhere — Google Drive, a notes folder, a message. */
export const document = v.strictObject({
  ref: reference,
  id,
  title: v.nullable(text),
  url: v.nullable(text),
  mime: v.optional(text),
  size: v.optional(count),
  /** When its source last changed it. */
  modifiedAt: v.nullable(time),
  /** When the store last read it; not the source's time. */
  storedAt: v.optional(v.nullable(time)),
  owners: v.optional(v.array(text)),
})

export const task = v.strictObject({
  ref: reference,
  id,
  title: v.nullable(text),
  description: v.optional(v.nullable(text)),
  kind: v.picklist(TASK_TYPES),
  state: v.picklist(TASK_STATES),
  origin: v.optional(v.picklist(TASK_ORIGINS)),
  project: v.optional(v.nullable(text)),
  account: v.optional(text),
  /** The chat it came from, as a `chat:` reference. */
  chat: v.optional(v.nullable(reference)),
  /** The message it came from. */
  source: v.optional(v.nullable(reference)),
  priority: v.optional(v.nullable(v.number())),
  parent: v.optional(v.nullable(reference)),
  dueAt: v.optional(v.nullable(time)),
  closedAt: v.optional(v.nullable(time)),
  reason: v.optional(v.nullable(text)),
  createdAt: time,
  updatedAt: v.optional(time),
})

export const fact = v.strictObject({
  ref: reference,
  id,
  kind: v.picklist(FACT_TYPES),
  text,
  status: v.picklist(FACT_STATUSES),
  project: v.nullable(text),
  subject: v.nullable(reference),
  occurredAt: v.nullable(time),
  supersedes: v.nullable(reference),
  author,
  model: v.nullable(text),
  scope: v.nullable(v.picklist(MEMORY_SCOPES)),
  source: text,
  evidence: v.array(reference),
  createdAt: time,
  updatedAt: time,
})

export const memory = v.strictObject({
  ref: reference,
  id,
  kind: v.picklist(MEMORY_KINDS),
  text,
  subject: v.nullable(reference),
  author,
  model: v.nullable(text),
  confidence: v.nullable(v.number()),
  status: v.picklist(MEMORY_STATUSES),
  scope: v.picklist(MEMORY_SCOPES),
  supersedes: v.nullable(reference),
  evidence: v.array(reference),
  lastVerifiedAt: v.nullable(time),
  createdAt: time,
  updatedAt: time,
})

export const meeting = v.strictObject({
  ref: reference,
  id,
  provider: text,
  account: text,
  title: v.nullable(text),
  description: v.optional(v.nullable(text)),
  location: v.optional(v.nullable(text)),
  /** The link that joins it. */
  url: v.nullable(text),
  startedAt: v.nullable(time),
  endedAt: v.nullable(time),
  durationMs: v.nullable(count),
  timezone: v.optional(v.nullable(text)),
  participantsCount: v.nullable(count),
  createdAt: time,
  updatedAt: time,
})

export const ENTITIES = {
  message,
  "message.hit": v.pick(message, ["ref", "chatTitle", "timestamp", "senderName", "excerpt", "matchedIn", "score"]),
  "message.summary": v.pick(message, ["ref", "timestamp", "senderName", "text"]),
  chat,
  person,
  identity,
  contact,
  account,
  note,
  document,
  attachment,
  task,
  fact,
  memory,
  meeting,
  reference,
} as const

export type EntityName = keyof typeof ENTITIES

/** Every entity as a JSON Schema 2020-12 `$defs` entry, for bundling into an MCP tool's `outputSchema`. */
export const entityDefinitions = (): Record<EntityName, unknown> =>
  Object.fromEntries(
    Object.entries(ENTITIES).map(([name, schema]) => {
      const { $schema: _, ...definition } = jsonSchemaOf(schema) as Record<string, unknown>
      return [name, definition]
    }),
  ) as Record<EntityName, unknown>
