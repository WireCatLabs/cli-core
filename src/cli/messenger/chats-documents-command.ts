import { Command } from "commander"
import type { ChatDocument } from "../../services/chat-documents.js"
import { positiveCount, renderPage, window } from "../paging.js"
import { type Messenger, messengerContext } from "./context.js"

const line = ({ sentAt, sender, title, url, inStore }: ChatDocument) =>
  `${sentAt}  ${sender.name ?? sender.id ?? "?"}  ${title ?? url}  ${inStore ? "in store" : "not in store"}`

/** `chats documents …`: the Google documents linked in a chat's stored messages. */
export const documentsCommand = (messenger: Messenger): Command => {
  const documents = new Command("documents").description(
    "the Google Docs and Drive documents linked in a chat's stored messages",
  )
  documents.addCommand(
    new Command("list")
      .description("every document link in the chat, newest first, and whether the store has it")
      .argument("<chat>", messenger.chatArgument)
      .option("--limit <n>", "how many to show", positiveCount("--limit"))
      .option("--page <n>", "which page, starting at 1", positiveCount("--page"))
      .action(async function (this: Command, chat: string) {
        const context = messengerContext(this, messenger)
        const found = await context.withServices((services) =>
          services.chatDocuments.list(chat, window(context.settings)),
        )
        if (found.empty)
          context.renderer.note(
            `no stored messages in this chat — \`${messenger.app.command} store fetch ${found.chatId}\` fetches them`,
          )
        renderPage(context, found, (items) => items.map((item) => `${line(item)}\n`).join(""))
      }),
  )
  return documents
}
