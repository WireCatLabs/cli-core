import { CliError, singleLine } from "@wirecat/cli-base"
import type { QueryAst, QueryNode } from "@wirecat/cli-base/query"
import { isNumberWord, widenWords } from "../../search/garbled.js"
import { knownRussianWord } from "../../search/russian-dictionary.js"
import type { Stemmer } from "../../search/stem.js"
import type { CacheDatabase, SqlValue } from "../driver.js"
import { fold, normalize } from "../normalize.js"
import { meetingStemmableText } from "./meeting-stem-state.js"

const WORD = /[\p{L}\p{N}\p{M}]+/gu
const MOST_WORDS = 128

interface Word {
  raw: string
  literal: string
  /** Matched as a whole word, not as a beginning: `exact:` and number words. */
  whole: boolean
  stems: string[]
  widened: string[]
}
type Leaf =
  | { kind: "words"; exact: boolean; words: Word[] }
  | { kind: "phrase"; exact: boolean; words: Word[] }
  /** `"a b"~N`: every word within `lines` transcript lines of a line that holds one of them. */
  | { kind: "near"; exact: boolean; words: Word[]; lines: number }
  | { kind: "speaker"; participants: number[]; names: string[] }
export type Resolved = Leaf | { kind: "boolean"; must: Resolved[]; should: Resolved[]; not: Resolved[] }

interface State {
  stemmer: Stemmer | null
  through: number
}

const quote = (word: string): string => `"${word.replaceAll('"', '""')}"`

/** The candidates `from:` picks among: a linked person with all their identities, else one identity or name. */
const speakers = (database: CacheDatabase, accountId: number) => {
  const found = new Map<string, { label: string; names: Set<string>; participants: Set<number>; raw: Set<string> }>()
  const add = (key: string, label: string, names: (string | null)[], participant: number | null, raw?: string) => {
    const speaker = found.get(key) ?? { label, names: new Set(), participants: new Set(), raw: new Set() }
    for (const name of names) if (name?.trim()) speaker.names.add(fold(name.trim()))
    if (participant !== null) speaker.participants.add(participant)
    if (raw) speaker.raw.add(raw)
    found.set(key, speaker)
  }
  const participants = database
    .prepare(
      `SELECT p.id,p.identity_id,p.display_name,p.email,i.external_id AS identity_key,i.name AS identity_name,l.person_id,person.name AS person_name
       FROM meeting_participants p JOIN meetings m ON m.id=p.meeting_id
       LEFT JOIN identities i ON i.id=p.identity_id LEFT JOIN identity_links l ON l.identity_id=p.identity_id
       LEFT JOIN persons person ON person.id=l.person_id WHERE m.account_id=? AND m.deleted_at IS NULL`,
    )
    .all(accountId)
  const personNames = database.prepare(
    "SELECT i.name FROM identity_links l JOIN identities i ON i.id=l.identity_id WHERE l.person_id=?",
  )
  for (const row of participants) {
    const names = [row.display_name, row.identity_name, row.person_name].map((name) =>
      name === null || name === undefined ? null : String(name),
    )
    const label = names.find((name) => name?.trim()) ?? "unnamed"
    if (row.person_id !== null && row.person_id !== undefined) {
      const others = personNames.all(Number(row.person_id)).map((one) => (one.name === null ? null : String(one.name)))
      add(`person:${row.person_id}`, String(row.person_name ?? label), [...names, ...others], Number(row.id))
    } else if (
      row.identity_id !== null &&
      row.identity_id !== undefined &&
      !String(row.identity_key).startsWith("name:")
    )
      add(`identity:${row.identity_id}`, row.email ? `${label} <${row.email}>` : label, names, Number(row.id))
    // A participant known only by name is keyed per meeting (`name:…@account/occurrence:n`); across meetings the name is all there is.
    else add(`name:${fold(label)}`, label, names, Number(row.id))
  }
  // A name heard in one meeting is the identified speaker of that name, when exactly one has it.
  for (const [key, speaker] of found) {
    if (!key.startsWith("name:")) continue
    const named = [...found].filter(([other, one]) => !other.startsWith("name:") && one.names.has(key.slice(5)))
    const [only] = named
    if (named.length !== 1 || !only) continue
    for (const participant of speaker.participants) only[1].participants.add(participant)
    found.delete(key)
  }
  const unlinked = database
    .prepare(
      `SELECT DISTINCT r.speaker_name AS name FROM meeting_transcript_rows r
       JOIN meeting_transcripts t ON t.id=r.meeting_transcript_id JOIN meetings m ON m.id=t.meeting_id
       WHERE m.account_id=? AND m.deleted_at IS NULL AND r.speaker_participant_id IS NULL AND r.speaker_name IS NOT NULL
       UNION SELECT DISTINCT c.sender_name FROM meeting_chat_messages c JOIN meetings m ON m.id=c.meeting_id
       WHERE m.account_id=? AND m.deleted_at IS NULL AND c.sender_participant_id IS NULL AND c.sender_name IS NOT NULL`,
    )
    .all(accountId, accountId)
  for (const row of unlinked) {
    const name = String(row.name)
    if (!name.trim()) continue
    const same = [...found.values()].find((speaker) => speaker.names.has(fold(name.trim())))
    if (same) same.raw.add(name)
    else add(`name:${fold(name.trim())}`, name, [name], null, name)
  }
  return [...found.values()]
}

