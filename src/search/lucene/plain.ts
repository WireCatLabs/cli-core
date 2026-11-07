import { isCliError } from "@wirecat/cli-base"
import { type Predicate, parseLucene, walkQuery } from "@wirecat/cli-base/query"
import { QUERY_FIELDS } from "./registry.js"
import { MESSAGE_PARSING } from "./types.js"

// The parser's own mistakes about plain text: a character it read as syntax. Errors about a field's value stay errors.
const REPAIRED = new Set([
  "query.invalid-syntax",
  "query.unclosed-literal",
  "query.unsupported-operator",
  "query.invalid-escape",
])
// Every source's fields are message fields; after: and before: are refused with a hint to write date:.
const SEARCH_FIELDS = new Set([...QUERY_FIELDS.map(({ name }) => name), "after", "before"])
const FIELD_PREFIX = /^[+-]?([\p{L}\p{N}_.]+)(?:[:=]|[<>]=?)/u
const space = (c: string | undefined) => c !== undefined && /[ \t\n\r\u3000]/u.test(c)

// A quoted word is read as words, whatever it holds; only its quote marks and a trailing backslash need escaping.
const quoted = (text: string): string => {
  let out = ""
  for (let at = 0; at < text.length; at++) {
    const c = text[at] as string
    if (c === "\\" && at + 1 < text.length && (text[at + 1] !== "u" || /^u[0-9a-fA-F]{4}/u.test(text.slice(at + 1)))) {
      out += c + text[at + 1]
      at++
    } else out += c === '"' || c === "\\" ? `\\${c}` : c
  }
  return `"${out}"`
}

/** One word as a phrase, so the parser reads none of it as syntax; a known `field:` and modifiers stay outside. */
const literal = (word: string, keepParens: boolean, fields: ReadonlySet<string>): string => {
  const prefix = FIELD_PREFIX.exec(word)
  const field = prefix && fields.has(prefix[1] ?? "") ? prefix[0] : ""
  const rest = word.slice(field.length)
  const opening = keepParens ? (/^[(+-]*/u.exec(rest)?.[0] ?? "") : ""
  const closing = keepParens ? (/\)*$/u.exec(rest.slice(opening.length))?.[0] ?? "") : ""
  const body = rest.slice(opening.length, rest.length - closing.length)
  if (!body) return keepParens ? literal(word, false, fields) : `${field}${quoted(rest)}`
  return `${field}${opening}${quoted(body)}${closing}`
}

const wordAround = (text: string, at: number): { start: number; end: number } => {
  let start = at
  while (start > 0 && !space(text[start - 1])) start--
  let end = at
  while (end < text.length && !space(text[end])) end++
  return { start, end }
}

const everyWordLiteral = (text: string, fields: ReadonlySet<string>) =>
  text.replace(/[^ \t\n\r\u3000]+/gu, (word) => literal(word, false, fields))

type Reading = { at: number } | { questions: number[] } | { wordless: Predicate[]; words: boolean }

/** Where `text` stops being a search query (-1: somewhere unknown), or the bare words the index holds nothing for. */
const read = (text: string, fields: ReadonlySet<string>): Reading => {
  try {
    const leaves = walkQuery(parseLucene(text, MESSAGE_PARSING).root)
    const unknown = leaves.find(({ field }) => !fields.has(field))
    if (unknown) return { at: text.lastIndexOf(unknown.field, unknown.span.start) }
    // "invoice?" and "что с бюджетом?" ask a question; a `?` inside a word (`inv?ice`) stays one character.
    const questions = leaves.flatMap(({ implicit, operator, value, span }) => {
      const mark = /^[^*?]*[^*?\\]\?+$/u.test(value) && implicit && operator === "wildcard" ? /\?+$/u.exec(value) : null
      return mark ? [span.end - mark[0].length] : []
    })
    if (questions.length) return { questions }
    // An emoji or a lone `^` is no word of the index, so ANDed with the rest it would find nothing at all.
    const wordless = leaves.filter(
      ({ implicit, operator, value }) =>
        implicit && (operator === "term" || operator === "phrase") && !/[\p{L}\p{N}]/u.test(value),
    )
    const words = wordless.length < leaves.length
    return { wordless: words ? wordless : [], words }
  } catch (error) {
    const details = isCliError(error) ? (error.details as { reason?: string; span?: { start: number } }) : undefined
    if (!details?.span || !REPAIRED.has(details.reason ?? "")) throw error
    // `word~1` is Lucene's fuzzy search, which the error answers with the prefix search to use instead.
    if (/^~\d/u.test(text.slice(details.span.start))) throw error
    return { at: details.span.start }
  }
}

const without = (text: string, leaves: Predicate[]): string =>
  [...leaves]
    .sort((a, b) => b.span.start - a.span.start)
    .reduce((left, { span }) => left.slice(0, span.start) + left.slice(span.end), text)
    .trim()

/**
 * Free text as the search reads it: a character the query language takes as syntax where it cannot be syntax — the
 * colon of `10:30` or `HH:MM`, a URL's slashes, an unbalanced quote or bracket — is made literal by quoting the word
 * that holds it, a `word:` that names no search field is that word, and a bare emoji or punctuation mark beside other
 * words is dropped. A `?` that ends a bare word is a question mark, not a one-character wildcard. A query that
 * already reads well, and has no such word, comes back unchanged, so this can run again on its own output;
 * field queries and Boolean operators keep their meaning. A field's own mistake (`kind:nonsense`) is left for the
 * search to report. `fields` are the names a list of its own (memories: `text`, `scope`) reads as fields.
 */
export const plainQuery = (text: string, fields: ReadonlySet<string> = SEARCH_FIELDS): string => {
  let current = text
  let whole = false
  for (let tries = 0; tries <= 64; tries++) {
    let reading: Reading
    try {
      reading = read(current, fields)
    } catch {
      return text
    }
    if ("questions" in reading) {
      current = reading.questions
        .sort((a, b) => b - a)
        .reduce(
          (left, at) => left.slice(0, at) + left.slice(at).replace(/^\?+/u, (marks) => "\\?".repeat(marks.length)),
          current,
        )
      continue
    }
    if ("wordless" in reading) {
      // Punctuation alone (`!!!`) is no search; the parser's error says so better than an empty answer.
      if (!reading.words && current !== text) return text
      if (!reading.wordless.length) return current
      current = without(current, reading.wordless)
      continue
    }
    // At the end, the parser is still waiting for a `)` or a term, and no one word is to blame.
    const word = reading.at < 0 || reading.at >= current.length ? undefined : wordAround(current, reading.at)
    const paren = "()".includes(current[reading.at] ?? "")
    const repaired = word
      ? current.slice(0, word.start) +
        literal(current.slice(word.start, word.end), !paren, fields) +
        current.slice(word.end)
      : current
    if (repaired !== current) {
      current = repaired
      continue
    }
    if (whole) return text
    whole = true
    current = everyWordLiteral(text, fields)
  }
  return text
}
