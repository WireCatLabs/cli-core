import { chatRef, identitiesIn } from "./shared.js"
import type { LinkCandidate, LinkScorer } from "./types.js"

const WEIGHT = 0.5

/** A group or channel where two or more of the project's confirmed person members are members. */
export const memberChats: LinkScorer = {
  id: "member-chats",
  version: 1,
  candidates: async ({ store, project, confirmed, sources, owner, signal }) => {
    if (!project) return []
    const people = confirmed.people.filter((person) => person !== owner)
    const found: LinkCandidate[] = []
    for (const key of sources) {
      const members = new Map<string, Set<string>>()
      for (const { person, id } of await identitiesIn(store, people, key.provider)) {
        signal?.throwIfAborted()
        for (const chat of await store.chats.chatsWith(key, id)) {
          if (chat.kind !== "group" && chat.kind !== "channel") continue
          const held = members.get(String(chat.id)) ?? new Set<string>()
          held.add(person)
          members.set(String(chat.id), held)
        }
      }
      for (const [chat, held] of members) {
        if (held.size < 2) continue
        const named = [...held].sort()
        found.push({
          from: chatRef(key, chat),
          to: project.ref,
          kind: "member-of",
          weight: WEIGHT,
          why: `a group with ${held.size} confirmed members (${named.slice(0, 3).join(", ")}${held.size > 3 ? ", …" : ""})`,
          evidence: named.slice(0, 5),
        })
      }
    }
    return found
  },
}
