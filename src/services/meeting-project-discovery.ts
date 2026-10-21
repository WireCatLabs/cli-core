import { createHash } from "node:crypto"
import { CliError } from "@wirecat/cli-base"
import { normalizeVocabularyName } from "../domain/vocabulary.js"
import {
  canonicalMeetingReference,
  type MeetingProjectDiscoveryOptions,
  type MeetingProjectDiscoveryPage,
  type MeetingSearchStore,
  meetingWordsQuery,
  parseMeetingReference,
  type SearchHit,
  validateMeetingHitSearch,
} from "../meetings/index.js"
import type { VocabularyStore } from "../store/index.js"

interface Cursor {
  version: 1
  key: string
  term: number
  after: string | null
}
const scopeKeys = [
  "accountId",
  "meetingId",
  "participantIdentityId",
  "personId",
  "tagId",
  "eventId",
  "meetingSeriesId",
  "since",
  "until",
] as const
const optionKeys = new Set<string>([
  ...scopeKeys,
  "limit",
  "maxReadBytes",
  "signal",
  "cursor",
  "maxTerms",
  "maxVocabularyReadBytes",
])
const fail = (message: string): never => {
  throw new CliError("validation_error", message)
}
const cursorOf = (text: string | undefined, key: string, terms: number): Cursor | null => {
  if (text === undefined) return null
  if (typeof text !== "string" || !/^[A-Za-z0-9_-]{1,4096}$/.test(text)) return fail("invalid project discovery cursor")
  let value: Cursor
  try {
    value = JSON.parse(Buffer.from(text, "base64url").toString("utf8")) as Cursor
  } catch {
    return fail("invalid project discovery cursor")
  }
  if (
    value?.version !== 1 ||
    value.key !== key ||
    !Number.isSafeInteger(value.term) ||
    value.term < 0 ||
    value.term >= terms ||
    (value.after !== null && (typeof value.after !== "string" || !/^[A-Za-z0-9_-]{1,1000}$/.test(value.after)))
  )
    return fail("project discovery cursor does not match the project vocabulary, query and selected account")
  return { version: 1, key, term: value.term, after: value.after }
}
const cited = (hit: SearchHit, accountId: number): SearchHit & { ref: string } => {
  try {
    if (typeof hit.ref !== "string" || canonicalMeetingReference(hit.ref) !== hit.ref) throw Error()
    const ref = parseMeetingReference(hit.ref)
    if (
      ref.accountId !== accountId ||
      ref.meetingId !== hit.meetingId ||
      (hit.scope === "transcript" && ref.cuePosition === undefined)
    )
      throw Error()
    return { ...hit, ref: hit.ref }
  } catch {
    throw new CliError("invalid_response", "project discovery requires cited hits from the selected account")
  }
}