/**
 * As `pickPerson` for messages: a name matched as a fragment, the exact name first, and an ambiguous one is an
 * error with the candidates rather than a guess.
 */
const pickSpeaker = (database: CacheDatabase, accountId: number, reference: string): Leaf => {
  const wanted = fold(reference.trim())
  const everyone = speakers(database, accountId).sort((a, b) => a.label.localeCompare(b.label))
  const exact = everyone.filter((speaker) => speaker.names.has(wanted))
  const matches = exact.length
    ? exact
    : everyone.filter((speaker) => [...speaker.names].some((n) => n.includes(wanted)))
  const [one] = matches
  if (matches.length === 1 && one)
    return { kind: "speaker", participants: [...one.participants].sort((a, b) => a - b), names: [...one.raw].sort() }
  if (matches.length === 0) throw new CliError("not_found", `from:${reference} — nobody spoke as "${reference}"`)
  throw new CliError(
    "validation_error",
    `from:${reference} matches ${matches.length} speakers — write more of the name:\n${matches
      .map((speaker) => `  ${singleLine(speaker.label)}`)
      .join("\n")}`,
    { candidates: matches.map((speaker) => ({ name: speaker.label })) },
  )
}

/** The parsed query, its names resolved and its words stemmed and widened, before any text is read. */
export const resolveMeetingQuery = (
  database: CacheDatabase,
  accountId: number,
  ast: QueryAst,
  state: State,
): Resolved => {
  const all: Word[] = []
  const wordsOf = (value: string, exact: boolean): Word[] => {
    const words = (value.match(WORD) ?? [])
      .filter((raw) => normalize(raw))
      .map((raw): Word => {
        const literal = normalize(raw)
        return {
          raw,
          literal,
          whole: exact || isNumberWord(literal),
          stems:
            state.stemmer && raw.length <= 1024 && !exact
              ? [...new Set(state.stemmer.explain(raw).map((word) => word.stem))]
              : [],
          widened: [],
        }
      })
    for (const term of words) all.push(term)
    if (all.length > MOST_WORDS)
      throw new CliError("validation_error", "Meeting search supports at most 128 query words")
    return words
  }
  const resolve = (node: QueryNode): Resolved => {
    if (node.kind === "boolean")
      return {
        kind: "boolean",
        must: node.clauses.filter((c) => c.occur === "must").map((c) => resolve(c.node)),
        should: node.clauses.filter((c) => c.occur === "should").map((c) => resolve(c.node)),
        not: node.clauses.filter((c) => c.occur === "must_not").map((c) => resolve(c.node)),
      }
    if (node.field === "from") return pickSpeaker(database, accountId, node.value)
    const exact = node.field === "exact"
    const words = wordsOf(node.value, exact)
    if (node.operator === "phrase" && node.slop !== undefined && words.length > 1)
      return { kind: "near", exact, words, lines: node.slop }
    return { kind: node.operator === "phrase" && words.length > 1 ? "phrase" : "words", exact, words }
  }
  const tree = resolve(ast.root)
  const stemmer = state.stemmer
  const widening: Word[] = []
  const collect = (node: Resolved): void => {
    if (node.kind === "boolean") [...node.must, ...node.should, ...node.not].forEach(collect)
    else if ((node.kind === "words" || node.kind === "near") && !node.exact)
      for (const term of node.words) widening.push(term)
  }
  collect(tree)
  if (stemmer && state.through > 0 && widening.length) {
    const widened = widenWords(
      widening,
      database
        .prepare("SELECT term,doc FROM meeting_words_vocab WHERE col='normalized_text'")
        .all()
        .map((row) => ({ term: String(row.term), docs: Number(row.doc) })),
      (word) => [...new Set(stemmer.explain(word).map((part) => part.stem))],
      knownRussianWord,
    )
    widening.forEach((word, at) => {
      word.widened = widened[at] ?? []
    })
  }
  return tree
}

