import * as v from "valibot"
import { itemOf, snakeKeys } from "../../cli/envelope.js"
import type { Messenger } from "../../cli/messenger/context.js"
import { selfOf } from "../../cli/messenger/message-items.js"
import { writtenAnswer } from "../../cli/messenger/message-writes.js"
import { pinDurationOf, pinLengthHelp } from "../../domain/pin-duration.js"
import type { MessengerAdapter } from "../../ports/messenger.js"
import type { SendGuard } from "../../sends/guard.js"
import { onlineDeps, servicesFor } from "../../services/index.js"
import { type AnyTool, chatOf, message, tool, WRITE } from "../tool.js"
import { HTML_TOOL_HELP } from "./messages-send.js"

/** What changes a message others already have, offered by the profile's permissions, each behind its own `allow` permission. */
export const messageActionTools = (messenger: Messenger): Record<string, AnyTool> => {
  const chat = chatOf(messenger)
  const messages = (adapter: MessengerAdapter, guard: SendGuard) =>
    servicesFor({ ...onlineDeps(messenger, adapter, guard) }).messages
  const forwardInput = {
    chat: v.pipe(v.string(), v.minLength(1), v.description("the chat the message is in")),
    message,
    to: v.pipe(v.string(), v.minLength(1), v.description(`where it goes: ${messenger.chatArgument}`)),
    silent: v.optional(v.pipe(v.boolean(), v.description("deliver without a notification"))),
    send_as: v.optional(
      v.pipe(
        v.string(),
        v.minLength(1),
        v.description(
          "an id from `chats send-as` to post as; required where the chat posts as someone else by default",
        ),
      ),
    ),
    operation_id: v.optional(v.pipe(v.string(), v.minLength(1), v.description("from an earlier outcome_unknown"))),
    topic: v.optional(
      v.pipe(v.string(), v.minLength(1), v.description("a forum topic id of the to chat, from `topics list`")),
    ),
  }
  const quietPins = messenger.quietPins !== false
  const durations = messenger.pinDurations?.length ? messenger.pinDurations : undefined
  const pinInput = {
    chat,
    message,
    notify: v.optional(v.pipe(v.boolean(), v.description("tell the chat's members"))),
    expire_time: v.optional(
      v.pipe(v.string(), v.minLength(1), v.description(pinLengthHelp(durations ?? [], messenger.pinDefaultDuration))),
    ),
  }
  // Refused rather than dropped: a quiet pin asked for here would otherwise go out loud.
  if (!quietPins) delete (pinInput as Partial<typeof pinInput>).notify
  if (!durations) delete (pinInput as Partial<typeof pinInput>).expire_time
  if (!messenger.forwardTopic) delete (forwardInput as Partial<typeof forwardInput>).topic
  if (messenger.silentSends === false) delete (forwardInput as Partial<typeof forwardInput>).silent
  if (messenger.sendAs === false) delete (forwardInput as Partial<typeof forwardInput>).send_as
  return {
    messages_edit: tool({
      title: "Edit a message",
      description:
        "Replace the text of one of the owner's own messages. Only when the owner asked for this exact change. " +
        "The other side may have read the old text already. Repeating the same edit changes nothing.",
      input: v.object({
        chat,
        message,
        text: v.pipe(v.string(), v.minLength(1)),
        md: v.optional(
          v.pipe(v.boolean(), v.description("read **bold**, _italic_, ~~struck~~ and `code`; \\ keeps a mark literal")),
        ),
        html: v.optional(v.pipe(v.boolean(), v.description(HTML_TOOL_HELP))),
      }),
      annotations: WRITE,
      permission: "edit",
      online: async (adapter, args, { guard }) => {
        const reader = selfOf(messenger, adapter)
        return writtenAnswer(
          await messages(adapter, guard).edit({
            chat: args.chat,
            message: args.message,
            text: args.text,
            markdown: args.md === true,
            ...(args.html === true ? { html: true } : {}),
          }),
          reader,
        )
      },
    }),
    messages_forward: tool({
      title: "Forward a message",
      description:
        "Forward one message to another chat, where new people will read it. Only when the owner asked for this " +
        "message to go to this chat. On outcome_unknown, retry with the operation_id it returns, never a new one: " +
        "a repeat without it is a second copy.",
      input: v.object(forwardInput),
      annotations: WRITE,
      permission: "forward",
      online: async (adapter, args, { guard }) => {
        const reader = selfOf(messenger, adapter)
        return writtenAnswer(
          await messages(adapter, guard).forward({
            chat: args.chat,
            message: args.message,
            to: args.to,
            silent: args.silent === true,
            ...(args.operation_id === undefined ? {} : { sendId: args.operation_id }),
            ...(args.send_as === undefined ? {} : { sendAs: args.send_as }),
            ...(args.topic === undefined ? {} : { threadId: args.topic }),
          }),
          reader,
        )
      },
    }),
    messages_pin: tool({
      title: "Pin a message",
      description: quietPins
        ? "Pin one message in a chat, quietly unless notify is true. Only when the owner asked for this pin. " +
          "In a one-to-one chat the pin is on the owner's side only."
        : "Pin one message in a chat; every member sees the pin and is told. Only when the owner asked for this pin.",
      input: v.object(pinInput),
      annotations: WRITE,
      permission: "pin",
      check: (args) => pinDurationOf(args.expire_time, durations, "expire_time"),
      online: async (adapter, args, { guard }) => {
        const duration = pinDurationOf(args.expire_time, durations, "expire_time")
        return itemOf(
          snakeKeys(
            await messages(adapter, guard).pin({
              chat: args.chat,
              message: args.message,
              notify: args.notify === true,
              ...(duration === undefined ? {} : { duration }),
            }),
          ),
        )
      },
    }),
    messages_unpin: tool({
      title: "Unpin a message",
      description: "Unpin one message in a chat. Only when the owner asked for it.",
      input: v.object({ chat, message }),
      annotations: WRITE,
      permission: "pin",
      online: async (adapter, args, { guard }) =>
        itemOf(snakeKeys(await messages(adapter, guard).unpin({ chat: args.chat, message: args.message }))),
    }),
    ...Object.fromEntries(
      (messenger.messageStars === true ? [true, false] : []).map((starred) => [
        starred ? "messages_star" : "messages_unstar",
        tool({
          title: starred ? "Star a message" : "Take the star off a message",
          description:
            (starred ? "Star one message so the owner finds it again. " : "Take the owner's star off one message. ") +
            "Only the owner sees a star; nobody in the chat is told. Only when the owner asked for it.",
          input: v.object({ chat, message }),
          annotations: WRITE,
          permission: "profile",
          online: async (adapter, args, { guard }) =>
            itemOf(snakeKeys(await messages(adapter, guard).star({ chat: args.chat, message: args.message, starred }))),
        }),
      ]),
    ),
  }
}
