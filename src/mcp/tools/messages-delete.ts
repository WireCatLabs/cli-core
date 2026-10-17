import { CliError } from "@wirecat/cli-base"
import * as v from "valibot"
import { itemOf, snakeKeys } from "../../cli/envelope.js"
import type { Messenger } from "../../cli/messenger/context.js"
import { DELETE_AT_ONCE, onlineDeps, servicesFor } from "../../services/index.js"
import { type AnyTool, chatOf, message, tool, WRITE } from "../tool.js"

export const messageDeleteTools = (messenger: Messenger): Record<string, AnyTool> => {
  const ownerOnly = `\`${messenger.app.command} messages delete --for-everyone\``
  const definition = {
    title: "Delete messages",
    description:
      `Delete up to ${DELETE_AT_ONCE} messages from the owner's view of a chat; the other people still see them. ` +
      `Never for everyone: that is the owner's own ${ownerOnly}. ` +
      "Cannot be undone. Only when the owner asked for these exact messages to be deleted.",
    input: v.object({
      chat: chatOf(messenger),
      messages: v.pipe(v.array(message), v.minLength(1), v.maxLength(DELETE_AT_ONCE)),
    }),
    annotations: WRITE,
    permission: "delete" as const,
  }
  return {
    messages_delete:
      messenger.deleteForMe === false
        ? tool({
            ...definition,
            local: async () => {
              throw new CliError(
                "permission_error",
                `${messenger.name ?? messenger.provider} deletes only for everyone, and an agent never deletes for ` +
                  `everyone — the owner can run ${ownerOnly}`,
                { permission: "messages.delete" },
              )
            },
          })
        : tool({
            ...definition,
            online: async (adapter, args, { guard }) =>
              itemOf(
                snakeKeys(
                  await servicesFor(onlineDeps(messenger, adapter, guard)).messages.delete({
                    chat: args.chat,
                    messages: args.messages,
                    forEveryone: false,
                  }),
                ),
              ),
          }),
  }
}
