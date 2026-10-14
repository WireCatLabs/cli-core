import { jsonSchemaOf } from "@wirecat/cli-base/standards"
import * as v from "valibot"
import { account } from "./account.js"
import { attachment } from "./attachment.js"
import { chat } from "./chat.js"
import { contact } from "./contact.js"
import { conversation } from "./conversation.js"
import { document } from "./document.js"
import { fact } from "./fact.js"
import { reference } from "./fields.js"
import { identity } from "./identity.js"
import { meeting } from "./meeting.js"
import { memory } from "./memory.js"
import { message } from "./message.js"
import { messageLink } from "./message-link.js"
import { note } from "./note.js"
import { person } from "./person.js"
import { tagging } from "./tagging.js"
import { task } from "./task.js"

/**
 * One schema per thing a command can answer with. A command returns an entity or one of its views — a
 * subset of its fields, never a renamed one. Commands move onto these one by one; until then, a schema
 * is the target, not a description of today's output.
 */

export {
  account,
  attachment,
  chat,
  contact,
  conversation,
  document,
  fact,
  identity,
  meeting,
  memory,
  message,
  messageLink,
  note,
  person,
  reference,
  tagging,
  task,
}

export const ENTITIES = {
  message,
  "message.hit": v.pick(message, ["ref", "chat_title", "timestamp", "sender_name", "excerpt", "matched_in", "score"]),
  "message.summary": v.pick(message, ["ref", "timestamp", "sender_name", "text"]),
  message_link: messageLink,
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
  tagging,
  conversation,
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
