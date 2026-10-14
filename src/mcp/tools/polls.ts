import { CliError } from "@wirecat/cli-base"
import * as v from "valibot"
import { itemOf, listOf } from "../../cli/envelope.js"
import { listQuery, nativeTerms, queryArgument } from "../../cli/list-query.js"
import { pollVoteAnswer, snakeKeys } from "../../cli/messenger/chat-answers.js"
import type { Messenger } from "../../cli/messenger/context.js"
import { VOTERS_QUERY } from "../../cli/messenger/people-queries.js"
import { capability } from "../../cli/messenger/port.js"
import { closeAfterOf, guardedClose, guardedCreatePoll, guardedVote, pollVoters, quizOf } from "../../sends/polls.js"
import { type AnyTool, chatOf, limit, message, page, READ, tool, WRITE } from "../tool.js"

const answerId = v.pipe(v.string(), v.minLength(1), v.description("an answer id, as polls_show gives it"))

export const pollReadTools = (messenger: Messenger): Record<string, AnyTool> => ({
  ...(messenger.pollVoters
    ? {
        polls_voters: tool({
          title: "Who voted in a poll",
          description:
            "Who voted for what in a poll that is not anonymous, newest first: items [{ person_id, name, username, " +
            "answers, voted_at }]. query answers:<id> keeps those who chose that answer. Reading changes nothing.",
          input: v.object({ chat: chatOf(messenger), message, query: queryArgument(VOTERS_QUERY), limit, page }),
          annotations: { ...READ, idempotentHint: true },
          output: { entity: "poll_vote", list: true },
          online: async (adapter, args, defaults) => {
            const answer = nativeTerms(listQuery(args.query ?? "", VOTERS_QUERY, "polls voters"), "polls voters").get(
              "answers",
            )?.value
            const size = args.limit ?? defaults.limit
            const number = args.page ?? 1
            const found = await pollVoters(adapter, {
              chat: args.chat,
              message: args.message,
              limit: size * number,
              ...(answer === undefined ? {} : { answer }),
            })
            return listOf("polls voters", {
              items: found.items.slice((number - 1) * size).map(pollVoteAnswer),
              limit: size,
              has_more: found.hasMore,
              page: number,
              args: { chat: args.chat, message: args.message, ...(args.query ? { query: args.query } : {}) },
            })
          },
        }),
      }
    : {}),
  polls_show: tool({
    title: "Show a poll",
    description: "A poll as the message carries it now: its question, and each answer with the id a vote names.",
    input: v.object({ chat: chatOf(messenger), message }),
    annotations: { ...READ, idempotentHint: true },
    online: async (adapter, args) => {
      const poll = capability(adapter, "poll", "read a poll")
      return itemOf(snakeKeys(await poll((await adapter.resolve(args.chat)).id, args.message)))
    },
  }),
})

/** Offered with `--allow-send`, each under the permission its guard kind names. */
export const pollWriteTools = (messenger: Messenger): Record<string, AnyTool> => {
  const chat = chatOf(messenger)
  return {
    polls_vote: tool({
      title: "Vote in a poll",
      description:
        "Vote as the owner, by answer ids from polls_show; an empty list takes the vote back. The others see it " +
        "unless the poll is anonymous. Only when the owner asked for this vote.",
      input: v.object({ chat, message, answers: v.array(answerId) }),
      annotations: WRITE,
      permission: "reaction",
      online: async (adapter, args, { guard }) =>
        itemOf(
          snakeKeys(
            await guardedVote(guard, adapter, { chat: args.chat, message: args.message, answers: args.answers }),
          ),
        ),
    }),
    polls_close: tool({
      title: "Close a poll",
      description: "Close the owner's own poll; it cannot be reopened. Only when the owner asked for it.",
      input: v.object({ chat, message }),
      annotations: WRITE,
      permission: "edit",
      online: async (adapter, args, { guard }) =>
        itemOf(snakeKeys(await guardedClose(guard, adapter, { chat: args.chat, message: args.message }))),
    }),
    polls_create: tool({
      title: "Create a poll",
      description:
        "Send a poll as the owner: public unless anonymous is true. Only when the owner asked for this exact poll " +
        "in this exact chat. On outcome_unknown, retry with the send_id it returns, never a new one.",
      input: v.object({
        chat,
        text: v.pipe(v.string(), v.minLength(1), v.description("the question")),
        answers: v.pipe(v.array(v.pipe(v.string(), v.minLength(1))), v.minLength(2)),
        multiple: v.optional(v.boolean()),
        anonymous: v.optional(v.boolean()),
        revote: v.optional(v.pipe(v.boolean(), v.description("people may change their vote; without it they cannot"))),
        topic: v.optional(
          v.pipe(v.string(), v.minLength(1), v.description("the forum topic id; unsupported without topics")),
        ),
        send_as: v.optional(
          v.pipe(
            v.string(),
            v.minLength(1),
            v.description(
              "an id from chats_send_as to post as; required where the chat posts as someone else by default",
            ),
          ),
        ),
        send_id: v.optional(v.pipe(v.string(), v.minLength(1), v.description("from an earlier outcome_unknown"))),
        quiz: v.optional(
          v.pipe(
            v.boolean(),
            v.description("a quiz: one answer is right, and a vote is final; where the messenger makes them"),
          ),
        ),
        correct: v.optional(
          v.pipe(
            v.number(),
            v.integer(),
            v.minValue(1),
            v.description("with quiz: the right answer's position, from 1"),
          ),
        ),
        solution: v.optional(
          v.pipe(v.string(), v.minLength(1), v.description("with quiz: what people see once they answered")),
        ),
        close_time: v.optional(
          v.pipe(
            v.string(),
            v.minLength(1),
            v.description("it closes by itself this long after sending, like 90s or 5m; where the messenger can"),
          ),
        ),
      }),
      annotations: WRITE,
      permission: "send",
      online: async (adapter, args, { guard }) => {
        if (args.quiz === true && !messenger.pollQuiz)
          throw new CliError("validation_error", "this messenger makes no quizzes")
        const asQuiz = quizOf({
          ...(args.quiz === undefined ? {} : { quiz: args.quiz }),
          ...(args.correct === undefined ? {} : { correct: args.correct }),
          ...(args.solution === undefined ? {} : { solution: args.solution }),
        })
        const closeAfter = closeAfterOf(args.close_time, messenger.pollCloseSeconds)
        const sent = await guardedCreatePoll(guard, adapter, {
          chat: args.chat,
          poll: {
            question: args.text,
            answers: args.answers,
            multiple: args.multiple === true,
            anonymous: args.anonymous === true,
            revote: args.revote === true,
            ...(asQuiz === undefined ? {} : { quiz: asQuiz }),
            ...(closeAfter === undefined ? {} : { closeAfter }),
          },
          silent: false,
          ...(args.send_id === undefined ? {} : { sendId: args.send_id }),
          ...(args.topic === undefined ? {} : { threadId: args.topic }),
          ...(args.send_as === undefined ? {} : { sendAs: args.send_as }),
        })
        return itemOf(snakeKeys({ sendId: sent.sendId, operationId: sent.operationId, message: sent.message }))
      },
    }),
  }
}
