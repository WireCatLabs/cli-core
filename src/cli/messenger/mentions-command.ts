import { CliError } from "@wirecat/cli-base"
import { annotate } from "@wirecat/cli-base/commands"
import { Command } from "commander"
import { MENTION_KINDS, type MentionKind, siteOf } from "../../domain/mentions.js"
import type { Mention } from "../../services/mentions.js"
import type { MentionStatus } from "../../store/store.js"
import { positiveCount, renderPage, window } from "../paging.js"
import { type Messenger, messengerContext, refuseLocalWrite } from "./context.js"

const STATUSES: readonly MentionStatus[] = ["found", "linked", "dismissed"]

const kindOf = (value: string): MentionKind => {
  if (!(MENTION_KINDS as readonly string[]).includes(value))
    throw new CliError("validation_error", `--kind takes ${MENTION_KINDS.join(", ")}`)
  return value as MentionKind
}

const statusOf = (value: string): MentionStatus => {
  if (!(STATUSES as readonly string[]).includes(value))
    throw new CliError("validation_error", `--status takes ${STATUSES.join(", ")}`)
  return value as MentionStatus
}

const line = ({ id, kind, value, domain, status, sentAt, locator }: Mention) =>
  `${id}  ${sentAt}  ${kind}  ${value}${domain && kind === "url" ? `  (${domain})` : ""}  ${status}  ${locator}`

/** `mentions …`: phones, e-mail addresses, links and documents found in stored message text. */
export const mentionsCommand = (messenger: Messenger): Command => {
  const mentions = new Command("mentions").description(
    "phones, e-mail addresses, links and Google documents found in stored message text, each where it was written",
  )

  mentions
    .command("list")
    .description("this account's mentions, newest message first; reads the local store only")
    .option("--kind <kind>", `only this kind: ${MENTION_KINDS.join(", ")}`, kindOf)
    .option("--status <status>", `only this status: ${STATUSES.join(", ")}`, statusOf)
    .option(
      "--domain <site>",
      "only links and e-mail of this site; docs.google.com means google.com, every subdomain included",
    )
    .option("--value <value>", "only this exact value: +79001234567, a lower-case address, a link as listed")
    .option("--limit <n>", "how many to show", positiveCount("--limit"))
    .option("--page <n>", "which page, starting at 1", positiveCount("--page"))
    .action(async function (this: Command) {
      const context = messengerContext(this, messenger)
      const filter = this.opts<{ kind?: MentionKind; status?: MentionStatus; domain?: string; value?: string }>()
      const found = await context.withServices((services) =>
        services.mentions.list(
          { ...filter, ...(filter.domain ? { domain: siteOf(filter.domain.toLowerCase()) } : {}) },
          window(context.settings),
        ),
      )
      if (found.state.rebuiltAt === null)
        context.renderer.note(
          `messages stored before mentions existed are not read yet — \`${messenger.app.command} mentions rebuild\` reads them`,
        )
      renderPage(context, found, (items) => items.map((item) => `${line(item)}\n`).join(""))
    })

  mentions
    .command("show")
    .description("one mention: the text around it, and how many other places hold the same value")
    .argument("<id>", "the mention's id, from mentions list", positiveCount("<id>"))
    .action(async function (this: Command, id: number) {
      const context = messengerContext(this, messenger)
      const found = await context.withServices((services) => services.mentions.show(id))
      if (context.format !== "pretty") return context.renderer.result(found)
      context.streams.data(
        `${line(found)}\n…${found.before}[${found.written}]${found.after}…\n` +
          `same ${found.kind} in ${found.sameValue} other place${found.sameValue === 1 ? "" : "s"}\n`,
      )
    })

  annotate(mentions.command("rebuild"), { mutates: true, local: true })
    .description(
      "find the mentions of every stored message again, every account's; linked and dismissed ones keep their status",
    )
    .option(
      "--kind <kind>",
      `redo only this kind: ${MENTION_KINDS.join(", ")}; repeat for several`,
      (value: string, previous: MentionKind[]) => [...previous, kindOf(value)],
      [],
    )
    .action(async function (this: Command) {
      const context = messengerContext(this, messenger)
      refuseLocalWrite(context, messenger.app.command, "mentions.rebuild")
      const { kind } = this.opts<{ kind: MentionKind[] }>()
      const done = await context.withServices((services) =>
        services.mentions.rebuild({
          ...(kind.length ? { kinds: kind } : {}),
          onBatch: (read, total) => context.renderer.note(`${read} of ${total} messages read`),
        }),
      )
      context.renderer.result(done)
    })

  return mentions
}
