import type { Id, Message } from "../domain/models.js"

/**
 * 5: a message longer than a chunk is split into overlapping pieces. 6: a message's parent is always in its own
 * topic or thread, so a forum's topics are no longer one conversation. Builds before the current version are outdated.
 */
export const RULES_VERSION = 6

/** How far back a rule looks, in messages: 97% of reply parents sat within 50 in a measured group. */
export const LOOK_BACK = 50

// Tuned on the IRC dev split (bench/disentangle/sweep.ts); wider windows gained nothing.
const SAME_SENDER_WITHIN = 10
const SAME_SENDER_MS = 5 * 60_000

export type LinkInput = Pick<
  Message,
  "id" | "senderId" | "text" | "timestamp" | "replyToId" | "threadId" | "mentions"
> &
  Partial<Pick<Message, "senderName">>

export interface Link {
  messageId: Id
  parentId: Id
  source: "provider" | "rule"
  kind: "reply" | "mention" | "same_sender"
  confidence: number
  method: string
}

export interface Linked {
  links: Link[]
  /** Each message's chosen parent; `null` starts a conversation. */
  parents: Map<Id, Id | null>
  /** Message ids, each conversation oldest first, conversations in the order they started. */
  conversations: Id[][]
}

export interface LinkOptions {
  check?: () => void
  /** A handle as people type it, without `@` and lowercased, to the sender it names. */
  handles?: ReadonlyMap<string, Id>
  /**
   * The user's agent's current answer per message (phase 4): the earlier message it answers, or `null`
   * for "starts a conversation". Chosen after the messenger's reply and before any rule.
   */
  answers?: ReadonlyMap<Id, Id | null>
}

/**
 * Links each message to the earlier one it answers, from the messenger's replies and a few rules, and
 * groups the chosen parents into conversations. `messages` must be one chat, oldest first.
 */
export const linkMessages = (
  messages: Iterable<LinkInput>,
  { handles = new Map(), answers = new Map(), check }: LinkOptions = {},
): Linked => {
  const links: Link[] = []
  const parents = new Map<Id, Id | null>()
  const conversationOf = new Map<Id, number>()
  const threadOf = new Map<Id, Id | undefined>()
  const conversations: Id[][] = []
  const window: LinkInput[] = []

  for (const message of messages) {
    check?.()
    const found = [
      ...replyLink(message, threadOf),
      ...mentionLinks(message, window, handles),
      ...sameSenderLink(message, window),
    ]
    links.push(...found)
    const parent = choose(found, answers, message, threadOf)
    parents.set(message.id, parent)

    const conversation = parent === null ? conversations.length : (conversationOf.get(parent) as number)
    if (conversation === conversations.length) conversations.push([])
    conversations[conversation]?.push(message.id)
    conversationOf.set(message.id, conversation)
    threadOf.set(message.id, message.threadId)

    window.push(message)
    if (window.length > LOOK_BACK) window.shift()
  }
  return { links, parents, conversations }
}

/**
 * A reply into another topic or thread is no link. In a Telegram forum every message of a topic replies to the
 * topic's first message, which has no topic of its own: taken as a reply, it chained the whole topic, and through
 * that first message's sender, every topic, into one conversation.
 */
const replyLink = (message: LinkInput, threads: ReadonlyMap<Id, Id | undefined>): Link[] =>
  message.replyToId !== undefined && inThread(threads, message.replyToId, message)
    ? [link(message, message.replyToId, "provider", "reply", 1, "reply")]
    : []

const inThread = (threads: ReadonlyMap<Id, Id | undefined>, id: Id, message: LinkInput) =>
  threads.has(id) && threads.get(id) === message.threadId

const mentionLinks = (message: LinkInput, window: LinkInput[], handles: ReadonlyMap<string, Id>): Link[] => {
  const links: Link[] = []
  const people = new Set([...mentioned(message.text, handles)].flatMap((handle) => handles.get(handle) ?? []))
  for (const id of message.mentions ?? []) people.add(id)
  for (const sender of people) {
    if (sender === message.senderId) continue
    const target = latest(window, (candidate) => candidate.senderId === sender && sameThread(candidate, message))
    if (target) links.push(link(message, target.id, "rule", "mention", 0.8, "mention-v1"))
  }
  return links
}

const sameSenderLink = (message: LinkInput, window: LinkInput[]): Link[] => {
  if (message.senderId === null) return []
  const at = Date.parse(message.timestamp)
  const target = latest(
    window.slice(-SAME_SENDER_WITHIN),
    (candidate) =>
      candidate.senderId === message.senderId &&
      sameThread(candidate, message) &&
      at - Date.parse(candidate.timestamp) <= SAME_SENDER_MS,
  )
  return target ? [link(message, target.id, "rule", "same_sender", 0.5, "same-sender-v2")] : []
}

/** `@handle` anywhere, or a known handle opening the message as IRC and many groups address people: `ana: …`. */
const mentioned = (text: string, handles: ReadonlyMap<string, Id>): Set<string> => {
  const found = new Set<string>()
  for (const [, handle] of text.matchAll(/@([\p{L}\p{N}_]{2,})/gu)) if (handle) found.add(handle.toLowerCase())
  const opening = /^\s*([^\s:,]{2,})[:,]\s/u.exec(text)?.[1]?.toLowerCase()
  if (opening !== undefined && handles.has(opening)) found.add(opening)
  return found
}

/** The messenger's reply first, then the most confident rule; on a tie, the one found first. */
const choose = (
  links: Link[],
  answers: ReadonlyMap<Id, Id | null>,
  message: LinkInput,
  threads: ReadonlyMap<Id, Id | undefined>,
): Id | null => {
  const provider = links.find((one) => one.source === "provider")
  if (provider) return provider.parentId
  // An answer naming a message this chat no longer holds, a later one or one in another topic leaves the choice
  // to the rules.
  const answer = answers.get(message.id)
  if (answer === null) return null
  if (answer !== undefined && inThread(threads, answer, message)) return answer
  let best: Link | undefined
  for (const one of links) if (!best || one.confidence > best.confidence) best = one
  return best?.parentId ?? null
}

const latest = (window: LinkInput[], matches: (candidate: LinkInput) => boolean): LinkInput | undefined => {
  for (let index = window.length - 1; index >= 0; index--) {
    const candidate = window[index]
    if (candidate && matches(candidate)) return candidate
  }
  return undefined
}

const sameThread = (a: LinkInput, b: LinkInput) => a.threadId === b.threadId

const link = (
  message: LinkInput,
  parentId: Id,
  source: Link["source"],
  kind: Link["kind"],
  confidence: number,
  method: string,
): Link => ({ messageId: message.id, parentId, source, kind, confidence, method })
