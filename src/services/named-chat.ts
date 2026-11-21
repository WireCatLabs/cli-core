import type { Id } from "../domain/models.js"
import { createStemmer } from "../search/stem.js"
import { STOP_WORDS } from "../search/task-similarity.js"
import { normalize } from "../store/normalize.js"
import type { AccountKey, MessageStore } from "../store/store.js"
import type { Saved } from "./message-resolution.js"
import { prepareLucene } from "./messages-search.js"

/** Fewer uses than this in one private chat is no evidence of a name. */
const LEAST_USES = 3
/** How many of a word's messages in its private chat are read to see whether it is written as a name. */
const SAMPLE = 50
/** The share of those uses written with a capital letter that makes the word a name there. */
const CAPITALISED = 0.8
/**
 * The least share of the word's uses across every chat, groups too, that its private chat must hold. A place or a
 * brand is capitalised too, but spread over many chats: a few uses in one dialog must not make it a name there. The
 * count takes every word sharing the stem, so a real name's share reads low; under 1% is a word spread over chats.
 */
const NAMED_SHARE = 0.05

export interface NamedChat {
  word: string
  source: AccountKey
  chatId: Id
  title: string | null
}

/**
 * The private chat a query names by a word the two people there write as a name («Петька, привет»), learned from the
 * messages: the one private chat holding most of the word's uses, at least twice as many as any other private chat
 * and `NAMED_SHARE` of them all, where it is capitalised nearly every time. An ordinary word («счёт») is spread over
 * many chats and written in lower case, so it names none.
 */
export const namedChat = async (
  store: MessageStore,
  account: AccountKey,
  messenger: Saved,
  accounts: AccountKey[] | undefined,
  words: string[],
): Promise<NamedChat | undefined> => {
  for (const word of words) {
    if (word.length < 3 || /^\p{N}+$/u.test(word)) continue
    const { execution } = await prepareLucene(
      store,
      account,
      // Quoted, a word is its forms without the longer words it begins: a name, not every word starting like it.
      { text: `"${word}"`, ...(accounts ? { accounts } : {}), limit: SAMPLE },
      messenger,
    )
    const groups = (await store.queries.countQuery(execution, "chat")).sort((a, b) => b.count - a.count)
    const total = groups.reduce((sum, { count }) => sum + count, 0)
    const dialogs: (NamedChat & { count: number })[] = []
    for (const group of groups) {
      if (dialogs.length === 2) break
      const source = { provider: group.provider, account: group.account } as AccountKey
      if (group.id === null || (await store.chats.chatKind(source, group.id)) !== "dialog") continue
      dialogs.push({ word, source, chatId: group.id, title: group.name, count: group.count })
    }
    const [best, next] = dialogs
    if (!best || best.count < LEAST_USES || (next && next.count * 2 > best.count)) continue
    if (best.count < total * NAMED_SHARE) continue
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

/** The query's words, lower case, without the ones nearly every message holds (unless it holds nothing else). */
export const queryWords = (query: string) => {
  const all = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])]
  // `что*` OR `какие*` reads most of a large store and runs out of time before the words that matter count.
  const content = all.filter((word) => !STOP_WORDS.has(normalize(word)))
  return content.length ? content : all
}

/** The query without one of its words, matched whole in any case. */
export const without = (query: string, word: string) =>
  query
    .replace(new RegExp(`(?<![\\p{L}\\p{N}])${word}(?![\\p{L}\\p{N}])`, "giu"), " ")
    .replace(/\s+/gu, " ")
    .trim()
