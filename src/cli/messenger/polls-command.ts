import { CliError } from "@wirecat/cli-base"
import { annotate } from "@wirecat/cli-base/commands"
import { Command } from "commander"
import { threadIdOf } from "../../domain/thread.js"
import { capability } from "../../ports/messenger.js"
import {
  closeAfterOf,
  closeRange,
  guardedClose,
  guardedCreatePoll,
  guardedVote,
  pollVoters,
  quizOf,
} from "../../sends/polls.js"
import { typedSendAs } from "../../sends/send-as.js"
import { REMOTE_READ, REMOTE_WRITE } from "../effects.js"
import { itemOf, listOf, renderAnswer, snakeKeys } from "../envelope.js"
import { listQuery, nativeTerms, typedQuery, withQuery } from "../list-query.js"
import { positiveCount } from "../paging.js"
import { lines, pollVoteAnswer } from "./chat-answers.js"
import { type Messenger, messengerContext } from "./context.js"
import { selfOf } from "./message-items.js"
import { afterWrite, writtenAnswer } from "./message-writes.js"
import { VOTERS_QUERY } from "./people-queries.js"

/**
 * `polls show|vote|close|create`. An answer is named by its id, as `polls show` prints it — never by
 * position, which changes nothing for a person and everything for a vote.
 */
