import type { Id, Message } from "../domain/models.js"

/** A shared link's query string is not a question. */
const LINKS = /https?:\/\/\S+/g

/**
 * Questions from others still waiting, as max-cli counts them. A question is a message with `?` in
 * it, or a reply to the owner or an admin. It is answered when one of them replied to it, or was the
 * next to speak after the person who asked — "the next to speak" rather than "spoke later", because
 * in a busy group an admin answering somebody else says nothing about this question.
 */
export const unanswered = (
  messages: Message[],
  { answerers, before }: { answerers: ReadonlySet<Id>; before: number },
): Message[] =>
  questions(messages, { answerers })
    .filter(({ question, answer }) => answer === undefined && Date.parse(question.timestamp) < before)
    .map(({ question }) => question)

/**
 * Every question from others, as `unanswered` reads them, with the message that answered it, if one did.
 * With `asker: "owner"` it is the owner's own questions instead, and anyone but the owner answers: by replying to
 * it, or by speaking next. `answerers` is not read then.
 */
export const questions = (
  messages: Message[],
  { answerers, asker = "others" }: { answerers: ReadonlySet<Id>; asker?: "others" | "owner" },
): { question: Message; answer?: Message }[] => {
  const fromOwner = (message: Message) => message.outgoing === true
  const answers =
    asker === "owner"
      ? (message: Message) => !fromOwner(message)
      : (message: Message) => fromOwner(message) || (message.senderId !== null && answerers.has(message.senderId))
  const byId = new Map(messages.map((message) => [message.id, message]))
  // Telegram names only the id a reply answers; the message itself is found in the window, or not at all.
  const repliesToAnswerer = (message: Message) => {
    if (asker === "owner") return false
    const to = message.replyTo?.id ?? message.replyToId
    const quoted = to === undefined ? undefined : byId.get(to)
    if (quoted) return answers(quoted)
    return (
      message.replyTo !== null && (message.replyTo.outgoing === true || answerers.has(message.replyTo.senderId ?? ""))
    )
  }

  return messages.flatMap((message, index) => {
    if (asker === "owner" ? !fromOwner(message) : answers(message)) return []
    const transcript = "transcript" in message && typeof message.transcript === "string" ? message.transcript : ""
    if (![message.text, transcript].join("\n").replace(LINKS, "").includes("?") && !repliesToAnswerer(message))
      return []
    const later = messages.slice(index + 1)
    const reply = later.find((one) => (one.replyTo?.id ?? one.replyToId) === message.id && answers(one))
    const next = later.find((other) => other.senderId !== message.senderId)
    const answer = [reply, next && answers(next) ? next : undefined]
      .filter((one) => one !== undefined)
      .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp))[0]
    return [{ question: message, ...(answer ? { answer } : {}) }]
  })
}
