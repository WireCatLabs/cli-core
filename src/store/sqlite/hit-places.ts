import type { ResolvedPredicate } from "../../search/lucene/resolved.js"
import type { CacheDatabase } from "../driver.js"
import { normalize } from "../normalize.js"
import { type Corpus, ftsMatch, type Leaf, SPEECH } from "./lucene-fields.js"
import type { hitsByPk } from "./search.js"
import { spokenTranscripts, type TranscriptTerms } from "./transcript-query.js"
import type { MatchPlace } from "./words.js"

type Hits = ReturnType<typeof hitsByPk>

/**
 * Which place of each hit holds the words, first match wins in the order of `MatchPlace`; a hit its transcript
 * holds only through a spelling speech recognition garbled is `corrected`.
 */
export const placeHits = (
  database: CacheDatabase,
  corpus: Corpus,
  leaves: Leaf[],
  transcripts: Map<ResolvedPredicate, TranscriptTerms>,
  found: Hits,
  pks: number[],
): Hits => {
  const placeLeaves = leaves.filter(
    ({ node }) =>
      (node.operator === "term" || node.operator === "phrase") &&
      (node.implicit || node.field === "content" || node.field === "transcript"),
  )
  if (!placeLeaves.length || !pks.length || found.length !== pks.length) return found
  const keys = JSON.stringify(pks)
  const wordy = placeLeaves.filter(({ node }) => /[\p{L}\p{N}]/u.test(normalize(node.value)))
  if (!wordy.length) return found
  const match = wordy.map(({ node }) => ftsMatch(node)).join(" OR ")
  const implicit = placeLeaves.some(({ node }) => node.implicit)
  const inText = new Set(
    implicit
      ? database
          .prepare(
            `SELECT rowid AS id FROM ${corpus.words} WHERE ${corpus.words} MATCH ? AND rowid IN (SELECT value FROM json_each(?))${
              placeLeaves.some(({ fragment }) => fragment.stems)
                ? ` UNION SELECT rowid FROM ${corpus.stems} WHERE ${corpus.stems} MATCH ? AND rowid IN (SELECT value FROM json_each(?))`
                : ""
            }`,
          )
          .all(
            `normalized_text : (${match})`,
            keys,
            ...(placeLeaves.some(({ fragment }) => fragment.stems)
              ? [
                  `stems : (${placeLeaves.flatMap(({ fragment }) => (fragment.stems ? [`(${fragment.stems})`] : [])).join(" OR ")})`,
                  keys,
                ]
              : []),
          )
          .map(({ id }) => Number(id))
      : [],
  )
  const files = database
    .prepare(
      `SELECT att.attachable_id AS id, att.text AS text, ${SPEECH} AS speech FROM attachments att WHERE att.attachable_type='${corpus.item}' AND att.attachable_id IN (SELECT value FROM json_each(?)) AND att.id IN (SELECT rowid FROM attachment_words WHERE attachment_words MATCH ?) ORDER BY att.position`,
    )
    .all(keys, match)
  const fileFields = new Set(
    placeLeaves.flatMap(({ node }) => (node.implicit ? ["transcript", "content"] : [node.field])),
  )
  const spoken = spokenTranscripts(
    database,
    corpus.item,
    wordy.flatMap(({ node }) => transcripts.get(node) ?? []),
    keys,
  )
  const allNames = implicit
    ? database
        .prepare(
          `SELECT att.attachable_id AS id, att.name AS name FROM attachments att WHERE att.attachable_type='${corpus.item}' AND att.attachable_id IN (SELECT value FROM json_each(?)) AND att.name IS NOT NULL ORDER BY att.position`,
        )
        .all(keys)
    : []
  return found.map((hit, index) => {
    const pk = pks[index] as number
    const transcript = spoken.get(pk)
    const file = files.find((row) => Number(row.id) === pk && Number(row.speech) !== 1)
    const name = allNames.find((row) => {
      if (Number(row.id) !== pk) return false
      const words = normalize(String(row.name)).split(/[^\p{L}\p{N}]+/u)
      return wordy.some(({ node }) => {
        const phrase = normalize(node.value).match(/[\p{L}\p{N}]+/gu) ?? []
        if (node.slop !== undefined) return phrase.every((word) => words.includes(word))
        return words.some((_, at) => phrase.every((word, offset) => words[at + offset] === word))
      })
    })
    const place: [MatchPlace, string] | undefined = inText.has(pk)
      ? ["text", hit.text]
      : transcript && fileFields.has("transcript")
        ? ["transcript", String(transcript.text)]
        : name
          ? ["filename", String(name.name)]
          : file && fileFields.has("content")
            ? ["file", String(file.text)]
            : undefined
    if (!place) return hit
    const fixes = place[0] === "transcript" ? (transcript?.corrections ?? []) : []
    return {
      ...hit,
      matchedIn: place[0],
      matchedText: place[1],
      ...(fixes.length ? { match: "corrected" as const, corrections: fixes } : {}),
    }
  })
}