/**
 * A `(rid, tier)` select: tier 0 the typed form, 1 another form the stems found, 2 a garbled spelling. A passage
 * all of a query's required parts reach takes the worst tier among them; one any optional part reaches, the best.
 */
export const meetingQuerySql = (tree: Resolved, state: State): { sql: string; params: SqlValue[] } => {
  const params: SqlValue[] = []
  const stems = state.stemmer !== null && state.through > 0
  const word = (term: Word): string => {
    params.push(`normalized_text : (${quote(term.literal)}${term.whole ? "" : "*"})`)
    let select = "SELECT rowid AS rid,0 AS tier FROM meeting_words WHERE meeting_words MATCH ?"
    if (stems && term.stems.length) {
      params.push(`stems : (${term.stems.map(quote).join(" OR ")})`, state.through)
      select += " UNION SELECT rowid,1 FROM meeting_stems WHERE meeting_stems MATCH ? AND rowid<=?"
    }
    if (term.widened.length) {
      params.push(`normalized_text : (${term.widened.map(quote).join(" OR ")})`)
      select += " UNION SELECT rowid,2 FROM meeting_words WHERE meeting_words MATCH ?"
    }
    return `SELECT rid,min(tier) AS tier FROM (${select}) GROUP BY rid`
  }
  const all = (parts: string[]) =>
    parts.length === 1
      ? (parts[0] as string)
      : `SELECT rid,max(tier) AS tier FROM (${parts.join(" UNION ALL ")}) GROUP BY rid HAVING count(*)=${parts.length}`
  const any = (parts: string[]) =>
    parts.length === 1
      ? (parts[0] as string)
      : `SELECT rid,min(tier) AS tier FROM (${parts.join(" UNION ALL ")}) GROUP BY rid`
  const nothing = "SELECT NULL AS rid,0 AS tier WHERE 0"
  const compile = (node: Resolved): string => {
    if (node.kind === "words") return node.words.length ? all(node.words.map(word)) : nothing
    if (node.kind === "near") {
      const lines = node.words.map(
        (term, i) =>
          `w${i} AS MATERIALIZED (SELECT r.meeting_transcript_id AS t,r.position AS p,r.id,h.tier FROM (${word(term)}) h JOIN meeting_transcript_rows r ON h.rid%4=1 AND r.id=h.rid/4)`,
      )
      const nearest = node.words.map(
        (_, i) =>
          `(SELECT min(x.tier) FROM w${i} x WHERE x.t=c.t AND x.p BETWEEN c.p-${node.lines} AND c.p+${node.lines})`,
      )
      return `SELECT rid,tier FROM (WITH ${lines.join(",")}, c AS (${node.words
        .map((_, i) => `SELECT t,p,id FROM w${i}`)
        .join(" UNION ")}) SELECT c.id*4+1 AS rid,max(${nearest.join(",")}) AS tier FROM c) WHERE tier IS NOT NULL`
    }
    if (node.kind === "phrase") {
      params.push(`normalized_text : ${quote(node.words.map((term) => term.literal).join(" "))}`)
      let select = "SELECT rowid AS rid,0 AS tier FROM meeting_words WHERE meeting_words MATCH ?"
      const phrases = node.exact ? undefined : state.stemmer?.phrases(node.words.map((term) => term.raw).join(" "))
      if (stems && phrases) {
        params.push(`stems : (${phrases})`, state.through)
        select += " UNION SELECT rowid,1 FROM meeting_stems WHERE meeting_stems MATCH ? AND rowid<=?"
      }
      return `SELECT rid,min(tier) AS tier FROM (${select}) GROUP BY rid`
    }
    if (node.kind === "speaker") {
      params.push(JSON.stringify(node.participants), JSON.stringify(node.names))
      params.push(JSON.stringify(node.participants), JSON.stringify(node.names))
      return `SELECT r.id*4+1 AS rid,0 AS tier FROM meeting_transcript_rows r
        WHERE r.speaker_participant_id IN (SELECT value FROM json_each(?)) OR (r.speaker_participant_id IS NULL AND r.speaker_name IN (SELECT value FROM json_each(?)))
        UNION ALL SELECT c.id*4+2,0 FROM meeting_chat_messages c
        WHERE c.sender_participant_id IN (SELECT value FROM json_each(?)) OR (c.sender_participant_id IS NULL AND c.sender_name IN (SELECT value FROM json_each(?)))`
    }
    // Lucene: optional clauses only count when nothing is required; a part that is only exclusions matches nothing.
    const positive = node.must.length
      ? all(node.must.map(compile))
      : node.should.length
        ? any(node.should.map(compile))
        : nothing
    if (!node.not.length) return positive
    return `SELECT rid,tier FROM (${positive}) WHERE rid NOT IN (${node.not.map((part) => `SELECT rid FROM (${compile(part)})`).join(" UNION ")})`
  }
  return { sql: compile(tree), params }
}

