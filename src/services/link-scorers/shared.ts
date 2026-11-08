import type { Id } from "../../domain/models.js"
import { formatReference } from "../../domain/references.js"
import { isUsable } from "../../domain/relations.js"
import { normalizeVocabularyName } from "../../domain/vocabulary.js"
import type { MessageStore } from "../../store/store.js"
import type { AccountKey } from "../../store/types.js"
import type { ScannedProject, ScorerInput } from "./types.js"

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
const folded = (text: string) => text.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ")

/** A whole-word test, the rule the evidence lanes and meeting candidates use: «Harbour» is not in «Harbourside». */
export const wholeWords = (term: string): RegExp =>
  new RegExp(`(?<![\\p{L}\\p{N}\\p{M}_])${escaped(normalizeVocabularyName(term))}(?![\\p{L}\\p{N}\\p{M}_])`, "u")

/** The project's name, key and aliases, each once. */
export const projectTerms = (project: ScannedProject): string[] => {
  const terms = new Map<string, string>()
  for (const term of [project.name, project.key, ...project.aliases])
    if (term?.trim()) terms.set(normalizeVocabularyName(term), term)
  return [...terms.values()]
}

/** The first of the project's terms a text names as whole words. */
export const namesProject = (project: ScannedProject): ((text: string | null | undefined) => string | undefined) => {
  const patterns = projectTerms(project).map((term) => ({ term, pattern: wholeWords(term) }))
  return (text) => {
    if (!text) return undefined
    const value = folded(text)
    return patterns.find(({ pattern }) => pattern.test(value))?.term
  }
}

export const chatRef = (key: AccountKey, chat: Id): string =>
  formatReference({ type: "chat", provider: key.provider, account: String(key.account), chat: String(chat) })

export const contactRef = (provider: string, id: Id): string =>
  formatReference({ type: "contact", provider, id: String(id) })

export const sameAccount = (a: AccountKey, b: { provider: string; account: string }): boolean =>
  a.provider === b.provider && String(a.account) === b.account

/** The person an identity is, as `person:<uid>`; `undefined` when the store has no person for it. */
export const personRefOf = async (
  input: Pick<ScorerInput, "store" | "remember">,
  provider: string,
  id: Id,
): Promise<string | undefined> => {
  const person = await remembered(input, `person-of\u0000${provider}\u0000${String(id)}`, () =>
    input.store.people.personOf({ provider, id }),
  )
  return person ? `person:${person.uid}` : undefined
}

/** How many projects a person is a confirmed member of, counting `project` whether confirmed or only found. */
export const projectsOf = async (store: MessageStore, person: string, project: string): Promise<number> =>
  new Set([
    project,
    ...(await store.knowledge.relations(null, person))
      .filter(
        (one) =>
          isUsable(one.standing) && one.kind === "member-of" && one.from === person && one.to.startsWith("project:"),
      )
      .map((one) => one.to),
  ]).size

/** Each confirmed member's identities in one messenger, by member. */
export const identitiesIn = async (
  store: MessageStore,
  people: readonly string[],
  provider: string,
): Promise<{ person: string; id: string }[]> => {
  const found: { person: string; id: string }[] = []
  for (const person of people) {
    const record = await store.people.personByUid(person.slice("person:".length))
    for (const identity of record?.identities ?? [])
      if (identity.provider === provider) found.push({ person, id: String(identity.id) })
  }
  return found
}

/** What `read` gives, once per scan when the scan remembers. */
export const remembered = <T>(input: Pick<ScorerInput, "remember">, key: string, read: () => Promise<T>): Promise<T> =>
  input.remember ? input.remember(key, read) : read()

/** A member's chats in one account, read once per scan by every scorer that asks. */
export const chatsWithOf = (input: Pick<ScorerInput, "store" | "remember">, key: AccountKey, id: string) =>
  remembered(input, `chats-with\u0000${key.provider}\u0000${key.account}\u0000${id}`, () =>
    input.store.chats.chatsWith(key, id),
  )

export const aborted = (signal: AbortSignal | undefined): void => signal?.throwIfAborted()
