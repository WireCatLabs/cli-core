import { CliError } from "@wirecat/cli-base"
import { type Predicate, type QueryRegistry, queryError, queryFieldsOf } from "@wirecat/cli-base/query"
import { chat, chatEvent, inviteLink, joinRequest, member } from "../../entities/index.js"
import { AUDIT_MIN_SCORE } from "../../services/members-audit.js"
import { CHAT_COLUMNS, titlePart } from "../../store/store.js"

const titleWords = (node: Predicate) => {
  const part = titlePart(node.value)
  if (/[*?]/.test(part))
    queryError("query.unsupported-operator", node.span, "title: matches part of a title: title:book or title:*book*")
  if (part.length < 3)
    throw new CliError("validation_error", `a chat search takes at least 3 characters, got "${part}"`)
}

/**
 * The store's chat columns. Online the messenger filters nothing, so `chatsService.list` refuses every field
 * there; `--offline`, or a messenger whose history is the store, answers them.
 */
export const CHATS_QUERY: QueryRegistry = {
  entity: "chat",
  backend: "sql",
  fields: queryFieldsOf(chat, {
    exclude: Object.keys(chat.entries).filter((name) => !(name in CHAT_COLUMNS)),
    text: ["title"],
    examples: { title: "title:book", unread_count: "unread_count>0", last_message_at: "last_message_at>=7d" },
    validate: { title: titleWords },
  }),
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
