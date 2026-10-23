import { createHash } from "node:crypto"
import { CliError } from "@wirecat/cli-base"
import { meaningFloor } from "../embeddings/models.js"
import {
  formatMeetingReference,
  liftMeetingFields,
  type MeetingHitSearchRequest,
  parseMeetingReference,
  type SearchHit,
} from "../meetings/index.js"
import { questionTerms } from "../search/question-plan.js"
import type { MessageStore } from "../store/store.js"
import { refreshMeetingIndex, resolveMeetingSelection } from "./meeting-hit-search.js"
import type { MeetingEmbedder } from "./meeting-model.js"
import { validateVector } from "./meeting-semantic.js"
import { RRF_K } from "./notes-search.js"

/** How many hits each side ranks before they are merged; a page past it has nothing more to show. */
const DEPTH = 200

export interface MeetingCombinedRequest extends MeetingHitSearchRequest {
  /** Most stored passage vectors to compare, 1 through 100000 (default 10000). */
  maxChunks?: number
  maxRows?: number
  maxTextBytes?: number
}

type WordHit = SearchHit & { ref: string }

export interface MeetingCombinedHit {
  /** A transcript line to cite: the best word hit in the passage, else the passage's first line. */
  ref: string
  meetingId: number
  scope: SearchHit["scope"]
  text: string
  startMs: number | null
  source: { title: string | null; startedAt: number | null; url: string | null }
  /** Which searches found it: `words`, `meaning` or both. */
  by: ("words" | "meaning")[]
  /** Similarity in meaning, when the meaning search found it. */
  score: number | null
  /** The passage the meaning search matched, as its first and last line. */
  passage?: { first: string; last: string }
  match?: SearchHit["match"]
  corrections?: SearchHit["corrections"]
}

interface Cursor {
  version: 1
  key: string
  offset: number
}
const cursorOf = (value: string | undefined, key: string): number => {
  if (value === undefined) return 0
  let cursor: Cursor
  try {
    cursor = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Cursor
  } catch {
    throw new CliError("validation_error", "the cursor is not from a combined meeting search; search again")
  }
  if (cursor?.version !== 1 || cursor.key !== key || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0)
    throw new CliError("validation_error", "the cursor belongs to another query, filter or model; search again")
  return cursor.offset
}

/**
 * Words and meaning, ranked together by reciprocal rank fusion over one selection of meetings. A question
 * («что решили по цене?») searches its content words; other text is the meeting query language. A word hit inside
 * a passage the meaning search found joins it, so one discussion found both ways ranks first.
 */
