import { CliError } from "@wirecat/cli-base"
import { threadIdOf } from "../cli/messenger/thread.js"
import type { Id, Page, Poll, PollVote } from "../domain/models.js"
import type { MessengerAdapter, NewPoll, Sent } from "../ports/messenger.js"
import { capability } from "../ports/messenger.js"
import type { SendGuard } from "./guard.js"
import { guardedWrite, type Operated } from "./guarded.js"
import { sendAsCheck } from "./send-as.js"
import { newOperationId, newSendId } from "./send-id.js"

/** The poll is read first: nobody, the owner included, may see who voted in an anonymous one. */
export const pollVoters = async (
  connection: MessengerAdapter,
  { chat, message, answer, limit }: { chat: string; message: string; answer?: Id; limit: number },
): Promise<Page<PollVote> & { chatId: Id; messageId: Id; total: number }> => {
  const voters = capability(connection, "pollVoters", "list who voted")
  const read = capability(connection, "poll", "read a poll")
  const { id: chatId } = await connection.resolve(chat)
  const poll = await read(chatId, message)
  if (poll.anonymous) throw new CliError("validation_error", "nobody can see who voted in an anonymous poll")
  if (answer !== undefined && !poll.answers.some((one) => one.id === answer))
    throw new CliError("validation_error", `the poll has no answer ${answer}; \`polls show\` prints their ids`)
  const page = await voters(chatId, message, { limit, ...(answer === undefined ? {} : { answerId: answer }) })
  return { chatId, messageId: message, ...page }
}

/** A vote is shown to the others like a reaction, and counts toward nothing. */
export const guardedVote = async (
  guard: SendGuard,
  connection: MessengerAdapter,
  { chat, message, answers }: { chat: string; message: string; answers: Id[] },
): Promise<Operated<{ poll: Poll }>> => {
  const vote = capability(connection, "vote", "vote in a poll")
  const { id: chatId } = await connection.resolve(chat)
  const operationId = newOperationId()
  const poll = await guardedWrite(
    guard,
    { operationId, chatId, kind: "reaction", messageId: message, key: "polls.vote" },
    () => vote(chatId, message, answers),
  )
  return { operationId, poll }
}

/** Closing changes the owner's own message for everyone in the chat, like an edit. */
export const guardedClose = async (
  guard: SendGuard,
  connection: MessengerAdapter,
  { chat, message }: { chat: string; message: string },
): Promise<Operated<{ poll: Poll }>> => {
  const close = capability(connection, "closePoll", "close a poll")
  const { id: chatId } = await connection.resolve(chat)
  const operationId = newOperationId()
  const poll = await guardedWrite(
    guard,
    { operationId, chatId, kind: "edit", messageId: message, key: "polls.close" },
    () => close(chatId, message),
  )
  return { operationId, poll }
}

/** A new poll is a new message: the recipient list and the hourly limit apply, and a send id makes a retry safe. */
export const guardedCreatePoll = async (
  guard: SendGuard,
  connection: MessengerAdapter,
  {
    chat,
    poll,
    silent,
    sendId,
    threadId: typedThread,
    sendAs,
  }: { chat: string; poll: NewPoll; silent: boolean; sendId?: string; threadId?: Id; sendAs?: Id },
): Promise<Operated<Sent>> => {
  if (poll.answers.length < 2) throw new CliError("validation_error", "a poll needs two answers or more")
  if (poll.quiz) {
    const { correct } = poll.quiz
    if (!Number.isInteger(correct) || correct < 0 || correct >= poll.answers.length)
      throw new CliError("validation_error", `--correct takes an answer's position, 1 to ${poll.answers.length}`)
    if (poll.multiple || poll.revote)
      throw new CliError("validation_error", "a quiz takes one final answer; not with --multiple or --revote")
  }
  const threadId = threadIdOf(typedThread)
  const validate =
    threadId === undefined ? undefined : capability(connection, "validateThread", "send to a forum topic")
  const create = capability(connection, "createPoll", "create a poll")
  const checkSendAs = sendAsCheck(connection, sendAs)
  const { id: chatId } = await connection.resolve(chat)
  await checkSendAs(chatId)
  const id = sendId ?? connection.newSendId?.() ?? newSendId()
  const sent = await guardedWrite(
    guard,
    {
      chatId,
      kind: "message",
      sendId: id,
      operationId: id,
      length: poll.question.length,
      key: "polls.create",
      ...(threadId === undefined ? {} : { threadId }),
      ...(sendAs === undefined ? {} : { sendAs }),
    },
    () =>
      create(chatId, poll, {
        sendId: id,
        ...(silent ? { silent } : {}),
        ...(threadId === undefined ? {} : { threadId }),
        ...(sendAs === undefined ? {} : { sendAs }),
      }),
    (done) => ({ messageId: done.message.id }),
    validate === undefined || threadId === undefined ? undefined : () => validate(chatId, threadId, {}),
  )
  return { ...sent, operationId: id }
}

/** `--quiz --correct <n> --solution <text>` as typed, `n` from 1; refused when they do not go together. */
export const quizOf = ({
  quiz,
  correct,
  solution,
}: {
  quiz?: boolean
  correct?: number
  solution?: string
}): NewPoll["quiz"] => {
  if (quiz !== true) {
    if (correct !== undefined || solution !== undefined)
      throw new CliError("validation_error", "--correct and --solution go with --quiz")
    return undefined
  }
  if (correct === undefined)
    throw new CliError("validation_error", "a quiz needs --correct <n>, the right answer's position")
  return { correct: correct - 1, ...(solution === undefined ? {} : { solution }) }
}

const seconds = (n: number) => (n % 60 === 0 ? `${n / 60}m` : `${n}s`)

export const closeRange = ([min, max]: readonly [number, number]) => `${seconds(min)} to ${seconds(max)}`

/** A delay like `90s` or `5m`, in seconds, inside the messenger's range. */
export const closeAfterOf = (value: string | undefined, range: readonly [number, number] | undefined) => {
  if (value === undefined) return undefined
  if (range === undefined) throw new CliError("validation_error", "this messenger cannot close a poll by itself")
  const [, amount, unit] = /^(\d+)(s|m)$/.exec(value.trim()) ?? []
  const after = Number(amount) * (unit === "m" ? 60 : 1)
  const [min, max] = range
  if (!amount || after < min || after > max)
    throw new CliError(
      "validation_error",
      `--close-time takes a delay from ${closeRange(range)}, like 90s or 5m — not "${value}"`,
    )
  return after
}
