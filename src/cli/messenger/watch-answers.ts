import type * as v from "valibot"
import type { CounterObservation } from "../../domain/counters.js"
import type { MessageEvent, MessageHit } from "../../domain/models.js"
import type { messageEvent, watchedMessage } from "../../entities/listener.js"
import type { AccountKey } from "../../store/store.js"
import { chatEventAnswer, memberAnswer, pollVoteAnswer } from "./chat-answers.js"
import { messageItem } from "./message-items.js"

const observed = (value: CounterObservation) => ({
  value: value.value,
  observed_at: value.observedAt,
  source: value.source,
  ...(value.reactions === undefined ? {} : { reactions: value.reactions }),
})
export const watchedMessageItem = (value: MessageHit, account: AccountKey): v.InferOutput<typeof watchedMessage> => {
  const counters = value.counterObservations
  return {
    ...messageItem(value, account),
    ...(value.starred === undefined ? {} : { starred: value.starred }),
    ...(counters === undefined
      ? {}
      : {
          counter_observations: {
            ...(counters.views === undefined ? {} : { views: observed(counters.views) }),
            ...(counters.reactions === undefined ? {} : { reactions: observed(counters.reactions) }),
            ...(counters.comments === undefined ? {} : { comments: observed(counters.comments) }),
          },
        }),
  }
}
const affected = (value: { chatId: string; chatTitle: string | null; messageId: string }) => ({
  chat_id: value.chatId,
  chat_title: value.chatTitle,
  message_id: value.messageId,
})
export const watchEventItem = (value: MessageEvent, account: AccountKey): v.InferOutput<typeof messageEvent> => {
  switch (value.event) {
    case "message":
    case "edit":
      return { event: value.event, message: watchedMessageItem(value.message, account) }
    case "delete":
      return { event: value.event, chat_id: value.chatId, chat_title: value.chatTitle, message_id: value.messageId }
    case "reaction":
      return {
        event: value.event,
        ...affected(value),
        reactions: value.reactions,
        ...(value.counterObservation === undefined ? {} : { counter_observation: observed(value.counterObservation) }),
      }
    case "vote":
      return { event: value.event, ...affected(value), vote: pollVoteAnswer(value.vote) }
    case "person_reaction":
      return {
        event: value.event,
        ...affected(value),
        reaction: {
          person: memberAnswer(value.reaction.person),
          own: value.reaction.own,
          reaction: value.reaction.reaction,
          reacted_at: value.reaction.reactedAt,
        },
      }
    case "star":
      return { event: value.event, ...affected(value), starred: value.starred }
    case "delivery":
      return { event: value.event, ...affected(value), delivery: value.delivery, at: value.at }
    case "chat_event":
      return {
        event: value.event,
        chat_id: value.chatId,
        chat_title: value.chatTitle,
        change: chatEventAnswer(value.chatId, value.change),
      }
  }
}
