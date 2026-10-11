import { CliError } from "@wirecat/cli-base"
import { annotate } from "@wirecat/cli-base/commands"
import { Command } from "commander"
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
import { positiveCount } from "../paging.js"
import { type Messenger, messengerContext } from "./context.js"
import { capability } from "./port.js"
import { threadIdOf } from "./thread.js"

/**
 * `polls show|vote|close|create`. An answer is named by its id, as `polls show` prints it — never by
 * position, which changes nothing for a person and everything for a vote.
 */
export const pollsCommand = (messenger: Messenger): Command => {
  const polls = new Command("polls").description("read a poll, vote in it, close your own, create one")

  polls
    .command("show")
    .description("a poll and its answer ids, as the message carries it now")
    .argument("<chat>", messenger.chatArgument)
    .argument("<message>", "the id of the message that carries the poll")
    .action(async function (this: Command, chat: string, message: string) {
      const context = messengerContext(this, messenger)
      context.renderer.result(
        await context.withMessenger(async (connection) => {
          const poll = capability(connection, "poll", "read a poll")
          return poll((await connection.resolve(chat)).id, message.trim())
        }),
      )
    })

  if (messenger.pollVoters)
    polls
      .command("voters")
      .description("who voted for what, newest first; not in an anonymous poll")
      .argument("<chat>", messenger.chatArgument)
      .argument("<message>", "the id of the message that carries the poll")
      .option("--answer <id>", "only those who chose this answer, as `polls show` prints it")
      .option("--limit <n>", "how many", positiveCount("--limit"))
      .action(async function (this: Command, chat: string, message: string) {
        const context = messengerContext(this, messenger)
        const { answer } = this.opts<{ answer?: string }>()
        const { limit } = context.settings
        const found = await context.withMessenger((connection) =>
          pollVoters(connection, {
            chat,
            message: message.trim(),
            limit,
            ...(answer === undefined ? {} : { answer: answer.trim() }),
          }),
        )
        if (context.format === "json") context.renderer.result(found)
        else context.renderer.stream(found.items)
        if (found.hasMore) context.renderer.note(`more voters: raise --limit above ${limit}`)
      })

  annotate(polls.command("vote"), { mutates: true })
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
      context.renderer.result(
        await context.withMessenger((connection) =>
          guardedVote(context.guard, connection, {
            chat,
            message: message.trim(),
            answers: answers.map((a) => a.trim()),
          }),
        ),
      )
    })

  annotate(polls.command("close"), { mutates: true })
    .description("close your own poll; nobody can vote after that, and it cannot be reopened")
    .argument("<chat>", messenger.chatArgument)
    .argument("<message>", "the id of your own message that carries the poll")
    .action(async function (this: Command, chat: string, message: string) {
      const context = messengerContext(this, messenger)
      context.renderer.result(
        await context.withMessenger((connection) =>
          guardedClose(context.guard, connection, { chat, message: message.trim() }),
        ),
      )
    })

  const create = annotate(polls.command("create"), { mutates: true })
    .description("send a poll to a chat, as a message of its own; public unless --anonymous")
    .argument("<chat>", messenger.chatArgument)
    .argument("<question>", "the question")
    .argument("<answers...>", "two answers or more")
    .option("--topic <id>", "send to this forum topic; unsupported by messengers without topics")
    .option("--multiple", "people may pick several answers")
    .option("--anonymous", "nobody sees who voted for what")
    .option("--revote", "people may change their vote")
    .option("--silent", "send without a notification")
    .option(
      "--send-as <id>",
      "post as one of the identities `chats send-as` lists; required where the chat posts as someone else by default",
    )
    .option("--send-id <id>", "repeat a create whose outcome was unknown, without risking a second poll")
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
      sendId,
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
      sendId?: string
    }>()
    const threadId = threadIdOf(topic)
    const sendAs = typedSendAs(given)
    const asQuiz = quizOf({ quiz, correct, solution })
    const closeAfter = closeAfterOf(closeTime, messenger.pollCloseSeconds)
    const sent = await context.withMessenger((connection) =>
      guardedCreatePoll(context.guard, connection, {
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
    )
    context.renderer.result({ sendId: sent.sendId, operationId: sent.operationId, message: sent.message })
  })

  return polls
}
