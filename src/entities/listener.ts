import * as v from "valibot"
import { chatEvent } from "./chat-event.js"
import { count, id, text, time } from "./fields.js"
import { member } from "./member.js"
import { message } from "./message.js"
import { pollVote } from "./poll-vote.js"

const reactions = v.unwrap(v.unwrap(message.entries.reactions))
const observation = v.strictObject({
  value: v.pipe(v.number(), v.minValue(0)),
  observed_at: time,
  source: v.picklist(["remote_fetch", "remote_update"]),
  reactions: v.optional(reactions),
})
/** Live messages retain counter observations and an explicit false star when the source supplies them. */
export const watchedMessage = v.strictObject({
  ...message.entries,
  starred: v.optional(v.boolean()),
  counter_observations: v.optional(
    v.partial(v.strictObject({ views: observation, reactions: observation, comments: observation })),
  ),
})
const target = { chat_id: id, chat_title: v.nullable(text), message_id: id }
export const messageEvent = v.variant("event", [
  v.strictObject({ event: v.picklist(["message", "edit"]), message: watchedMessage }),
  v.strictObject({ event: v.literal("delete"), ...target, chat_id: v.nullable(id) }),
  v.strictObject({ event: v.literal("reaction"), ...target, reactions, counter_observation: v.optional(observation) }),
  v.strictObject({ event: v.literal("vote"), ...target, vote: pollVote }),
  v.strictObject({
    event: v.literal("person_reaction"),
    ...target,
    reaction: v.strictObject({ person: member, own: v.boolean(), reaction: v.nullable(text), reacted_at: time }),
  }),
  v.strictObject({ event: v.literal("star"), ...target, starred: v.boolean() }),
  v.strictObject({ event: v.literal("delivery"), ...target, delivery: v.unwrap(message.entries.delivery), at: time }),
  v.strictObject({ event: v.literal("chat_event"), chat_id: id, chat_title: v.nullable(text), change: chatEvent }),
])
export const watchItem = v.union([watchedMessage, messageEvent])
const totals = v.record(text, count)
export const serveSummary = v.strictObject({
  profile: text,
  started_at: time,
  stopped_at: time,
  kept: totals,
  replies: v.optional(v.strictObject({ sent: totals, skipped: totals, tasks: v.optional(totals) })),
  members: v.optional(v.strictObject({ fetched: count, failed: count })),
  stems: v.optional(v.strictObject({ stemmed: count })),
  tasks: v.optional(v.strictObject({ added: count, closed: count, review: count })),
})
