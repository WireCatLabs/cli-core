import * as v from "valibot"
import type { Messenger } from "../../cli/messenger/context.js"
import { heardAnswer } from "../../cli/messenger/message-answers.js"
import { choose, hearLocally, hearOnline } from "../../speech/transcribe.js"
import { type AnyTool, chatOf, message, nameOf, READ, tool } from "../tool.js"

export const messagesTranscribeTools = (messenger: Messenger): Record<string, AnyTool> => ({
  messages_transcribe: tool({
    title: "Read a voice message",
    description:
      `A voice message as text — by ${nameOf(messenger)} where the account allows it, else by a speech model ` +
      "on this machine. Can take up to a minute; pending: true means it was not finished yet — ask again later. " +
      "Never downloads a model: a missing one is refused with the command the owner runs. " +
      "Answers item { message_id, text, pending, via, model? }.",
    input: v.object({
      chat: chatOf(messenger),
      message,
      local: v.optional(v.pipe(v.boolean(), v.description("use the model on this machine, never the messenger"))),
      model: v.optional(v.pipe(v.string(), v.minLength(1), v.description("which downloaded speech model hears it"))),
    }),
    annotations: READ,
    online: async (adapter, args, defaults) => {
      const choice = choose(
        messenger,
        defaults.settings,
        {
          local: args.local === true,
          ...(args.model === undefined ? {} : { model: args.model }),
        },
        defaults.env,
      )
      const heard = await hearOnline(messenger, adapter, args.chat, args.message, choice)
      if (!(heard instanceof Uint8Array)) return heardAnswer(heard, args.chat)
      await defaults.release?.()
      return heardAnswer(await hearLocally(heard, args.message, choice), args.chat)
    },
  }),
})