export const searchMeetingsCombined = async (
  store: Pick<MessageStore, "meetings" | "meetingVectors"> & { knowledge?: MessageStore["knowledge"] },
  embedder: MeetingEmbedder,
  typed: string,
  request: MeetingCombinedRequest,
) => {
  const { maxChunks, maxRows, maxTextBytes, ...chosen } = request
  const { query, request: words } = liftMeetingFields(typed, chosen)
  const { input, selection } = await resolveMeetingSelection(store, words)
  const { after, limit = 20, maxReadBytes, ...filters } = input
  const terms = questionTerms(query)
  const wordQuery = terms === null ? query : terms.join(" ")
  const key = createHash("sha256")
    .update(JSON.stringify([query, embedder.key, Object.entries(filters).filter(([name]) => name !== "signal")]))
    .digest("base64url")
  const offset = cursorOf(after, key)

  let byWords: WordHit[] = []
  let indexing: "ready" | "pending" = "ready"
  let refused: string | undefined
  if (wordQuery.trim()) {
    await refreshMeetingIndex(store.meetings, input.accountId, input.signal)
    try {
      const page = await store.meetings.searchHits(wordQuery, { ...filters, limit: DEPTH, maxReadBytes })
      byWords = page.items
      indexing = page.coverage.indexing
    } catch (error) {
      // Text the query language refuses is still a question to ask by meaning.
      if (!(error instanceof CliError) || error.code !== "validation_error") throw error
      refused = error.message
    }
  }

  input.signal?.throwIfAborted()
  const vectors = await embedder.embed([query], "query")
  if (vectors.length !== 1) throw new CliError("invalid_response", "Meeting query model returned another vector count")
  const vector = vectors[0]
  const ranked = await store.meetingVectors.ranked(embedder.key, validateVector(vector, embedder.dims), {
    ...filters,
    limit: DEPTH,
    ...(maxChunks === undefined ? {} : { maxChunks }),
    ...(maxRows === undefined ? {} : { maxRows }),
    ...(maxTextBytes === undefined ? {} : { maxTextBytes }),
  })
  const floor = meaningFloor(embedder.key)
  const byMeaning = ranked.items.filter(({ score }) => score > floor)

  const merged = new Map<string, MeetingCombinedHit & { fused: number }>()
  byMeaning.forEach((hit, rank) => {
    const reference = { type: "meeting" as const, accountId: input.accountId, meetingId: hit.meetingId }
    const first = formatMeetingReference({
      ...reference,
      transcriptId: hit.transcriptId,
      cuePosition: hit.firstPosition,
    })
    merged.set(`${hit.transcriptId}:${hit.firstPosition}`, {
      ref: first,
      meetingId: hit.meetingId,
      scope: "transcript",
      text: hit.text,
      startMs: null,
      source: { title: hit.title, startedAt: hit.startedAt, url: null },
      by: ["meaning"],
      score: hit.score,
      passage: {
        first,
        last: formatMeetingReference({ ...reference, transcriptId: hit.transcriptId, cuePosition: hit.lastPosition }),
      },
      fused: 1 / (RRF_K + rank + 1),
    })
  })
  byWords.forEach((hit, rank) => {
    const share = 1 / (RRF_K + rank + 1)
    const cue = hit.scope === "transcript" ? parseMeetingReference(hit.ref) : undefined
    const within =
      cue?.cuePosition === undefined
        ? undefined
        : byMeaning.find(
            (passage) =>
              passage.transcriptId === cue.transcriptId &&
              passage.firstPosition <= (cue.cuePosition as number) &&
              (cue.cuePosition as number) <= passage.lastPosition,
          )
    const held = within && merged.get(`${within.transcriptId}:${within.firstPosition}`)
    const found = {
      ref: hit.ref,
      text: hit.text,
      startMs: hit.startMs,
      ...(hit.match === undefined ? {} : { match: hit.match }),
      ...(hit.corrections === undefined ? {} : { corrections: hit.corrections }),
    }
    if (held && !held.by.includes("words")) {
      Object.assign(held, found, { by: ["words", "meaning"], fused: held.fused + share })
      if (hit.source?.url) held.source.url = hit.source.url
    } else if (held) held.fused += share
    else
      merged.set(`w:${hit.ref}:${hit.scope}:${hit.id}`, {
        ...found,
        meetingId: hit.meetingId,
        scope: hit.scope,
        source: {
          title: hit.source?.title ?? null,
          startedAt: hit.source?.startedAt ?? null,
          url: hit.source?.url ?? null,
        },
        by: ["words"],
        score: null,
        fused: share,
      })
  })
  // On a tie a line that has the words outranks a passage that only resembles the query.
  const ordered = [...merged.values()].sort(
    (a, b) =>
      b.fused - a.fused ||
      Number(b.by.includes("words")) - Number(a.by.includes("words")) ||
      (b.score ?? -2) - (a.score ?? -2),
  )
  const items = ordered.slice(offset, offset + limit).map(({ fused: _, ...hit }) => hit)
  const hasMore = ordered.length > offset + limit
  return {
    items,
    hasMore,
    nextCursor: hasMore
      ? Buffer.from(JSON.stringify({ version: 1, key, offset: offset + limit } satisfies Cursor)).toString("base64url")
      : null,
    selection,
    words: {
      query: wordQuery,
      ...(terms === null ? {} : { from: "question" as const }),
      ...(refused === undefined ? {} : { refused }),
    },
    model: { key: embedder.key, model: embedder.model, kind: embedder.kind, dims: embedder.dims },
    coverage: {
      archiveCompleteness: "unknown" as const,
      indexCompleteness: "unknown" as const,
      indexing,
      /** Every vector of the selection was compared; false when `maxChunks` stopped the scan. */
      meaningScanComplete: ranked.complete,
      scanned: ranked.scanned,
      /** Each side ranks this many at most; pages past them hold nothing more. */
      depth: DEPTH,
    },
  }
}
