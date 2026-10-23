import { annotate } from "@wirecat/cli-base/commands"
import { Command } from "commander"
import { REMOTE_READ } from "../effects.js"
import { listOf, renderAnswer } from "../envelope.js"
import { queryTerms, typedQuery, withQuery } from "../list-query.js"
import { positiveCount, window } from "../paging.js"
import { nextStep } from "../steps.js"
import { documentLinkAnswer, lines, pageOf } from "./chat-answers.js"
import { type Messenger, messengerContext } from "./context.js"
import { DOCUMENT_LINKS_QUERY } from "./document-links-query.js"
import { syncsFirst } from "./search-sync-options.js"

/** `chats documents …`: the Google documents linked in a chat's stored messages. */
export const documentsCommand = (messenger: Messenger): Command => {
  const documents = new Command("documents").description(
    "the Google Docs and Drive documents linked in a chat's stored messages",
  )
  documents.addCommand(
    withQuery(
      annotate(new Command("list"), { effects: REMOTE_READ })
        .description("every document link in the chat, newest first, and whether the store has it")
        .argument("<chat>", messenger.chatArgument)
        .option("--limit <n>", "how many to show", positiveCount("--limit"))
        .option("--page <n>", "which page, starting at 1", positiveCount("--page")),
      DOCUMENT_LINKS_QUERY,
    ).action(async function (this: Command, chat: string, words: string[]) {
      const ref = queryTerms(words, DOCUMENT_LINKS_QUERY, "chats documents list").get("ref")
      const context = messengerContext(this, messenger)
      const found = await context.withServices((services) =>
        services.chatDocuments.list(chat, { ...window(context.settings), ...(ref === undefined ? {} : { ref }) }),
      )
      renderAnswer(
        this,
        context,
        listOf("chats documents list", {
          items: found.items.map(documentLinkAnswer),
          ...pageOf(context.settings, found),
          args: { chat, ...(words.length ? { query: typedQuery(words) } : {}) },
          ...(found.empty && syncsFirst(messenger)
            ? { next: [nextStep("messages.sync", { args: { chat: found.chatId } })] }
            : {}),
        }),
        lines(({ sent_at, sender, title, url, in_store }) =>
          [sent_at, sender.name ?? sender.id ?? "?", title ?? url, in_store ? "in store" : "not in store"].join("  "),
        ),
      )
    }),
  )
  return documents
}