export const pollsCommand = (messenger: Messenger): Command => {
  const polls = new Command("polls").description("read a poll, vote in it, close your own, create one")

  annotate(polls.command("show"), { effects: REMOTE_READ })
    .description("a poll and its answer ids, as the message carries it now")
    .argument("<chat>", messenger.chatArgument)
    .argument("<message>", "the id of the message that carries the poll")
    .action(async function (this: Command, chat: string, message: string) {
      const context = messengerContext(this, messenger)
      const poll = await context.withMessenger(async (connection) => {
        const read = capability(connection, "poll", "read a poll")
        return read((await connection.resolve(chat)).id, message.trim())
      })
      renderAnswer(this, context, itemOf(snakeKeys(poll)))
    })

  if (messenger.pollVoters)
    polls.addCommand(
      withQuery(
        annotate(
          annotate(new Command("voters"), { effects: REMOTE_READ })
            .description("who voted for what, newest first; not in an anonymous poll")
            .argument("<chat>", messenger.chatArgument)
            .argument("<message>", "the id of the message that carries the poll")
            .option("--limit <n>", "how many to show", positiveCount("--limit"))
            .option("--page <n>", "which page, starting at 1", positiveCount("--page")),
          { output: { entity: "poll_vote" } },
        ),
        VOTERS_QUERY,
      ).action(async function (this: Command, chat: string, message: string, words: string[]) {
        const answer = nativeTerms(listQuery(typedQuery(words), VOTERS_QUERY, "polls voters"), "polls voters").get(
          "answers",
        )?.value
        const context = messengerContext(this, messenger)
        const { limit, page } = context.settings
        const found = await context.withMessenger((connection) =>
          pollVoters(connection, {
            chat,
            message: message.trim(),
            limit: limit * page,
            ...(answer === undefined ? {} : { answer: answer.trim() }),
          }),
        )
        renderAnswer(
          this,
          context,
          listOf("polls voters", {
            items: found.items.slice((page - 1) * limit).map(pollVoteAnswer),
            limit,
            has_more: found.hasMore,
            page,
            args: { chat, message, ...(words.length > 0 ? { query: words.join(" ") } : {}) },
          }),
          lines(({ voted_at, person_id, name, answers }) =>
            [voted_at, name ?? person_id, answers.join(",")].join("  "),
          ),
        )
      }),
    )

  annotate(polls.command("vote"), { effects: REMOTE_WRITE })
    .description("vote in a poll, or take your vote back; the others see it unless the poll is anonymous")
    .argument("<chat>", messenger.chatArgument)
    .argument("<message>", "the id of the message that carries the poll")
    .argument("[answers...]", "answer ids, as `polls show` prints them")
    .option("--retract", "take your vote back")
    .action(async function (this: Command, chat: string, message: string, answers: string[]) {
      const context = messengerContext(this, messenger)
      const { retract } = this.opts<{ retract?: boolean }>()
      if (retract && answers.length > 0) {
        throw new CliError("validation_error", "`--retract` takes no answers: it removes the vote you have")
      }
      if (!retract && answers.length === 0) {
        throw new CliError(
          "validation_error",
          "name at least one answer id (`polls show` prints them), or pass --retract",
        )
      }
      const voted = await context.withMessenger((connection) =>
        guardedVote(context.guard, connection, {
          chat,
          message: message.trim(),
          answers: answers.map((a) => a.trim()),
        }),
      )
      renderAnswer(this, context, itemOf(snakeKeys(voted)))
    })

  annotate(polls.command("close"), { effects: REMOTE_WRITE })
    .description("close your own poll; nobody can vote after that, and it cannot be reopened")
    .argument("<chat>", messenger.chatArgument)
    .argument("<message>", "the id of your own message that carries the poll")
    .action(async function (this: Command, chat: string, message: string) {
      const context = messengerContext(this, messenger)
      const closed = await context.withMessenger((connection) =>
        guardedClose(context.guard, connection, { chat, message: message.trim() }),
      )
      renderAnswer(this, context, itemOf(snakeKeys(closed)))
    })

  const create = annotate(polls.command("create"), { effects: REMOTE_WRITE })
    .description("send a poll to a chat, as a message of its own; public unless --anonymous")
    .argument("<chat>", messenger.chatArgument)
    .argument("<question>", "the question")
    .argument("<answers...>", "two answers or more")
  if (messenger.topics !== false) create.option("--topic <id>", "send to this forum topic")
  create
    .option("--multiple", "people may pick several answers")
    .option("--anonymous", "nobody sees who voted for what")
    .option("--revote", "people may change their vote")
    .option("--silent", "send without a notification")
    .option(
      "--send-as <id>",
      "post as one of the identities `chats send-as` lists; required where the chat posts as someone else by default",
    )
    .option("--operation-id <id>", "repeat a create whose outcome was unknown, without risking a second poll")
  if (messenger.pollQuiz)
    create
      .option("--quiz", "a quiz: one answer is right, and a vote is final")
      .option("--correct <n>", "with --quiz: the right answer's position, from 1", positiveCount("--correct"))
      .option("--solution <text>", "with --quiz: what people see once they answered")
  if (messenger.pollCloseSeconds)
    create.option(
      "--close-time <delay>",
      `it closes by itself this long after sending: ${closeRange(messenger.pollCloseSeconds)}, like 90s or 5m`,
    )
  create.action(async function (this: Command, chat: string, question: string, answers: string[]) {
    const context = messengerContext(this, messenger)
    const {
      multiple,
      anonymous,
      revote,
      silent,
      operationId: sendId,
      topic,
      sendAs: given,
      quiz,
      correct,
      solution,
      closeTime,
    } = this.opts<{
      closeTime?: string
      quiz?: boolean
      correct?: number
      solution?: string
      sendAs?: string
      topic?: string
      multiple?: boolean
      anonymous?: boolean
      revote?: boolean
      silent?: boolean
      operationId?: string
    }>()
    const threadId = threadIdOf(topic)
    const sendAs = typedSendAs(given)
    const asQuiz = quizOf({ quiz, correct, solution })
    const closeAfter = closeAfterOf(closeTime, messenger.pollCloseSeconds)
    const { sent, reader } = await context.withMessenger(async (connection) => {
      const reader = selfOf(messenger, connection)
      return {
        sent: await guardedCreatePoll(context.guard, connection, {
          chat,
          ...(threadId === undefined ? {} : { threadId }),
          poll: {
            question,
            answers,
            multiple: multiple === true,
            anonymous: anonymous === true,
            revote: revote === true,
            ...(asQuiz === undefined ? {} : { quiz: asQuiz }),
            ...(closeAfter === undefined ? {} : { closeAfter }),
          },
          silent: silent === true,
          ...(sendId === undefined ? {} : { sendId }),
          ...(sendAs === undefined ? {} : { sendAs }),
        }),
        reader,
      }
    })
    await afterWrite(sent, () => renderAnswer(this, context, writtenAnswer(sent, reader)))
  })

  return polls
}
