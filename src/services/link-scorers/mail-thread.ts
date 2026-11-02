import { formatReference } from "../../domain/references.js"
import { identitiesIn, namesProject } from "./shared.js"
import type { LinkCandidate, LinkScorer } from "./types.js"

const NAMED = 0.7
const MEMBER_ONLY = 0.3
const READ_LIMIT = 500

/** A mail thread a confirmed member writes in or is written to: strong when its subject names the project. */
export const mailThread: LinkScorer = {
  id: "mail-thread",
  version: 1,
  candidates: async ({ store, project, confirmed, sources, since, owner, signal }) => {
    if (!project) return []
    const names = namesProject(project)
    const people = confirmed.people.filter((person) => person !== owner)
    const found: LinkCandidate[] = []
    for (const key of sources) {
      if (key.provider !== "email") continue
      const account = await store.accounts.storedAccount(key).catch(() => undefined)
      if (!account) continue
      const threads = new Map<number, { members: Set<string>; subject: string | null; email: string }>()
      for (const { person, id } of await identitiesIn(store, people, "email")) {
        signal?.throwIfAborted()
        const emails = await store.mail.emails({
          accountId: account.id,
          participant: id,
          since: Date.parse(since),
          limit: READ_LIMIT,
        })
        for (const email of emails) {
          const held = threads.get(email.emailThreadId) ?? {
            members: new Set<string>(),
            subject: email.subject,
            email: email.externalId,
          }
          held.members.add(person)
          threads.set(email.emailThreadId, held)
        }
      }
      for (const [id, { members, subject, email }] of threads) {
        const thread = (await store.mail.thread(id))?.thread
        if (!thread) continue
        const named = names(thread.subject ?? subject) !== undefined
        const chat = formatReference({
          type: "chat",
          provider: "email",
          account: String(key.account),
          chat: thread.externalId,
        })
        const who = [...members].sort()
        found.push({
          from: chat,
          to: project.ref,
          kind: "member-of",
          weight: named ? NAMED : MEMBER_ONLY,
          why: `a thread with ${who.length > 1 ? `${who.length} members` : `a member (${who[0]})`}${named ? "; its subject names the project" : ""}`,
          evidence: [
            formatReference({
              type: "message",
              provider: "email",
              account: String(key.account),
              chat: thread.externalId,
              message: email,
            }),
            ...who,
          ].slice(0, 5),
        })
      }
    }
    return found
  },
}
