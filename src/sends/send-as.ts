import { CliError } from "@wirecat/cli-base"
import { capability, type MessengerAdapter } from "../cli/messenger/port.js"
import type { Id } from "../domain/models.js"

/**
 * Found before the chat is resolved, so a messenger without identities refuses before any lookup;
 * the returned check runs once the chat id is known, in the same connection. With no identity named,
 * a chat whose saved sender is not the account is refused: the messenger would post as that sender,
 * and nothing the owner typed said so (owner, NEED-796 C).
 */
export const sendAsCheck = (connection: MessengerAdapter, sendAs: Id | undefined) => {
  if (sendAs === undefined) {
    const saved = connection.savedSender?.bind(connection)
    return async (chatId: Id) => {
      const sender = await saved?.(chatId)
      if (sender) {
        throw new CliError(
          "validation_error",
          `this chat posts as ${sender} unless told otherwise — add --send-as ${connection.self() ?? "<your id>"} ` +
            `to post as yourself, or --send-as ${sender} to post as it; \`chats send-as\` lists who you can be`,
          { savedSender: sender },
        )
      }
    }
  }
  const identities = capability(connection, "sendAsIdentities", "send as another identity")
  return async (chatId: Id) => {
    if (!(await identities(chatId)).some((one) => one.id === sendAs)) {
      throw new CliError(
        "validation_error",
        `${sendAs} is not an identity this account may post as in this chat — see \`chats send-as\``,
      )
    }
  }
}

/** `--send-as` as typed; blank is refused rather than read as "no identity". */
export const typedSendAs = (typed: string | undefined): Id | undefined => {
  const sendAs = typed?.trim()
  if (sendAs === "") throw new CliError("validation_error", "--send-as needs an id from `chats send-as`")
  return sendAs
}
