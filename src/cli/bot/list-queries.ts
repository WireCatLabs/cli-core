import { type QueryRegistry, queryError, queryFieldsOf } from "@wirecat/cli-base/query"
import { botAdmin, botMenuEntry, botProfile, botSeenChat, botWebhook, message } from "../../entities/index.js"
import {
  listQuery,
  nativeTerms,
  type QueryWords,
  queryTerms,
  timeBounds,
  typedQuery,
  unfilteredQuery,
} from "../list-query.js"
import type { SeenChat } from "./registry.js"

const termsOnly = (registry: QueryRegistry): QueryRegistry => ({
  ...registry,
  fields: registry.fields.map((field) =>
    field.native
      ? {
          ...field,
          operators: field.operators.filter((operator) => operator === "term" || operator === "phrase"),
        }
      : field,
  ),
})

export const BOT_PROFILES_QUERY = termsOnly({
  entity: "bot_profile",
  backend: "native",
  fields: queryFieldsOf(botProfile, { native: ["name"], examples: { name: "name:sales" } }),
})

export const botProfileName = (words: QueryWords) => queryTerms(words, BOT_PROFILES_QUERY, "bot list").get("name")

export const BOT_CHATS_QUERY = termsOnly({
  entity: "bot_seen_chat",
  backend: "native",
  fields: queryFieldsOf(botSeenChat, {
    native: ["id", "title", "kind"],
    examples: { id: "id:7", title: 'title:"Book club"', kind: "kind:group" },
  }),
})

export const botChatFilter = (words: QueryWords): Partial<Pick<SeenChat, "id" | "title" | "kind">> => {
  const terms = queryTerms(words, BOT_CHATS_QUERY, "bot chats list")
  const id = terms.get("id"),
    title = terms.get("title")
  const kind = botSeenChat.entries.kind.wrapped.options.find((value) => value === terms.get("kind"))
  return {
    ...(id === undefined ? {} : { id }),
    ...(title === undefined ? {} : { title }),
    ...(kind === undefined ? {} : { kind }),
  }
}

export const BOT_MESSAGES_QUERY: QueryRegistry = {
  entity: "message",
  backend: "native",
  fields: queryFieldsOf(message, {
    native: ["id", "timestamp", "thread_id", "outgoing", "starred"],
    examples: {
      id: "id<42",
      timestamp: "timestamp>2026-10-01",
      thread_id: "thread_id:12",
      outgoing: "outgoing:false",
      starred: "starred:true",
    },
  }).map((field) => {
    if (field.name === "id" || field.name === "timestamp") return { ...field, operators: ["range"] }
    return field.native ? { ...field, operators: ["term"] } : field
  }),
}

export const botMessageWindow = (words: QueryWords) => {
  const command = "bot messages list"
  const terms = nativeTerms(listQuery(typedQuery(words), BOT_MESSAGES_QUERY, command), command)
  const id = terms.get("id")
  if (id && (id.value !== "*" || !id.upper || id.upper === "*" || id.upper_inclusive !== false))
    queryError("query.unsupported-operator", id.span, "id takes an exclusive upper bound here: id<42", { command })
  const timestamp = terms.get("timestamp")
  const bounds = timeBounds(timestamp)
  if (timestamp && (bounds.since === undefined || bounds.until !== undefined))
    queryError("query.unsupported-operator", timestamp.span, "timestamp takes a lower bound here: timestamp>7d", {
      command,
    })
  const topic = terms.get("thread_id")?.value
  const outgoing = terms.get("outgoing")?.value.toLowerCase()
  const starred = terms.get("starred")?.value.toLowerCase()
  return {
    window: {
      ...(id?.upper === undefined ? {} : { before: id.upper }),
      ...(bounds.since === undefined ? {} : { since: new Date(bounds.since).toISOString() }),
      ...(topic === undefined ? {} : { threadId: topic }),
      ...(outgoing === undefined ? {} : { outgoing: outgoing === "true" }),
      ...(starred === undefined ? {} : { starred: starred === "true" }),
    },
    meta: bounds.meta,
  }
}

export const BOT_ADMINS_QUERY = unfilteredQuery("bot_admin", botAdmin)
export const BOT_MENU_QUERY = unfilteredQuery("bot_menu_entry", botMenuEntry)
export const BOT_WEBHOOKS_QUERY = unfilteredQuery("bot_webhook", botWebhook)
