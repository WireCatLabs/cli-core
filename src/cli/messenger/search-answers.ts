import type { Missing, NextStep } from "@wirecat/cli-base/standards"
import type { InferOutput } from "valibot"
import { formatLocator, parseLocator } from "../../domain/locator.js"
import { DEFAULT_TEXT_MODEL } from "../../embeddings/models.js"
import type { ENTITIES } from "../../entities/index.js"
import { excerpt } from "../../services/excerpt.js"
import { type FoundMessage, MAX_SEARCH_OFFSET, type SearchFound } from "../../services/messages.js"
import type { FoundNote, NotesFoundOf } from "../../services/notes-search.js"
import type { SearchAllItem } from "../../services/search-all.js"
import type { MeetingSearchItem, SearchAllIncludingMeetingsFound } from "../../services/search-all-meetings.js"
import { type ListBody, listOf } from "../envelope.js"
import { nextStep } from "../steps.js"
import { archiveSummary } from "./archive-summary.js"

export type MessageHitItem = InferOutput<(typeof ENTITIES)["message.hit"]>
export type NoteHitItem = InferOutput<(typeof ENTITIES)["note.hit"]>
export type HitItem = InferOutput<(typeof ENTITIES)["hit"]>

const defined = <T extends object>(value: T): T =>
  Object.fromEntries(Object.entries(value).filter(([, one]) => one !== undefined)) as T

/** The page a `--page` asks for, as the offset the search services take. */
export const offsetOf = (page: number | undefined, limit: number): number | undefined =>
  page === undefined || page <= 1 ? undefined : (page - 1) * limit

export const messageHitItem = (hit: FoundMessage, query = ""): MessageHitItem => {
  const at = parseLocator(hit.locator)
  const around = hit.thread?.items ?? hit.context
  return defined({
    ref: hit.locator,
    chat_title: hit.chatTitle ?? undefined,
    timestamp: hit.timestamp,
    sender_name: hit.senderName,
    excerpt: hit.excerpt ?? excerpt(hit.text, query),
    matched_in: hit.matchedIn,
    score: hit.score ?? undefined,
    found_in: hit.source,
    discovery: hit.discovery
      ? defined({
          coverage: hit.discovery.coverage,
          matched_terms: hit.discovery.matchedTerms,
          missing_terms: hit.discovery.missingTerms,
          parent: hit.discovery.parent,
        })
      : undefined,
    email: hit.email
      ? {
          subject: hit.email.subject,
          from: hit.email.from,
          to: hit.email.to,
          cc: hit.email.cc,
          bcc: hit.email.bcc,
          reply_addresses: hit.email.replyTo,
          labels: hit.email.labels,
          thread: hit.email.thread,
          read: hit.email.read,
          flagged: hit.email.flagged,
        }
      : undefined,
    context: around?.map((one) => ({
      ref: formatLocator({ ...at, message: one.id }),
      timestamp: one.timestamp,
      sender_name: one.senderName,
      text: one.text,
    })),
  })
}

const accountName = ({ provider, account }: { provider: string; account: string }) => `${provider}:${account}`

const metaOf = (
  accounts: readonly { provider: string; account: string }[],
  skipped: readonly { source?: string; resource?: string; reason: string }[] = [],
) => ({
  accounts: accounts.map(accountName),
  ...(skipped.length
    ? { skipped: skipped.map(({ source, resource, reason }) => ({ account: source ?? resource ?? "", why: reason })) }
    : {}),
})

/** What the archive lacked for this answer, and the step that would fill it. */
const gapsOf = (found: SearchFound): { next: NextStep[]; missing: Missing[] } => {
  const next: NextStep[] = []
  const missing: Missing[] = []
  const coverage = found.coverage
  const stale = found.refreshed?.complete === false
  if (coverage?.next || stale) {
    next.push(
      nextStep("messages.sync", {
        args: coverage?.chat === undefined ? { all: true, background: true } : { chat: coverage.chat },
      }),
    )
    missing.push({
      field: "coverage",
      why: stale
        ? "the fetch before searching stopped early, so the answer may be stale"
        : ((coverage && archiveSummary(coverage, found.items.length)) ?? "the local copy may be missing messages"),
      step: "messages.sync",
    })
  }
  const building =
    !found.wordsReady || (found.query?.stemming?.applied === false && found.query.stemming.reason === "building")
  if (building) {
    next.push(nextStep("store.migrate", { args: {} }))
    missing.push({
      field: "text",
      why: found.wordsReady
        ? "other forms of words are not searched while their index is built"
        : "the word index is still being built, so words were matched by pieces",
      step: "store.migrate",
    })
  }
  if (found.picturesModel !== undefined) {
    next.push(nextStep("models.download-image", { args: { model: found.picturesModel } }))
    missing.push({
      field: "pictures",
      why: "the picture model is not downloaded, so pictures were not searched by what they show",
      step: "models.download-image",
    })
  }
  return { next, missing }
}

