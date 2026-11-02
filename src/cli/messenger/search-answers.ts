import type { ErrorCode } from "@wirecat/cli-base"
import type { Meta, Missing, NextStep } from "@wirecat/cli-base/standards"
import type { InferOutput } from "valibot"
import { hitFiles } from "../../domain/attachments.js"
import { formatLocator, parseLocator } from "../../domain/locator.js"
import { senderIsMe } from "../../domain/models.js"
import { DEFAULT_TEXT_MODEL } from "../../embeddings/models.js"
import type { ENTITIES } from "../../entities/index.js"
import type { SearchTotal } from "../../search/total.js"
import type { ChatCoverage } from "../../services/chat-coverage.js"
import { excerpt } from "../../services/excerpt.js"
import type { FoundMessage, SearchFound } from "../../services/messages.js"
import { MAX_SEARCH_OFFSET } from "../../services/messages-archive-search.js"
import type { MeaningSkipped } from "../../services/messages-discovery.js"
import type { FoundNote, NotesFoundOf } from "../../services/notes-search.js"
import type { SearchAllItem } from "../../services/search-all.js"
import type { MeetingSearchItem, SearchAllIncludingMeetingsFound } from "../../services/search-all-meetings.js"
import type { StoredHistorySkip } from "../../store/store.js"
import { type ListBody, listOf } from "../envelope.js"
import { nextStep } from "../steps.js"
import { archiveSummary } from "./archive-summary.js"
import { historyLimitGaps } from "./history-gaps.js"

/** What a source tool's `search all` reads: never mail, which is memo's (docs/dev/TOOL-BOUNDARIES.md). */
export const SOURCE_SEARCHED = ["messages", "notes", "events", "meetings"] as const
export type SourceSearched = (typeof SOURCE_SEARCHED)[number]

export type MessageHitItem = InferOutput<(typeof ENTITIES)["message.hit"]>
export type NoteHitItem = InferOutput<(typeof ENTITIES)["note.hit"]>
export type HitItem = InferOutput<(typeof ENTITIES)["hit"]>

const nonEmpty = <T>(list: T[]): T[] | undefined => (list.length > 0 ? list : undefined)

const defined = <T extends object>(value: T): T =>
  Object.fromEntries(Object.entries(value).filter(([, one]) => one !== undefined)) as T

/** The page a `--page` asks for, as the offset the search services take. */
export const offsetOf = (page: number | undefined, limit: number): number | undefined =>
  page === undefined || page <= 1 ? undefined : (page - 1) * limit

/** Who wrote it and what, the chat's title, the mail's headers: others write them; the owner's own messages too. */
const MESSAGE_HIT_UNTRUSTED = [
  "chat_title",
  "sender_name",
  "excerpt",
  "context.sender_name",
  "context.text",
  "follow_ups.chat_title",
  "follow_ups.sender_name",
  "follow_ups.excerpt",
  "attachments.name",
]
const MAIL_HIT_UNTRUSTED = [
  "email.subject",
  "email.from.name",
  "email.to.name",
  "email.cc.name",
  "email.bcc.name",
  "email.reply_addresses.name",
]

