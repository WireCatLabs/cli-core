import { CliError, singleLine } from "@wirecat/cli-base"
import type { Chat, Contact, Id, Provider } from "./domain/models.js"
import { contactReferenceOf } from "./domain/ref-arguments.js"
import { compileAutomaton, wildcardPattern } from "./search/lucene/automaton.js"
import { trigrams } from "./search/trigrams.js"

/** The part of a store that `pickPerson` reads. */
export interface PeopleLookup {
  /** Whose identities these are; a `contact:` reference of another provider is refused when it is set. */
  provider?: Provider
  get(id: Id): Contact | undefined
  /** Everyone known, in any order. */
  all(): Contact[]
}

/** Shaped like a Telegram or MAX id. Another messenger's ids may be any string, so a miss here is not "not an id". */
export const isId = (reference: string): boolean => /^-?\d+$/.test(reference.trim())

/**
 * A name as matching compares it. A copied emoji often carries a presentation mark (U+FE0F, U+FE0E) or a joiner
 * (U+200D) the typed one lacks, a letter may come composed or as letter plus accent, and Russian is mostly typed with
 * е for ё; none of that is a different name. Only ё is folded: stripping every mark would also merge й into и.
 */
export const foldName = (name: string): string =>
  name
    .normalize("NFC")
    .replace(/[\uFE0E\uFE0F\u200D]/g, "")
    .toLowerCase()
    .replaceAll("ё", "е")

/**
 * A name matched as a fragment — and **an ambiguous one is an error, not a guess**: sending to the
 * wrong conversation is not undoable, so the caller is shown the candidates and asked to be
 * specific. An exact title does not settle it while another title contains it too: a group named
 * "Мама" must not quietly take a send meant for "Мама Иванова".
 */
export const pickChat = (reference: string, chats: Chat[]): Chat => {
  const wanted = foldName(reference.trim())
  const matches = chats.filter((chat) => chat.title !== null && foldName(chat.title).includes(wanted))

  if (matches.length === 1 && matches[0]) return matches[0]
  if (matches.length === 0) throw new CliError("not_found", `no chat matches "${reference}"`)
  throw ambiguous(
    reference,
    "chats",
    matches.map((chat) => ({ id: chat.id, title: chat.title })),
    ({ title }) => singleLine(String(title)),
  )
}

/**
 * As `pickChat`, over names and @usernames. Matched here rather than in SQL because SQLite's
 * `lower()` folds ASCII only, and most of these names are Cyrillic.
 */
export const pickPerson = (reference: string, people: PeopleLookup): Contact => {
  const trimmed = reference.trim()
  const contact = contactReferenceOf(trimmed, people.provider)
  if (contact !== undefined) {
    const named = people.get(contact)
    if (named) return named
    throw new CliError("not_found", `no person ${contact} in what this account has seen`)
  }
  const known = people.get(trimmed)
  if (known) return known
  if (isId(trimmed)) throw new CliError("not_found", `no person ${trimmed} in what this account has seen`)

  const wanted = foldName(trimmed.replace(/^@/, ""))
  const everyone = people.all().toSorted((a, b) => (a.name ?? "").localeCompare(b.name ?? ""))

  const exact = everyone.filter((person) => namesOf(person).includes(wanted))
  const containing = everyone.filter((person) => namesOf(person).some((one) => one.includes(wanted)))
  if (exact.length === 1 && exact[0]) return exact[0]
  if (containing.length === 1 && containing[0]) return containing[0]
  if (containing.length === 0) throw new CliError("not_found", `nobody matches "${reference}"`)
  // Several people are named exactly this: the ones it is only part of the name of are as likely meant.
  const matches = exact.length > 0 ? [...exact, ...containing.filter((person) => !exact.includes(person))] : containing
  throw ambiguous(
    reference,
    "people",
    matches.map(({ id, name, username }) => ({ id, name, username })),
    ({ name, username }) => singleLine([name, username && `@${username}`].filter(isPresent).join("  ")),
  )
}

const namesOf = (person: Contact, byAddress = false): string[] =>
  [person.alias, person.name, person.username, byAddress ? person.id : undefined].filter(isPresent).map(foldName)
const chatNamesOf = (chat: Chat): string[] =>
  [chat.title, chat.providerMetadata?.username]
    .filter((one): one is string => typeof one === "string" && one !== "")
    .map(foldName)

/** A name pattern with Lucene's `*` and `?`, matched against a whole name folded as `foldName` folds it. */
const namePattern = (pattern: string) => {
  const automaton = compileAutomaton(wildcardPattern(foldName(pattern.trim().replace(/^@/, ""))))
  return (names: string[]) => names.some((one) => automaton.test(one))
}

/** Everyone a name pattern such as `Ярослав*` or `*Орлов*` fits by their alias, name or @username. */
export const peopleMatching = (pattern: string, people: Contact[], { byAddress = false } = {}): Contact[] => {
  const fits = namePattern(pattern)
  return people.filter((person) => fits(namesOf(person, byAddress)))
}

/** Every chat a name pattern fits by its title or @username. */
export const chatsMatching = (pattern: string, chats: Chat[]): Chat[] => {
  const fits = namePattern(pattern)
  return chats.filter((chat) => fits(chatNamesOf(chat)))
}

/** The items whose names are closest to what a pattern spells, for a refusal to offer: a typo finds nobody. */
export const nearest = <T>(pattern: string, items: T[], names: (item: T) => string[], most = 5): T[] => {
  const pieces = (text: string) => foldName(text).split(/\s+/u).flatMap(trigrams)
  const wanted = new Set(pieces(pattern.replace(/\\(.)/gu, "$1").replace(/[*?@]/gu, " ").trim()))
  if (wanted.size === 0) return []
  return items
    .map((item) => ({
      item,
      score: names(item)
        .flatMap(pieces)
        .filter((piece) => wanted.has(piece)).length,
    }))
    .filter(({ score }) => score > 1)
    .toSorted((a, b) => b.score - a.score)
    .slice(0, most)
    .map(({ item }) => item)
}

const ambiguous = <T extends { id: Id }>(
  reference: string,
  what: string,
  candidates: T[],
  label: (candidate: T) => string,
): CliError => {
  const width = Math.max(...candidates.map(({ id }) => id.length))
  const lines = candidates.map((candidate) => `  ${candidate.id.padEnd(width)}  ${label(candidate)}`).join("\n")
  return new CliError(
    "validation_error",
    `"${singleLine(reference)}" matches ${candidates.length} ${what} — name one by its id:\n${lines}`,
    { candidates },
  )
}

const isPresent = <T>(value: T | null | undefined): value is T => value !== null && value !== undefined
