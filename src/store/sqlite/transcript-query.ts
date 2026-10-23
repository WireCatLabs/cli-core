import { dictionaryLanguages, knownWord } from "../../search/dictionary.js"
import { isNumberWord, widenWords } from "../../search/garbled.js"
import type { ResolvedNode, ResolvedPredicate } from "../../search/lucene/resolved.js"
import { createStemmer, DEFAULT_STEMMERS, STEM_SEPARATOR } from "../../search/stem.js"
import type { CacheDatabase, SqlValue } from "../driver.js"
import { normalize } from "../normalize.js"
import { ftsMatch, quoted, SPEECH, stemMatch } from "./lucene-fields.js"
import { savedStemmers } from "./stems.js"

/** How one leaf reaches voice-note transcripts: its typed form, other forms by stem, and garbled spellings. */
export interface TranscriptTerms {
  /** The leaf's words as typed, matched in `attachment_words`. */
  match: string
  /** Any form of them, matched in `transcript_stems`; none under `exact:`. */
  stems?: string
  /** Stored spellings speech recognition may have made of a single word; matched in `attachment_words`. */
  widened: string[]
  from: string
}

const predicates = (node: ResolvedNode): ResolvedPredicate[] =>
  node.kind === "predicate" ? [node] : node.clauses.flatMap(({ node }) => predicates(node))

/** A bare word and `transcript:` read transcripts; `text:` is only what was written. */
const readsTranscripts = (node: ResolvedPredicate): boolean =>
  (node.operator === "term" || node.operator === "phrase") &&
  /[\p{L}\p{N}]/u.test(normalize(node.value)) &&
  (node.field === "transcript" || (node.implicit === true && (node.field === "text" || node.field === "exact")))

/** `isNumberWord` knows Russian numbers only; a widened number is a wrong fact in any language. */
const LATIN_NUMBERS = new Set(
  `zero one two three four five six seven eight nine ten eleven twelve twenty thirty forty fifty sixty seventy
  eighty ninety hundred thousand million billion first second third fourth fifth sixth seventh eighth ninth tenth
  half quarter cero uno una dos tres cuatro cinco seis siete ocho nueve diez once doce veinte treinta cuarenta
  cincuenta sesenta setenta ochenta noventa cien ciento mil millon primero segundo tercero cuarto quinto medio`.split(
    /\s+/,
  ),
)

/** A word widens when its alphabet has a dictionary to tell a garbled spelling from another real word. */
const widens = (word: string, covered: (word: string) => boolean): boolean =>
  covered(word) && !isNumberWord(word) && !LATIN_NUMBERS.has(word)

/**
 * Each leaf that reads transcripts, with what it matches there. A transcript always widens, not only when nothing
 * matched as typed text does: a correct and a garbled spelling sit in one chat. Only a single word widens —
 * FTS5 `NEAR` and phrases take no alternatives — and never under `exact:`, as meetings do.
 */
export const transcriptTerms = (
  database: CacheDatabase,
  root: ResolvedNode,
  item: string,
): Map<ResolvedPredicate, TranscriptTerms> => {
  const leaves = predicates(root).filter(readsTranscripts)
  const terms = new Map(leaves.map((node) => [node, { match: ftsMatch(node), widened: [], from: node.value }]))
  const saved = savedStemmers(database)
  if (item !== "message" || !leaves.length || saved === null) return terms
  const stemmers = saved ?? DEFAULT_STEMMERS
  const stemmer = createStemmer(stemmers)
  const dictionary = knownWord(dictionaryLanguages(stemmers))
  const stemsOf = (word: string) => [...new Set(stemmer.explain(word).map((part) => part.stem))]
  const widening: { node: ResolvedPredicate; literal: string; stems: string[] }[] = []
  for (const [node, one] of terms) {
    if (node.field === "exact") continue
    const stems = stemMatch(stemmer, node)
    // `NEAR` over the stems can bridge the separator between a text's Latin readings; those rows are left out.
    if (stems)
      Object.assign(one, { stems: node.slop === undefined ? stems : `(${stems}) NOT ${quoted(STEM_SEPARATOR)}` })
    const words = normalize(node.value).match(/[\p{L}\p{N}]+/gu) ?? []
    const [word] = words
    if (node.operator === "term" && word !== undefined && words.length === 1 && widens(word, dictionary.covers))
      widening.push({ node, literal: word, stems: stemsOf(node.value) })
  }
  if (!widening.length) return terms
  const vocabulary = database
    .prepare("SELECT term, doc FROM transcript_words_vocab WHERE col = 'normalized_text'")
    .all()
    .map((row) => ({ term: String(row.term), docs: Number(row.doc) }))
  widenWords(widening, vocabulary, stemsOf, dictionary.known).forEach((words, at) => {
    const leaf = widening[at]
    if (leaf) Object.assign(terms.get(leaf.node) as TranscriptTerms, { widened: words })
  })
  return terms
}

