import type { Id, Message } from "../../../domain/models.js"
import { AGENDA_DEFAULTS } from "../../agenda.js"
import { evidenceOf, fromOwner, whoOf } from "../items.js"
import type { StatusChat, StatusSignal } from "../types.js"

export interface ReplyNextData {
  next: "owner" | "them" | "named" | "nobody"
  /** Since when the one named has been the one to answer. */
  waitingSince: string | null
  /** In a group: the person the newest message replies to or mentions. */
  addressed: { ref: string | null; name: string | null } | null
  /** Waited longer than `tasks agenda` does before it lists the chat (a day for you, a week for them). */
  overdue: boolean
}

interface Target {
  owner: boolean
  id: Id | null
  name: string | null
}

/** Whom a message answers or names: the quoted message's sender first, then the first mention. */
const targetOf = (message: Message, chat: StatusChat, owners: ReadonlySet<Id>): Target | undefined => {
  const byId = (id: Id) => chat.messages.find((one) => one.id === id)
  const quoted = message.replyTo ?? (message.replyToId === undefined ? undefined : byId(message.replyToId))
  if (quoted)
    return {
      owner: quoted.outgoing === true || (quoted.senderId !== null && owners.has(quoted.senderId)),
      id: quoted.senderId,
      name: quoted.senderName,
    }
  const [mentioned] = message.mentions ?? []
  if (mentioned === undefined) return undefined
  if (owners.has(mentioned)) return { owner: true, id: mentioned, name: null }
  const named = chat.messages.find((one) => one.senderId === mentioned)
  return { owner: false, id: mentioned, name: named?.senderName ?? null }
}

const asksSomething = (message: Message) => message.text.includes("?")

/**
 * Whose move it is, by five rules in order: the owner wrote last → them; a dialog → the owner; in a group a message
 * that replies to or mentions the owner, or a question right after the owner spoke → the owner; one that names
 * another member → that member; else nobody. A name typed without a mention is not seen.
 */
export const replyNext: StatusSignal<ReplyNextData> = {
  id: "reply-next",
  version: 1,
  scope: "chat",
  read: async (context, chat) => {
    const last = chat?.messages.at(-1)
    if (!chat || !last) return []
    const { messages } = chat
    const owners = new Set(messages.flatMap((one) => (fromOwner(one) && one.senderId !== null ? [one.senderId] : [])))
    const lastOwn = messages.findLastIndex(fromOwner)
    const firstAfterOwn = messages[lastOwn + 1] ?? messages[0]
    const target = targetOf(last, chat, owners)
    const decide = (): Pick<ReplyNextData, "next" | "addressed"> & { since: string | null } => {
      if (last.outgoing === null) return { next: "nobody", addressed: null, since: null }
      if (fromOwner(last))
        return {
          next: "them",
          addressed: chat.kind !== "dialog" && target && !target.owner ? { ref: null, name: target.name } : null,
          since: last.timestamp,
        }
      const since = firstAfterOwn?.timestamp ?? last.timestamp
      if (chat.kind === "dialog") return { next: "owner", addressed: null, since }
      if (target?.owner || (asksSomething(last) && lastOwn === messages.length - 2))
        return { next: "owner", addressed: null, since }
      if (target) return { next: "named", addressed: { ref: null, name: target.name }, since }
      return { next: "nobody", addressed: null, since }
    }
    const { next, addressed, since } = decide()
    const waited = since === null ? 0 : context.now - Date.parse(since)
    const overdue =
      (next === "owner" && waited >= AGENDA_DEFAULTS.unanswered) ||
      (next === "them" && waited >= AGENDA_DEFAULTS.waiting)
    return [
      {
        signal: "reply-next",
        chat: chat.ref,
        at: last.timestamp,
        who: whoOf(last),
        evidence: evidenceOf(chat, last),
        basis: "store",
        data: { next, waitingSince: since, addressed, overdue },
      },
    ]
  },
  attention: (items) =>
    items.flatMap((item) =>
      item.chat !== null && item.data.next === "owner" ? [{ chat: item.chat, weight: 2, why: "your move" }] : [],
    ),
}