/** One alias read per call keeps the transcript byte budget independent of the number of names. */
export const readMeetingProjectDiscovery = async (
  ports: { vocabulary: Pick<VocabularyStore, "resolveVocabulary">; search: MeetingSearchStore },
  projectName: string,
  original: MeetingProjectDiscoveryOptions,
): Promise<MeetingProjectDiscoveryPage> => {
  if (
    !original ||
    typeof original !== "object" ||
    Array.isArray(original) ||
    Object.keys(original).some((key) => !optionKeys.has(key))
  )
    return fail("invalid project discovery options; confirmed project filters and source cursors do not apply")
  const { cursor, maxTerms = 32, maxVocabularyReadBytes = 1024 ** 2, ...input } = { ...original }
  input.limit ??= 100
  input.maxReadBytes ??= 4 * 1024 ** 2
  input.signal?.throwIfAborted()
  const query = normalizeVocabularyName(projectName)
  validateMeetingHitSearch(projectName, input)
  if (
    !Number.isSafeInteger(input.accountId) ||
    input.accountId < 1 ||
    !Number.isSafeInteger(maxTerms) ||
    maxTerms < 1 ||
    maxTerms > 128 ||
    !Number.isSafeInteger(maxVocabularyReadBytes) ||
    maxVocabularyReadBytes < 1 ||
    maxVocabularyReadBytes > 64 * 1024 ** 2
  )
    return fail("invalid project discovery account or vocabulary limits")
  if (typeof ports?.vocabulary?.resolveVocabulary !== "function" || typeof ports?.search?.searchHits !== "function")
    throw new CliError("configuration_error", "project discovery needs vocabulary resolution and bounded word search")
  const found = await ports.vocabulary.resolveVocabulary(projectName, {
    kind: "project",
    maxEntries: 10000,
    maxReadBytes: maxVocabularyReadBytes,
    signal: input.signal,
  })
  input.signal?.throwIfAborted()
  if (found.ambiguous || found.matches.length !== 1)
    throw new CliError(
      found.matches.length ? "validation_error" : "not_found",
      "project discovery needs one canonical project",
      {
        candidates: found.matches.map((entry) => ({ kind: entry.kind, id: entry.id, name: entry.name })),
      },
    )
  const entry = found.matches[0]
  if (
    entry?.kind !== "project" ||
    typeof entry.id !== "string" ||
    !entry.id ||
    entry.id.length > 200 ||
    typeof found.fingerprint !== "string" ||
    !found.fingerprint ||
    found.fingerprint.length > 256 ||
    !Array.isArray(entry.aliases)
  )
    throw new CliError("invalid_response", "project vocabulary returned an invalid canonical record")
  if (entry.aliases.length > 128) return fail("project vocabulary exceeds the supported alias budget")
  const project = { id: entry.id, name: entry.name, key: entry.key }
  const terms: MeetingProjectDiscoveryPage["term"][] = []
  const seen = new Set<string>()
  const add = (term: MeetingProjectDiscoveryPage["term"]) => {
    const normalized = normalizeVocabularyName(term.name)
    if (seen.has(normalized) || !/[\p{L}\p{N}]/u.test(normalized)) return
    seen.add(normalized)
    terms.push({ ...term, name: term.name.trim() })
  }
  add({ name: project.name, kind: "canonical" })
  if (project.key !== null) add({ name: project.key, kind: "key" })
  const aliases = entry.aliases
    .map((alias) => ({ ...alias, normalized: normalizeVocabularyName(alias.name) }))
    .sort((a, b) =>
      a.normalized < b.normalized ? -1 : a.normalized > b.normalized ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
    )
  for (const alias of aliases) add({ name: alias.name, kind: "alias", aliasId: alias.id })
  if (!terms.length || terms.length > maxTerms)
    return fail("project discovery names exceed the selected term budget or contain no words")
  const key = createHash("sha256")
    .update(JSON.stringify([query, found.fingerprint, project, terms, scopeKeys.map((name) => input[name] ?? null)]))
    .digest("hex")
  const previous = cursorOf(cursor, key, terms.length)
  const termIndex = previous?.term ?? 0
  const term = terms[termIndex] as MeetingProjectDiscoveryPage["term"]
  const result = await ports.search.searchHits(meetingWordsQuery(term.name), {
    ...input,
    ...(previous?.after ? { after: previous.after } : {}),
  })
  input.signal?.throwIfAborted()
  if (
    !Array.isArray(result.items) ||
    result.items.length > (input.limit ?? 100) ||
    result.hasMore !== (result.nextCursor !== null) ||
    (result.nextCursor !== null &&
      (typeof result.nextCursor !== "string" || !/^[A-Za-z0-9_-]{1,1000}$/.test(result.nextCursor))) ||
    result.coverage?.archiveCompleteness !== "unknown" ||
    result.coverage.currentRevisions !== true ||
    result.coverage.indexCompleteness !== "unknown" ||
    !["ready", "pending"].includes(result.coverage.indexing)
  )
    throw new CliError("invalid_response", "project word search returned an invalid bounded page")
  const nextTerm = result.hasMore ? termIndex : termIndex + 1
  const hasMore = nextTerm < terms.length
  return {
    schemaVersion: 1,
    kind: "meeting_project_discovery",
    accountId: input.accountId,
    query: projectName.trim(),
    limits: { limit: input.limit, maxReadBytes: input.maxReadBytes, maxVocabularyReadBytes, maxTerms },
    project,
    term,
    hits: result.items.map((hit) => cited(hit, input.accountId)),
    association: "unconfirmed-word-evidence",
    vocabularyFingerprint: found.fingerprint,
    hasMore,
    nextCursor: hasMore
      ? Buffer.from(JSON.stringify({ version: 1, key, term: nextTerm, after: result.nextCursor })).toString("base64url")
      : null,
    coverage: {
      ...result.coverage,
      termIndex,
      termsTotal: terms.length,
      remainingTerms: terms.length - termIndex - 1,
      duplicates: "may-repeat-between-terms",
    },
  }
}