export type TranscriptPart = "all" | "typed" | "forms" | "widened"

/** The attachment ids a leaf's transcripts match, as a condition on `att.id`; `part` keeps one of them. */
export const transcriptCondition = (
  terms: TranscriptTerms,
  part: TranscriptPart = "all",
): { sql: string; params: SqlValue[] } => {
  const parts: { sql: string; params: SqlValue[] }[] = []
  const words = (match: string) => ({
    sql: "att.id IN (SELECT rowid FROM attachment_words WHERE attachment_words MATCH ?)",
    params: [match],
  })
  if (part === "all" || part === "typed") parts.push(words(terms.match))
  if ((part === "all" || part === "forms") && terms.stems)
    parts.push({
      sql: "att.id IN (SELECT rowid FROM transcript_stems WHERE transcript_stems MATCH ?)",
      params: [`stems : (${terms.stems})`],
    })
  if ((part === "all" || part === "widened") && terms.widened.length)
    parts.push(words(terms.widened.map(quoted).join(" OR ")))
  return parts.length
    ? { sql: `(${parts.map(({ sql }) => sql).join(" OR ")})`, params: parts.flatMap(({ params }) => params) }
    : { sql: "0", params: [] }
}

/** The items whose transcripts a leaf matches. */
export const transcriptItems = (item: string, terms: TranscriptTerms, part?: TranscriptPart) => {
  const condition = transcriptCondition(terms, part)
  return {
    sql: `SELECT att.attachable_id FROM attachments att WHERE att.attachable_type='${item}' AND ${SPEECH} AND ${condition.sql}`,
    params: condition.params,
  }
}

/**
 * Of the items `keys` names, the transcript the leaves match — one they match as typed or in another form first —
 * and, when only a spelling recognition garbled matched it, which: as meetings say it.
 */
export const spokenTranscripts = (
  database: CacheDatabase,
  item: string,
  speaking: TranscriptTerms[],
  keys: string,
): Map<number, { text: string; corrections: { from: string; to: string[] }[] }> => {
  const any = speaking.map((terms) => transcriptCondition(terms))
  if (!any.length) return new Map()
  const plain = speaking
    .flatMap((terms) => [transcriptCondition(terms, "typed"), transcriptCondition(terms, "forms")])
    .filter(({ sql }) => sql !== "0")
  const rows = database
    .prepare(
      `SELECT att.attachable_id AS id, att.text AS text, ${plain.length ? plain.map(({ sql }) => sql).join(" OR ") : "0"} AS plain FROM attachments att WHERE att.attachable_type='${item}' AND ${SPEECH} AND att.attachable_id IN (SELECT value FROM json_each(?)) AND (${any.map(({ sql }) => sql).join(" OR ")}) ORDER BY plain DESC, att.position`,
    )
    .all(...plain.flatMap(({ params }) => params), keys, ...any.flatMap(({ params }) => params))
  const found = new Map<number, { text: string; corrections: { from: string; to: string[] }[] }>()
  for (const row of rows) {
    const id = Number(row.id)
    if (found.has(id)) continue
    const text = String(row.text)
    const tokens = new Set(normalize(text).match(/[\p{L}\p{N}]+/gu) ?? [])
    const corrections =
      Number(row.plain) === 1
        ? []
        : speaking.flatMap(({ from, widened }) => {
            const to = widened.filter((word) => tokens.has(word))
            return to.length ? [{ from, to }] : []
          })
    found.set(id, { text, corrections })
  }
  return found
}
