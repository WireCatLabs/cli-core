import type { QueryRegistry } from "@wirecat/cli-base/query"
import { queryFieldsOf } from "@wirecat/cli-base/query"
import { chat, chatEvent, inviteLink, joinRequest, member } from "../../entities/index.js"
import { AUDIT_MIN_SCORE } from "../../services/members-audit.js"

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

/** The store's member history is read back to a time. */
export const HISTORY_QUERY: QueryRegistry = {
  entity: "chat_event",
  backend: "native",
  fields: queryFieldsOf(chatEvent, { native: ["time"], examples: { time: "time>=7d" } }),
}

/** The audit scores every member it reads; the query sets the lowest score it shows. */
export const AUDIT_QUERY: QueryRegistry = {
  entity: "member",
  backend: "native",
  fields: queryFieldsOf(member, { exclude: ["check"], native: ["score"], examples: { score: "score>=3" } }),
  defaults: [`score>=${AUDIT_MIN_SCORE}`],
}

/** The messenger lists either the live links or the revoked ones. */
export const LINKS_QUERY: QueryRegistry = {
  entity: "invite_link",
  backend: "native",
  fields: queryFieldsOf(inviteLink, { native: ["revoked"] }),
}

/** The messenger searches requests by name or @username, or keeps one link's; never both at once. */
export const REQUESTS_QUERY: QueryRegistry = {
  entity: "join_request",
  backend: "native",
  fields: queryFieldsOf(joinRequest, {
    native: ["name", "username", "link"],
    text: ["name", "username"],
    relations: {
      link: { type: "kw", example: 'link:"https://example.test/+abc"', relation: "the invite link they asked through" },
    },
    examples: { name: "name:ana", username: "username:ana" },
  }),
}