/**
 * The tree checked again against a passage's current text — an index lags an edit — and the garbled spellings
 * that let it match. A speaker cannot be read from the text, so it passes here.
 */
export const matchMeetingText = (
  tree: Resolved,
  text: string,
  stemmer: Stemmer | null,
): { from: string; to: string[] }[] | null => {
  const tokens: string[] = normalize(text).match(/[\p{L}\p{N}]+/gu) ?? []
  let stemTokens: Set<string> | undefined
  const stemsOf = () =>
    (stemTokens ??= stemmer
      ? new Set(stemmer.explain(meetingStemmableText(text)).map((word) => word.stem))
      : new Set<string>())
  const word = (term: Word): { from: string; to: string[] }[] | null => {
    if (term.whole ? tokens.includes(term.literal) : tokens.some((token) => token.startsWith(term.literal))) return []
    if (term.stems.some((stem) => stemsOf().has(stem))) return []
    const to = term.widened.filter((widened) => tokens.includes(widened))
    return to.length ? [{ from: term.raw, to }] : null
  }
  const check = (node: Resolved): { from: string; to: string[] }[] | null => {
    if (node.kind === "speaker") return []
    // The other words are on neighbouring lines, so only this line's garbled spellings are named.
    if (node.kind === "near") return node.words.flatMap((term) => word(term) ?? [])
    if (node.kind === "words" || node.kind === "phrase") {
      const found: { from: string; to: string[] }[] = []
      for (const term of node.words) {
        const one = word(term)
        if (!one) return null
        for (const fix of one) found.push(fix)
      }
      return found
    }
    if (node.not.some((part) => check(part) !== null)) return null
    if (node.must.length) {
      const found: { from: string; to: string[] }[] = []
      for (const part of node.must) {
        const one = check(part)
        if (!one) return null
        for (const fix of one) found.push(fix)
      }
      return found
    }
    const matched = node.should.map(check).filter((one) => one !== null)
    return matched.length ? matched.flat() : null
  }
  return check(tree)
}
