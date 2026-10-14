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
 * A send, forward or edit: the message as it now stands, with `operation_id` and, where a repeat could make a
 * second copy, the `send_id` that makes it safe. A scheduled message gets a new id when it goes out, so its
 * next step is the list that shows it, never a retry.
 */
export const writtenAnswer = ({ operationId, sendId, message, scheduledFor }: Written, reader: AccountKey) =>
  itemOf(
    {
      operation_id: operationId,
      ...(sendId === undefined ? {} : { send_id: sendId }),
      message: messageItem(message, reader),
      ...(scheduledFor === undefined ? {} : { scheduled_for: scheduledFor }),
    },
    scheduledFor === undefined ? {} : { next: [nextStep("messages.scheduled", { args: { chat: message.chatId } })] },
  )
