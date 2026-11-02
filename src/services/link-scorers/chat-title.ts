import { chatRef, namesProject, wholeWords } from "./shared.js"
import type { LinkCandidate, LinkScorer } from "./types.js"

const WEIGHT = 0.7

/**
 * A chat whose title names the project, its key or an alias as whole words. A purpose the owner configured that the
 * title also names («HRB sales») is proposed with it. Mail threads are the `mail-thread` scorer's.
 */
export const chatTitle: LinkScorer = {
  id: "chat-title",
  version: 1,
  candidates: async ({ store, project, sources, purposes, signal }) => {
    if (!project) return []
    const names = namesProject(project)
    const purposeOf = purposes
      .filter((purpose) => purpose !== "work")
      .map((purpose) => ({ purpose, pattern: wholeWords(purpose) }))
    const found: LinkCandidate[] = []
    for (const key of sources) {
      if (key.provider === "email") continue
      signal?.throwIfAborted()
      const chats = await store.chats.chats(key, {})
      for (const chat of chats.items) {
        if (chat.kind === "saved") continue
        const term = names(chat.title)
        if (!term) continue
        const title = (chat.title ?? "").normalize("NFKC").toLowerCase()
        const purpose = purposeOf.find(({ pattern }) => pattern.test(title))?.purpose
        found.push({
          from: chatRef(key, chat.id),
          to: project.ref,
          kind: "member-of",
          weight: WEIGHT,
          why: `the chat title names the project${term === project.name ? "" : ` (${term === project.key ? "key" : "alias"})`}`,
          evidence: [],
          ...(purpose ? { purpose } : {}),
        })
      }
    }
    return found
  },
}