export const messageHitItem = (hit: FoundMessage, query = ""): MessageHitItem => {
  const at = parseLocator(hit.locator)
  const around = hit.thread?.items ?? hit.context
  return defined({
    ref: hit.locator,
    chat_title: hit.chatTitle ?? undefined,
    timestamp: hit.timestamp,
    sender_name: hit.senderName,
    sender_is_me: senderIsMe(hit, at.account),
    excerpt: hit.excerpt ?? excerpt(hit.text, query),
    matched_in: hit.matchedIn,
    score: hit.score ?? undefined,
    match: hit.match,
    corrections: hit.corrections,
    found_in: hit.source,
    discovery: hit.discovery
      ? defined({
          coverage: hit.discovery.coverage,
          matched_terms: hit.discovery.matchedTerms,
          missing_terms: hit.discovery.missingTerms,
          parent: hit.discovery.parent,
          found_by: hit.discovery.foundBy,
          reranker_score: hit.discovery.rerankerScore,
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
          sender_score: hit.email.senderScore,
        }
      : undefined,
    context: around?.map((one) => ({
      ref: formatLocator({ ...at, message: one.id }),
      timestamp: one.timestamp,
      sender_name: one.senderName,
      text: one.text,
    })),
    follow_ups: hit.followUps?.map((one) => ({
      ref: one.locator,
      chat_title: one.chatTitle ?? null,
      timestamp: one.timestamp,
      sender_name: one.senderName,
      excerpt: excerpt(one.text, query),
    })),
    attachments: nonEmpty(hitFiles(hit.attachments)),
    untrusted: hit.email ? [...MESSAGE_HIT_UNTRUSTED, ...MAIL_HIT_UNTRUSTED] : MESSAGE_HIT_UNTRUSTED,
  })
}

const accountName = ({ provider, account }: { provider: string; account: string }) => `${provider}:${account}`

/** A source left out is an issue by its code; the sentence saying why goes to a person as a note, never here. */
const metaOf = (
  accounts: readonly { provider: string; account: string }[],
  skipped: readonly { source?: string; resource?: string; code: ErrorCode }[] = [],
  heldInPart = false,
): Partial<Meta> => ({
  accounts: accounts.map(accountName),
  complete: skipped.length === 0 && !heldInPart,
  ...(skipped.length
    ? { issues: skipped.map(({ source, resource, code }) => ({ code, source: source ?? resource ?? "" })) }
    : {}),
})

const day = (at: string | null) => at?.slice(0, 10) ?? "no date"

/**
 * What the store holds of a chat that is not complete, in words. A chat that reaches its first message is only
 * behind or has gaps: saying "held from <date> only" would claim older history is missing.
 */
export const heldPhrase = ({ completeness, held }: Pick<ChatCoverage, "completeness" | "held">): string => {
  if (completeness.state === "unknown" || !held.oldestAt) return "never fetched"
  if (!completeness.reachesStart) return `held from ${day(held.oldestAt)} only`
  if (completeness.gaps) return "held from its first message, with gaps"
  return `held from its first message, behind since ${day(held.newestAt)}`
}

/**
 * The steps for chats the store holds only in part. Bounded first, when the answer's window is known, then the whole
 * chat; both name the first chat only, because a download is the owner's call. Counts and dates only, never text.
 */
const chatGaps = (rows: ChatCoverage[], since?: string): { next: NextStep[]; missing: Missing[] } => {
  const open = rows.filter(({ completeness }) => completeness.state !== "complete")
  const [first] = open
  if (!first) return { next: [], missing: [] }
  const held = heldPhrase(first)
  const steps = (args: Record<string, string>, why: string): NextStep => ({
    ...nextStep("messages.sync", { args: { chat: first.chatId, ...args } }),
    why,
  })
  return {
    next: [
      ...(since === undefined ? [] : [steps({ since_time: since }, `${held}; this reads back to ${day(since)}`)]),
      steps({}, "reads the chat back to its first message; a big group can take minutes"),
    ],
    missing: [
      {
        field: "history",
        why: `${open.length} of ${rows.length} chats hold only part of their history; the first is ${held}`,
        step: "messages.sync",
      },
    ],
  }
}

/**
 * What the archive lacked for this answer, and the step that would fill it. From a search's coverage, or from the
 * chats an answer is about (`since` is the start of the window it was asked for).
 */
export const coverageGaps = (
  found: Pick<SearchFound, "coverage" | "refreshed"> | ChatCoverage[],
  shown = 0,
  since?: string,
): { next: NextStep[]; missing: Missing[] } => {
  if (Array.isArray(found)) return chatGaps(found, since)
  const coverage = found.coverage
  const stale = found.refreshed?.complete === false
  if (!coverage?.next && !stale) return { next: [], missing: [] }
  const chat = coverage?.chat ?? coverage?.attention[0]?.chatId
  return {
    next: chat === undefined ? [] : [nextStep("messages.sync", { args: { chat } })],
    missing: [
      {
        field: "coverage",
        why: stale
          ? "the fetch before searching stopped early, so the answer may be stale"
          : ((coverage && archiveSummary(coverage, shown)) ?? "the local copy may be missing messages"),
        step: "messages.sync",
      },
    ],
  }
}

/** Messages searched by words only, and the step that would add meaning: `--discover` and `search all` alike. */
const messageMeaningGap = (meaning: MeaningSkipped | undefined, field: string) => {
  const next: NextStep[] = []
  if (!meaning) return { next, missing: [] }
  if (meaning.step === "models.download") next.push(nextStep("models.download", { args: { model: meaning.model } }))
  if (meaning.step === "conversations.rebuild") next.push(nextStep("conversations.rebuild", { args: {} }))
  return {
    next,
    missing: [
      { field, why: `searched by words only: ${meaning.reason}`, ...(meaning.step ? { step: meaning.step } : {}) },
    ],
  }
}

/** The pretty note for messages searched by words only, with the command that would add meaning. */
export const meaningNote = (meaning: MeaningSkipped, command: string): string => {
  const step =
    meaning.step === "models.download"
      ? ` — \`${command} models download ${meaning.model}\`, then \`${command} conversations rebuild\` gives messages their vectors`
      : meaning.step === "conversations.rebuild"
        ? ` — \`${command} conversations rebuild\` gives messages their vectors, a batch a run`
        : ""
  return `meaning search not used: ${meaning.reason}${step}`
}

const gapsOf = (found: SearchFound): { next: NextStep[]; missing: Missing[] } => {
  const { next, missing } = coverageGaps(found, found.items.length)
  const building =
    !found.wordsReady || (found.query?.stemming?.applied === false && found.query.stemming.reason === "building")
  if (building) {
    next.push(nextStep("store.migrate", { args: {} }))
    missing.push({
      field: "text",
      why: found.wordsReady
        ? "other forms of words are not searched while their index is built"
        : "the word index is still being built",
      step: "store.migrate",
    })
  }
  const meaning = messageMeaningGap(found.meaningSkipped, "discovery")
  for (const step of meaning.next) next.push(step)
  for (const gap of meaning.missing) missing.push(gap)
  const rerank = found.rerankSkipped
  if (rerank) {
    if (rerank.step === "models.download") next.push(nextStep("models.download", { args: { model: rerank.model } }))
    missing.push({
      field: "discovery",
      why: `not reranked: ${rerank.reason}`,
      ...(rerank.step ? { step: rerank.step } : {}),
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
    .map(({ locator, timestamp, senderName, senderIsMe, score }) => ({
      ref: locator,
      timestamp,
      sender_name: senderName,
      sender_is_me: senderIsMe,
      matched_in: "picture",
      score,
      untrusted: ["sender_name"],
    }))
}

export interface Paging {
  limit: number
  page?: number
  /** The query and options `page.next` repeats. */
  again?: Record<string, unknown>
}

/** "showing 20 of 144", for the human view under a page of hits; `+` when the total is a lower bound. */
export const shownOf = (shown: number, offset: number, total: SearchTotal | undefined): string | undefined =>
  total === undefined || shown === 0
    ? undefined
    : `showing ${offset + 1}–${offset + shown} of ${total.value}${total.relation === "gte" ? "+" : ""}`

/** `search messages` and `search mail`, CLI and MCP alike. */
export const messagesAnswer = (
  command: string,
  found: SearchFound,
  { limit, page, again }: Paging,
  query = "",
  skips: StoredHistorySkip[] = [],
): ListBody<MessageHitItem> => {
  const accounts = found.coverage?.accounts ?? found.accounts ?? []
  const gaps = gapsOf(found)
  const limited = historyLimitGaps(skips)
  return listOf(command, {
    items: [...found.items.map((hit) => messageHitItem(hit, query)), ...pictureItems(found)],
    limit,
    has_more: found.hasMore && (page ?? 1) * limit <= MAX_SEARCH_OFFSET,
    page: page ?? 1,
    ...(found.total ? { total: found.total } : {}),
    ...(again ? { args: again } : {}),
    next: [...gaps.next, ...limited.next],
    missing: [...gaps.missing, ...limited.missing],
    meta: metaOf(accounts, found.skipped, coverageGaps(found).missing.length > 0 || skips.length > 0),
  })
}

/**
 * A document comes from a shared drive, where others write and edit; a note is the owner's own, in a folder of
 * theirs or written in memo, so it is left unmarked.
 */
const DOCUMENT_HIT_UNTRUSTED = ["title", "excerpt"]

export const noteHitItem = (hit: FoundNote): NoteHitItem =>
  defined({ ...hit, untrusted: hit.kind === "document" ? DOCUMENT_HIT_UNTRUSTED : undefined })

/** The text of each kind of `search all` hit that someone other than the owner may have written. */
const ALL_HIT_UNTRUSTED: Record<HitItem["kind"], string[] | undefined> = {
  message: ["title", "excerpt", "sender_name", "attachments.name"],
  mail: ["title", "excerpt", "sender_name", "attachments.name"],
  document: DOCUMENT_HIT_UNTRUSTED,
  note: undefined,
  event: ["title", "excerpt"],
  meeting: ["title", "excerpt", "sender_name"],
}

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
        scope: item.scope,
        id: String(item.id),
        ...(item.cueRef === undefined ? {} : { cue_ref: item.cueRef, sender_name: item.speakerName ?? null }),
        untrusted: ALL_HIT_UNTRUSTED.meeting,
      }
    : defined({
        kind: item.kind,
        ref: item.ref,
        provider: item.provider,
        account: item.account,
        title: item.title,
        timestamp: item.timestamp,
        url: item.url,
        excerpt: item.text,
        sender_name: item.from?.name,
        sender_is_me: item.senderIsMe,
        sender_ref: item.from?.ref,
        found_by: item.foundBy,
        attachments: item.attachments === undefined ? undefined : nonEmpty(item.attachments),
        untrusted: ALL_HIT_UNTRUSTED[item.kind],
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
    has_more: found.has_more && found.next_offset !== undefined,
    page: page ?? 1,
    total: found.total,
    ...(again ? { args: again } : {}),
    ...meaningGap(found.meaning_skipped, exact),
    meta: metaOf(found.accounts, found.skipped),
  })

/** `search all`, CLI and MCP alike. A bounded meeting scan that could not tell whether more match says so. */
export const allAnswer = (
  command: string,
  found: SearchAllIncludingMeetingsFound,
  { limit, page, again }: Paging,
  exact = false,
  skips: StoredHistorySkip[] = [],
): ListBody<HitItem> => {
  const limited = historyLimitGaps(skips)
  const scan = found.meetings?.complete === false ? found.meetings : undefined
  const notes = meaningGap(found.notes?.meaningSkipped, exact)
  const messages = messageMeaningGap(found.messages?.meaningSkipped, "found_by")
  const archive = coverageGaps({ coverage: found.coverage }, found.items.length)
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
      ...messages.next.filter((step) => !notes.next.some((asked) => JSON.stringify(asked) === JSON.stringify(step))),
      ...archive.next,
      ...limited.next,
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
      ...messages.missing,
      ...archive.missing,
      ...limited.missing,
    ],
    meta: metaOf(found.accounts, found.skipped, archive.missing.length > 0 || skips.length > 0),
  })
}
