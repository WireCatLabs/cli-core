import { normalize } from "../../../store/normalize.js"
import { evidenceOf, fromOwner } from "../items.js"
import type { StatusItem, StatusSignal } from "../types.js"

export interface TopicsData {
  query: string
  yoursLast: string | null
  theirsLast: string | null
  /** Their newest mention, when the owner spoke of it later: the other side went quiet on it. */
  silentSince: string | null
}

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

const wholeWord = (word: string) => new RegExp(`(?<![\\p{L}\\p{N}])${escaped(word)}(?![\\p{L}\\p{N}])`, "u")

/** Every word of the query, folded, as a whole word somewhere in the text: `projects evidence`'s reading. */
const matcherOf = (query: string) => {
  const words = normalize(query).split(" ").filter(Boolean).map(wholeWord)
  return (text: string) => {
    const folded = normalize(text)
    return words.length > 0 && words.every((word) => word.test(folded))
  }
}

/** Per `--context-query`, the newest message of each side that holds every one of its words, in the window. */
export const topics: StatusSignal<TopicsData> = {
  id: "topics",
  version: 1,
  scope: "chat",
  read: async (context, chat) => {
    if (!chat) return []
    return context.contextQueries.flatMap((query): StatusItem<TopicsData>[] => {
      const matches = matcherOf(query)
      const naming = chat.messages.filter((message) => matches(message.text))
      const yours = naming.findLast(fromOwner)
      const theirs = naming.findLast((message) => !fromOwner(message))
      if (!yours && !theirs) return []
      const silent = theirs && yours && Date.parse(yours.timestamp) > Date.parse(theirs.timestamp)
      const newest = [yours, theirs]
        .filter((one) => one !== undefined)
        .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))
      return [
        {
          signal: "topics",
          chat: chat.ref,
          at: newest[0]?.timestamp ?? null,
          who: null,
          evidence: evidenceOf(chat, ...newest),
          basis: "store",
          data: {
            query,
            yoursLast: yours?.timestamp ?? null,
            theirsLast: theirs?.timestamp ?? null,
            silentSince: silent ? theirs.timestamp : null,
          },
        },
      ]
    })
  },
}
