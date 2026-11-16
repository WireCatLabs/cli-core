import type { Id } from "../domain/models.js"
import { createStemmer } from "../search/stem.js"
import type { AccountKey, MessageStore } from "../store/store.js"
import type { ServiceDeps } from "./deps.js"
import { prepareLucene } from "./messages-search.js"

/** Fewer uses than this in one private chat is no evidence of a name. */
const LEAST_USES = 3
/** How many of a word's messages in its private chat are read to see whether it is written as a name. */
const SAMPLE = 50
/** The share of those uses written with a capital letter that makes the word a name there. */
const CAPITALISED = 0.8

export interface NamedChat {
  word: string
  source: AccountKey
  chatId: Id
  title: string | null
}

/**
 * The private chat a query names by a word the two people there write as a name («Петька, привет»), learned from the
 * messages: the one private chat holding most of the word's uses, at least twice as many as any other private chat,
 * where it is capitalised nearly every time. An ordinary word («счёт») is spread over many chats and written in
 * lower case, so it names none.
 */
export const namedChat = async (
  deps: ServiceDeps,
  store: MessageStore,
  accounts: AccountKey[],
  words: string[],
): Promise<NamedChat | undefined> => {
  for (const word of words) {
    if (word.length < 3 || /^\p{N}+$/u.test(word)) continue
    const { execution } = await prepareLucene(
      store,
      await deps.account(),
      // Quoted, a word is its forms without the longer words it begins: a name, not every word starting like it.
      { text: `"${word}"`, accounts, limit: SAMPLE },
      deps.messenger,
    )
    const groups = (await store.queries.countQuery(execution, "chat")).sort((a, b) => b.count - a.count)
    const dialogs: (NamedChat & { count: number })[] = []
    for (const group of groups) {
      if (dialogs.length === 2) break
      const source = accounts.find((one) => one.provider === group.provider && one.account === group.account)
      if (!source || group.id === null || (await store.chats.chatKind(source, group.id)) !== "dialog") continue
      dialogs.push({ word, source, chatId: group.id, title: group.name, count: group.count })
    }
    const [best, next] = dialogs
    if (!best || best.count < LEAST_USES || (next && next.count * 2 > best.count)) continue
    const { items } = await store.queries.matchQuery({
      ...execution,
      chat: { account: best.source, chatId: best.chatId },
    })
    const stemmer = execution.stemmer ?? createStemmer()
    const stem = stemmer.stemToken(word)
    const uses = items.flatMap(({ text }) =>
      (text?.match(/[\p{L}\p{N}]+/gu) ?? []).filter((token) => stemmer.stemToken(token) === stem),
    )
    const capitalised = uses.filter((token) => token[0] !== token[0]?.toLowerCase()).length
    if (uses.length >= LEAST_USES && capitalised >= uses.length * CAPITALISED) {
      const { count: _, ...named } = best
      return named
    }
  }
  return undefined
}
