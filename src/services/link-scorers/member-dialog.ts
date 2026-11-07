import { chatRef, identitiesIn, projectsOf } from "./shared.js"
import type { LinkCandidate, LinkScorer } from "./types.js"

const WEIGHT = 0.6

/** A dialog with a person member, divided by how many projects that person is a member of, this one counted. */
export const memberDialog: LinkScorer = {
  id: "member-dialog",
  version: 2,
  spreads: true,
  candidates: async ({ store, project, confirmed, sources, owner, signal }) => {
    if (!project) return []
    const people = confirmed.people.filter((person) => person !== owner)
    const projects = new Map<string, number>()
    const found: LinkCandidate[] = []
    for (const key of sources)
      for (const { person, id } of await identitiesIn(store, people, key.provider)) {
        signal?.throwIfAborted()
        for (const chat of await store.chats.chatsWith(key, id)) {
          if (chat.kind !== "dialog") continue
          if (!projects.has(person)) projects.set(person, await projectsOf(store, person, project.ref))
          const shared = projects.get(person) ?? 1
          found.push({
            from: chatRef(key, chat.id),
            to: project.ref,
            kind: "member-of",
            weight: WEIGHT / shared,
            why: `a dialog with a member (${person})${shared > 1 ? `, who is in ${shared} projects` : ""}`,
            evidence: [person],
          })
        }
      }
    return found
  },
}
