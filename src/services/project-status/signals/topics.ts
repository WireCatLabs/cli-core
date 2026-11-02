import { normalize } from "../../../store/normalize.js"
import { evidenceOf, fromOwner } from "../items.js"
import type { StatusItem, StatusSignal } from "../types.js"

export interface TopicsData {
  topic: string
  yoursLast: string | null
  theirsLast: string | null
  /** Their newest mention, when the owner spoke of it later: the other side went quiet on it. */
  silentSince: string | null
}

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

const wholeWord = (topic: string) =>
  new RegExp(`(?<![\\p{L}\\p{N}])${escaped(normalize(topic))}(?![\\p{L}\\p{N}])`, "u")

/** Per `--topic` word, the newest message of each side that names it (folded, whole word, in the window). */
export const topics: StatusSignal<TopicsData> = {
  id: "topics",
  version: 1,
  scope: "chat",
  read: async (context, chat) => {
    if (!chat) return []
    return context.topics.flatMap((topic): StatusItem<TopicsData>[] => {
      const pattern = wholeWord(topic)
      const naming = chat.messages.filter((message) => pattern.test(normalize(message.text)))
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
            topic,
            yoursLast: yours?.timestamp ?? null,
            theirsLast: theirs?.timestamp ?? null,
            silentSince: silent ? theirs.timestamp : null,
          },
        },
      ]
    })
  },
}