/** The picture lane's hits, after the text hits and not among them. */
const pictureItems = (found: SearchFound): MessageHitItem[] => {
  const shown = new Set(found.items.map(({ locator }) => locator))
  return (found.pictures ?? [])
    .filter(({ locator }) => !shown.has(locator))
    .map(({ locator, timestamp, senderName, score }) => ({
      ref: locator,
      timestamp,
      sender_name: senderName,
      matched_in: "picture",
      score,
    }))
}

export interface Paging {
  limit: number
  page?: number
  /** The query and options `page.next` repeats. */
  again?: Record<string, unknown>
}

/** `search messages` and `search mail`, CLI and MCP alike. */
export const messagesAnswer = (
  command: string,
  found: SearchFound,
  { limit, page, again }: Paging,
  query = "",
): ListBody<MessageHitItem> => {
  const accounts = found.coverage?.accounts ?? found.accounts ?? []
  return listOf(command, {
    items: [...found.items.map((hit) => messageHitItem(hit, query)), ...pictureItems(found)],
    limit,
    has_more: found.hasMore && (page ?? 1) * limit <= MAX_SEARCH_OFFSET,
    page: page ?? 1,
    ...(again ? { args: again } : {}),
    ...gapsOf(found),
    meta: metaOf(accounts, found.skipped),
  })
}

export const noteHitItem = (hit: FoundNote): NoteHitItem =>
  defined({
    ref: hit.ref,
    source: hit.source,
    folder_id: hit.folderId,
    path: hit.path,
    title: hit.title,
    updated_at: hit.modifiedAt,
    excerpt: hit.line,
    found_by: hit.foundBy,
    links: hit.links.map(({ to, targetText, kind, anchor }) => ({ to, target_text: targetText, kind, anchor })),
  })

export const allHitItem = (item: SearchAllItem | MeetingSearchItem): HitItem =>
  item.kind === "meeting"
    ? {
        kind: "meeting",
        ref: item.ref,
        provider: item.provider,
        account: item.account,
        title: item.title,
        timestamp: item.timestamp,
        excerpt: item.text,
        offset_ms: item.startMs,
      }
    : defined({
        kind: item.kind,
        ref: item.ref,
        provider: item.provider,
        account: item.account,
        title: item.title,
        timestamp: item.timestamp,
        excerpt: item.text,
        sender_name: item.from?.name,
        sender_ref: item.from?.ref,
        found_by: item.foundBy,
      })

/** Meaning was not searched because the model is not downloaded; `--exact` leaving it out is no gap. */
const meaningGap = (skipped: string | undefined, exact: boolean) =>
  skipped === undefined || exact
    ? { next: [], missing: [] }
    : {
        next: [nextStep("models.download", { args: { model: DEFAULT_TEXT_MODEL } })],
        missing: [{ field: "found_by", why: skipped, step: "models.download" }],
      }

/** `search notes`, CLI and MCP alike. */
export const notesAnswer = (
  command: string,
  found: NotesFoundOf,
  { limit, page, again }: Paging,
  exact = false,
): ListBody<NoteHitItem> =>
  listOf(command, {
    items: found.hits.map(noteHitItem),
    limit,
    has_more: found.hasMore && found.nextOffset !== undefined,
    page: page ?? 1,
    ...(again ? { args: again } : {}),
    ...meaningGap(found.meaningSkipped, exact),
    meta: metaOf(
      found.accounts,
      found.skipped.map(({ source, reason }) => ({ source, reason })),
    ),
  })

/** `search all`, CLI and MCP alike. A bounded meeting scan that could not tell whether more match says so. */
export const allAnswer = (
  command: string,
  found: SearchAllIncludingMeetingsFound,
  { limit, page, again }: Paging,
  exact = false,
): ListBody<HitItem> => {
  const scan = found.meetings?.complete === false ? found.meetings : undefined
  const notes = meaningGap(found.notes?.meaningSkipped, exact)
  return listOf(command, {
    items: found.items.map(allHitItem),
    limit,
    has_more: found.hasMore === true && found.nextOffset !== undefined,
    page: page ?? 1,
    ...(again ? { args: again } : {}),
    next: [
      ...(scan
        ? [
            nextStep("search.meetings", {
              command,
              args: { ...again, max_meetings: "all" },
              values: { scanned: scan.meetingsScanned },
            }),
          ]
        : []),
      ...notes.next,
    ],
    missing: [
      ...(scan
        ? [
            {
              field: "items",
              why: `stopped after ${scan.meetingsScanned} meetings; more may match`,
              step: "search.meetings",
            },
          ]
        : []),
      ...notes.missing,
    ],
    meta: metaOf(found.accounts, found.skipped),
  })
}
