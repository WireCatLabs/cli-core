import { annotate } from "@wirecat/cli-base/commands"
import { Command } from "commander"
import { readEvidencePacket } from "../../services/evidence-read.js"
import { LOCAL_READ } from "../effects.js"
import { renderAnswer } from "../envelope.js"
import { positiveCount } from "../paging.js"
import { type Messenger, messengerContext } from "./context.js"
import { evidenceAnswer } from "./message-answers.js"

export const evidenceCommand = (messenger: Messenger): Command =>
  annotate(new Command("evidence"), {
    output: { entity: "evidence_packet" },
    examples: [`${messenger.app.command} personal messages evidence "Book club" --limit 10`],
    effects: LOCAL_READ,
  })
    .description("a bounded evidence packet from stored messages, newest first")
    .argument("<chat>", messenger.chatArgument)
    .option("--limit <n>", "how many, 1–100", positiveCount("--limit"))
    .option("--cursor <cursor>", "go on from where page.next says the last packet stopped")
    .action(async function (this: Command, chat: string) {
      const context = messengerContext(this, messenger)
      const { cursor } = this.opts<{ cursor?: string }>()
      const { limit } = context.settings
      const packet = await context.withStore((store, account) =>
        readEvidencePacket(
          store,
          account,
          { chat, limit, ...(cursor === undefined ? {} : { before: cursor }) },
          messenger,
        ),
      )
      renderAnswer(this, context, evidenceAnswer(packet, chat, limit), () =>
        packet.items
          .map(
            ({ locator, timestamp, senderName, text }) => `${timestamp}  ${senderName ?? "?"}  ${locator}  ${text}\n`,
          )
          .join(""),
      )
    })
