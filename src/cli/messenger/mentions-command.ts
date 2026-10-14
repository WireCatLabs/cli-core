import { annotate } from "@wirecat/cli-base/commands"
import { Command } from "commander"
import type { Mention } from "../../services/mentions.js"
import { MENTION_QUERY } from "../../store/store.js"
import { authorOf } from "../author.js"
import { environmentOf } from "../context.js"
import { itemOf, renderAnswer, snakeKeys } from "../envelope.js"
import { pagedList, queryHelp } from "../list-query.js"
import { positiveCount, window } from "../paging.js"
import { type Messenger, messengerContext, refuseLocalWrite } from "./context.js"

const line = ({ id, kind, value, domain, status, sentAt, locator, field }: Mention) =>
  `${id}  ${sentAt}  ${kind}  ${value}${domain && kind === "url" ? `  (${domain})` : ""}  ${status}  ${locator}` +
  (field === "text" ? "" : `  (in its ${field === "transcript" ? "voice note" : "file"})`)

/** `mentions …`: phones, e-mail addresses, links and documents found in stored message text. */
export const mentionsCommand = (messenger: Messenger): Command => {
  const tool = messenger.app.command
  const mentions = new Command("mentions").description("phones, e-mail, links and documents found in stored messages")

  annotate(mentions.command("list"), {
    query: MENTION_QUERY,
    examples: [`${tool} mentions list kind:phone`, `${tool} mentions list domain:google.com`],
  })
    .description("this account's mentions matching the query, newest first; local store only")
    .argument("[query...]", "fields below; a bare word is a value, so 89001234567 finds +79001234567")
    .option("--limit <n>", "how many to show", positiveCount("--limit"))
    .option("--page <n>", "which page, starting at 1", positiveCount("--page"))
    .addHelpText("after", queryHelp(MENTION_QUERY))
    .action(async function (this: Command, query: string[]) {
      const context = messengerContext(this, messenger)
      const found = await context.withServices((services) =>
        services.mentions.list(query.join(" "), window(context.settings)),
      )
      if (found.state.rebuiltAt === null)
        context.renderer.note(
          `messages stored before mentions existed are not read yet — \`${tool} mentions rebuild\` reads them`,
        )
      renderAnswer(
        this,
        context,
        pagedList("mentions list", context.settings, {
          items: found.items.map(snakeKeys),
          has_more: found.hasMore,
          args: { query: query.join(" ") },
        }),
        () => found.items.map((item) => `${line(item)}\n`).join(""),
      )
    })

  annotate(mentions.command("show"), { examples: [`${tool} mentions show 12`] })
    .description("one mention, the text around it, and how many other places hold its value")
    .argument("<id>", "the mention's id, from mentions list", positiveCount("<id>"))
    .action(async function (this: Command, id: number) {
      const context = messengerContext(this, messenger)
      const found = await context.withServices((services) => services.mentions.show(id))
      renderAnswer(
        this,
        context,
        itemOf(snakeKeys(found)),
        () =>
          `${line(found)}\n…${found.before}[${found.written}]${found.after}…\n` +
          `same ${found.kind} in ${found.sameValue} other place${found.sameValue === 1 ? "" : "s"}\n`,
      )
    })

  annotate(mentions.command("confirm"), {
    mutates: true,
    local: true,
    examples: [`${tool} mentions confirm 12 person:7`, `${tool} mentions confirm 15`],
  })
    .description("say what a mention is, everywhere its value is written: a phone's owner, the stored document")
    .argument("<id>", "the mention's id, from mentions list", positiveCount("<id>"))
    .argument("[person]", "person:<uid> who owns the phone or the address; a document needs none")
    .option("--as-owner", "record it as yours although an agent's terminal runs the tool (AI_AGENT or CLAUDECODE set)")
    .action(async function (this: Command, id: number, person: string | undefined) {
      const context = messengerContext(this, messenger)
      refuseLocalWrite(context, tool, "mentions.confirm")
      const by = authorOf(environmentOf(this).env ?? process.env, this.opts<{ asOwner?: boolean }>().asOwner)
      context.renderer.result(await context.withServices((services) => services.mentions.confirm(id, person, by)))
    })

  annotate(mentions.command("reject"), { mutates: true, local: true, examples: [`${tool} mentions reject 12`] })
    .description("not a real mention, or not worth keeping: dismiss its value everywhere, and on later syncs")
    .argument("<id>", "the mention's id, from mentions list", positiveCount("<id>"))
    .option("--as-owner", "record it as yours although an agent's terminal runs the tool (AI_AGENT or CLAUDECODE set)")
    .action(async function (this: Command, id: number) {
      const context = messengerContext(this, messenger)
      refuseLocalWrite(context, tool, "mentions.reject")
      const by = authorOf(environmentOf(this).env ?? process.env, this.opts<{ asOwner?: boolean }>().asOwner)
      context.renderer.result(await context.withServices((services) => services.mentions.reject(id, by)))
    })

  annotate(mentions.command("rebuild"), { mutates: true, local: true, examples: [`${tool} mentions rebuild`] })
    .description("find the mentions of every stored message again; decisions are kept")
    .action(async function (this: Command) {
      const context = messengerContext(this, messenger)
      refuseLocalWrite(context, tool, "mentions.rebuild")
      const done = await context.withServices((services) =>
        services.mentions.rebuild({
          onBatch: (read, total) => context.renderer.note(`${read} of ${total} messages read`),
        }),
      )
      renderAnswer(this, context, itemOf(snakeKeys(done)))
    })

  return mentions
}
