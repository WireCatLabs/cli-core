import { jsonSchemaOf } from "@wirecat/cli-base/standards"
import * as v from "valibot"
import { account } from "./account.js"
import { attachment } from "./attachment.js"
import { chat } from "./chat.js"
import { chatEvent } from "./chat-event.js"
import { contact } from "./contact.js"
import { conversation } from "./conversation.js"
import { document } from "./document.js"
import { fact } from "./fact.js"
import { reference } from "./fields.js"
import { folder } from "./folder.js"
import { hit } from "./hit.js"
import { identity } from "./identity.js"
import { inviteLink } from "./invite-link.js"
import { joinRequest } from "./join-request.js"
import { meeting } from "./meeting.js"
import { member } from "./member.js"
import { memory } from "./memory.js"
import { message } from "./message.js"
import { messageLink } from "./message-link.js"
import { note } from "./note.js"
import { person } from "./person.js"
import { pollVote } from "./poll-vote.js"
import { tagging } from "./tagging.js"
import { task } from "./task.js"
import { topic } from "./topic.js"

/**
 * One schema per thing a command can answer with. A command returns an entity or one of its views — a
 * subset of its fields, never a renamed one. Commands move onto these one by one; until then, a schema
 * is the target, not a description of today's output.
 */

export {
  account,
  attachment,
  chat,
  chatEvent,
  contact,
  conversation,
  document,
  fact,
  folder,
  hit,
  identity,
  inviteLink,
  joinRequest,
  meeting,
  member,
  memory,
  message,
  messageLink,
  note,
  person,
  pollVote,
  reference,
  tagging,
  task,
  topic,
}

export const ENTITIES = {
  message,
  "message.hit": v.pick(message, [
    "ref",
    "chat_title",
    "timestamp",
    "sender_name",
    "excerpt",
    "matched_in",
    "score",
    "found_in",
    "discovery",
    "context",
    "email",
  ]),
  "message.summary": v.pick(message, ["ref", "timestamp", "sender_name", "text"]),
  message_link: messageLink,
  chat,
  person,
  identity,
  contact,
  account,
  note,
  "note.hit": v.pick(note, [
    "ref",
    "source",
    "folder_id",
    "path",
    "title",
    "updated_at",
    "excerpt",
    "found_by",
    "links",
  ]),
  hit,
  document,
  attachment,
  task,
  fact,
  memory,
  meeting,
  reference,
  tagging,
  conversation,
  chat_event: chatEvent,
  invite_link: inviteLink,
  join_request: joinRequest,
  member,
  poll_vote: pollVote,
  topic,
  folder,
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
