import { formatReference, parseReference } from "../../domain/references.js"
import { contactRef, personRefOf, sameAccount } from "./shared.js"
import type { LinkCandidate, LinkScorer } from "./types.js"

const WEIGHT = 0.5
const LARGE_GROUP_WEIGHT = 0.2
const LARGE_GROUP = 30
const SMALL_CHAT = 10
const MIN_MESSAGES = 5
const READ_LIMIT = 2000
const TITLE_WIDTH = 60

const named = (title: string | null, chat: string) => {
  const flat = (title ?? "").replace(/\s+/gu, " ").trim()
  if (!flat) return chat
  return `«${flat.length > TITLE_WIDTH ? `${flat.slice(0, TITLE_WIDTH - 1)}…` : flat}»`
}

/**
 * A person who wrote 5 or more messages in the window in one of the project's confirmed chats, or any in a dialog or a
 * group of 10 people or fewer, found by the sender's identity, never by the name a message shows. In a group of more
 * than 30 people writing there says less. The reason names the chat and its size, and the evidence leads with the chat,
 * so the owner can find and decide one group's senders together (`memo review list via:<chat>`).
 */
export const chatSenders: LinkScorer = {
  id: "chat-senders",
  version: 3,
  spreads: true,
  candidates: async ({ store, project, confirmed, sources, since, owner, signal }) => {
    if (!project) return []
    const found: LinkCandidate[] = []
    for (const chat of confirmed.chats) {
      const reference = parseReference(chat)
      if (reference.type !== "chat") continue
      const key = sources.find((source) => sameAccount(source, reference))
      if (!key) continue
      signal?.throwIfAborted()
      const page = await store.messages.messages(key, reference.chat, { limit: READ_LIMIT, since, outgoing: false })
      const senders = new Map<string, { count: number; last: string }>()
      for (const message of page.items) {
        if (message.senderId === null || message.senderIsChat) continue
        const id = String(message.senderId)
        senders.set(id, { count: (senders.get(id)?.count ?? 0) + 1, last: String(message.id) })
      }
      const size = Math.max((await store.roster.members(key, reference.chat)).length, senders.size)
      const weight = size > LARGE_GROUP ? LARGE_GROUP_WEIGHT : WEIGHT
      const where = named(await store.chats.chatTitle(key, reference.chat), chat)
      for (const [id, { count, last }] of senders) {
        if (size > SMALL_CHAT && count < MIN_MESSAGES) continue
        const person = await personRefOf(store, key.provider, id)
        if (!person || person === owner) continue
        found.push({
          from: person,
          to: project.ref,
          kind: "member-of",
          weight,
          why: `wrote ${count} message${count === 1 ? "" : "s"} in ${where} (${size} people) since ${since.slice(0, 10)}`,
          evidence: [chat, formatReference({ ...reference, type: "message", message: last })],
          identity: contactRef(key.provider, id),
        })
      }
    }
    return found
  },
}
