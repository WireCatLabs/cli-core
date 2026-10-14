import { CliError, isCliError } from "@wirecat/cli-base"
import type { Message } from "../../domain/models.js"
import type { AccountKey } from "../../store/store.js"
import { itemOf } from "../envelope.js"
import { nextStep } from "../steps.js"
import { messageItem } from "./message-items.js"

interface Written {
  operationId: string
  sendId?: string
  message: Message
  scheduledFor?: string
}

/**
 * A send, forward or edit: the message as it now stands, with its `operation_id` — for a send, the id a repeat
 * passes as `--operation-id` so it cannot make a second copy. A scheduled message gets a new id when it goes out,
 * so its next step is the list that shows it, never a retry.
 */
export const writtenAnswer = ({ operationId, sendId, message, scheduledFor }: Written, reader: AccountKey) =>
  itemOf(
    {
      operation_id: sendId ?? operationId,
      message: messageItem(message, reader),
      ...(scheduledFor === undefined ? {} : { scheduled_for: scheduledFor }),
    },
    scheduledFor === undefined ? {} : { next: [nextStep("messages.scheduled", { args: { chat: message.chatId } })] },
  )

/**
 * What runs after a write went out. A failure there keeps the write's `operation_id` and says not to retry: an
 * agent that repeats a "failed" send without its `--operation-id` sends it to the person twice.
 */
export const afterWrite = async <T>(
  { operationId, sendId }: Pick<Written, "operationId" | "sendId">,
  work: () => T | Promise<T>,
): Promise<T> => {
  try {
    return await work()
  } catch (error) {
    const ids = { operation_id: sendId ?? operationId, retryable: false }
    throw isCliError(error)
      ? new CliError(error.code, error.message, { ...error.details, ...ids })
      : new CliError("invalid_response", "the write went through, but its answer could not be built", ids)
  }
}
