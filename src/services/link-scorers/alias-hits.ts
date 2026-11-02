import { formatReference } from "../../domain/references.js"
import { chatRef, projectTerms, wholeWords } from "./shared.js"
import type { LinkCandidate, LinkScorer } from "./types.js"

const SEARCH_LIMIT = 500

export const aliasWeight = (hits: number): number => (hits >= 10 ? 0.55 : hits >= 3 ? 0.35 : 0)

/**
 * Messages in the window that name the project as whole words, grouped by chat: 3–9 of them, or 10 and more. A
 * text search finds a word inside another, so each hit is checked again by the whole-word rule.
 */
export const aliasHits: LinkScorer = {
  id: "alias-hits",
  version: 1,
  candidates: async ({ store, project, sources, since, signal }) => {
    if (!project) return []
    // The trigram index answers a shorter query with nothing.
    const terms = projectTerms(project).filter((term) => [...term.trim()].length >= 3)
    const found: LinkCandidate[] = []
    for (const key of sources) {
      const chats = new Map<string, Map<string, string>>()
      for (const term of terms) {
        signal?.throwIfAborted()
        const pattern = wholeWords(term)
        const hits = await store.messages.find({ account: key, text: term, limit: SEARCH_LIMIT })
        for (const hit of hits.items) {
          if (hit.timestamp < since || !pattern.test(hit.text.normalize("NFKC").toLowerCase())) continue
          const messages = chats.get(String(hit.chatId)) ?? new Map<string, string>()
          messages.set(
            String(hit.id),
            formatReference({
              type: "message",
              provider: key.provider,
              account: String(key.account),
              chat: String(hit.chatId),
              message: String(hit.id),
            }),
          )
          chats.set(String(hit.chatId), messages)
        }
      }
      for (const [chat, messages] of chats) {
        const weight = aliasWeight(messages.size)
        if (!weight) continue
        found.push({
          from: chatRef(key, chat),
          to: project.ref,
          kind: "member-of",
          weight,
          why: `${messages.size} messages since ${since.slice(0, 10)} name the project`,
          evidence: [...messages.values()].slice(0, 3),
        })
      }
    }
    return found
  },
}
