import { CliError, singleLine } from "@wirecat/cli-base"
import type { Chat, Contact, Id, Provider } from "./domain/models.js"
import { contactReferenceOf } from "./domain/ref-arguments.js"

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
 * (U+200D) the typed one lacks, and a letter may come composed or as letter plus accent; none of that is a different
 * name.
 */
export const foldName = (name: string): string =>
  name
    .normalize("NFC")
    .replace(/[\uFE0E\uFE0F\u200D]/g, "")
    .toLowerCase()

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
  const fields = (person: Contact) => [person.alias, person.name, person.username].filter(isPresent).map(foldName)

  const exact = everyone.filter((person) => fields(person).includes(wanted))
  const matches =
    exact.length > 0 ? exact : everyone.filter((person) => fields(person).some((one) => one.includes(wanted)))

  if (matches.length === 1 && matches[0]) return matches[0]
  if (matches.length === 0) throw new CliError("not_found", `nobody matches "${reference}"`)
  throw ambiguous(
    reference,
    "people",
    matches.map(({ id, name, username }) => ({ id, name, username })),
    ({ name, username }) => singleLine([name, username && `@${username}`].filter(isPresent).join("  ")),
  )
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
