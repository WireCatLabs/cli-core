import type { QueryRegistry } from "@wirecat/cli-base/query"
import { queryFieldsOf } from "@wirecat/cli-base/query"
import { chat, chatEvent } from "../../entities/index.js"

/** Neither the messenger nor the store filters the chat list, so every field is refused for now. */
export const CHATS_QUERY: QueryRegistry = {
  entity: "chat",
  backend: "native",
  fields: queryFieldsOf(chat, { exclude: ["provider_metadata"] }),
}

/** The messenger reads a chat's events back to a time; it cannot pick them by type. */
export const EVENTS_QUERY: QueryRegistry = {
  entity: "chat_event",
  backend: "native",
  fields: queryFieldsOf(chatEvent, { native: ["time"], examples: { time: "time>=2d" } }),
}
