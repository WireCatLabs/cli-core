import { type Predicate, queryError } from "@wirecat/cli-base/query"
import type { Services } from "../../services/index.js"
import { listOf } from "../envelope.js"
import { LIST_QUERY_GUIDE, listQuery, nativeTerms, searchText, timeBounds } from "../list-query.js"
import { nextStep } from "../steps.js"
import {
  auditAnswer,
  chatAnswer,
  chatEventAnswer,
  inviteLinkAnswer,
  joinRequestAnswer,
  memberAnswer,
  memberEventAnswer,
  pageOf,
  scoreFloor,
  wholeList,
} from "./chat-answers.js"
import { AUDIT_QUERY, CHATS_QUERY, EVENTS_QUERY, HISTORY_QUERY, LINKS_QUERY, REQUESTS_QUERY } from "./chat-queries.js"

/**
 * The chat lists as the CLI and MCP both answer them: the query read against the list's fields, the source
 * asked only what it answers, the rows as entities. `query` is the words typed after the arguments.
 */
export interface Paging {
  limit: number
  page: number
  all?: boolean
}

const textOf = (query: string | readonly string[] | undefined) =>
  typeof query === "string" ? query : (query ?? []).join(" ")

const typed = (query: string | readonly string[] | undefined) => textOf(query).trim() || undefined

export const chatsList = async (services: Services, query: string | readonly string[] | undefined, paging: Paging) => {
  listQuery(textOf(query), CHATS_QUERY, "chats list")
  const { limit, page, all } = paging
  const found = await services.chats.list(all ? { offset: 0 } : { limit, offset: (page - 1) * limit })
  const account = await services.chats.account()
  return listOf("chats list", {
    items: found.items.map((one) => chatAnswer(account, one)),
    ...pageOf(paging, found),
  })
}

export const chatEvents = async (services: Services, chat: string, query: string | readonly string[] | undefined) => {
  const terms = nativeTerms(listQuery(textOf(query), EVENTS_QUERY, "chats events"), "chats events")
  const { since } = timeBounds(terms.get("time"))
  const found = await services.chats.events(chat, since === undefined ? {} : { since })
  return wholeList(
    "chats events",
    found.events.map((one) => chatEventAnswer(found.chatId, one)),
    found.more ? { meta: { truncated: true } } : {},
  )
}

export const membersList = async (services: Services, chat: string, paging: Paging) => {
  const { limit, page, all } = paging
  const found = await services.chats.members(chat, all ? { offset: 0 } : { limit, offset: (page - 1) * limit })
  return listOf("chats members list", {
    items: found.items.map(memberAnswer),
    ...pageOf(paging, found),
    args: { chat },
  })
}

export const membersHistory = async (
  services: Services,
  chat: string,
  query: string | readonly string[] | undefined,
) => {
  const terms = nativeTerms(listQuery(textOf(query), HISTORY_QUERY, "chats members history"), "chats members history")
  const { since } = timeBounds(terms.get("time"))
  const found = await services.chats.memberHistory(chat, since === undefined ? {} : { since })
  return wholeList(
    "chats members history",
    found.events.map((one) => memberEventAnswer(found.chatId, one)),
    found.events.length === 0
      ? { next: [nextStep("chats.members-fetch", { args: { chat: found.chatId, track: true } })] }
      : {},
  )
}

export const membersAudit = async (
  services: Services,
  chat: string,
  query: string | readonly string[] | undefined,
  options: Omit<Parameters<Services["chats"]["audit"]>[1], "minScore">,
) => {
  const minScore = scoreFloor(listQuery(textOf(query), AUDIT_QUERY, "chats members audit"))
  const audit = await services.chats.audit(chat, { ...options, minScore })
  return { audit, body: auditAnswer(audit) }
}

/** The source takes a count but no offset, so page n reads n pages and shows the last. */
export const inviteLinks = async (
  services: Services,
  chat: string,
  query: string | readonly string[] | undefined,
  { limit, page }: Paging,
) => {
  const terms = nativeTerms(listQuery(textOf(query), LINKS_QUERY, "chats link list"), "chats link list")
  const revoked = terms.get("revoked")?.value.toLowerCase() === "true"
  const found = await services.admin.links(chat, { limit: limit * page, revoked })
  return listOf("chats link list", {
    items: found.items.slice((page - 1) * limit).map(inviteLinkAnswer),
    limit,
    has_more: found.hasMore,
    page,
    args: { chat, query: typed(query) },
  })
}

export const joinRequests = async (
  services: Services,
  chat: string,
  query: string | readonly string[] | undefined,
  { limit, page }: Paging,
) => {
  const terms = nativeTerms(listQuery(textOf(query), REQUESTS_QUERY, "chats requests list"), "chats requests list")
  if (terms.has("name") && terms.has("username"))
    queryError("query.unsupported-placement", (terms.get("username") as Predicate).span, "name or username, not both", {
      command: "chats requests list",
      guide: LIST_QUERY_GUIDE,
    })
  const search = searchText(terms.get("name") ?? terms.get("username"))
  const link = terms.get("link")?.value
  const found = await services.admin.requests(chat, {
    limit: limit * page,
    ...(search === undefined ? {} : { search }),
    ...(link === undefined ? {} : { link }),
  })
  return listOf("chats requests list", {
    items: found.items.slice((page - 1) * limit).map(joinRequestAnswer),
    limit,
    has_more: found.hasMore,
    page,
    args: { chat, query: typed(query) },
  })
}
