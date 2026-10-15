import { annotate } from "@wirecat/cli-base/commands"
import { Argument, Command } from "commander"
import { MENTION_KINDS, type MentionKind } from "../../domain/mentions.js"
import type { Mention } from "../../services/mentions.js"
import { MENTION_QUERY } from "../../store/store.js"
import { authorOf } from "../author.js"
import { environmentOf } from "../context.js"
import { LOCAL_READ, LOCAL_WRITE } from "../effects.js"
import { itemOf, renderAnswer, snakeKeys } from "../envelope.js"
import { pagedList, queryHelp } from "../list-query.js"
import { positiveCount, window } from "../paging.js"
import { type Messenger, messengerContext, refuseLocalWrite } from "./context.js"
import { reviewPoint } from "./mention-points.js"

const line = ({ id, kind, value, domain, status, sentAt, locator, field }: Mention) =>
  `${id}  ${sentAt}  ${kind}  ${value}${domain && kind === "url" ? `  (${domain})` : ""}  ${status}  ${locator}` +
  (field === "text" ? "" : `  (in its ${field === "transcript" ? "voice note" : "file"})`)

/** `mentions …`: phones, e-mail addresses, links and documents found in stored message text. */
export const mentionsCommand = (messenger: Messenger): Command => {
  const tool = messenger.app.command
  const mentions = new Command("mentions").description(
    "phones, e-mail, links, documents and people's names found in stored messages",
  )

  annotate(mentions.command("list"), {
    effects: LOCAL_READ,
    query: MENTION_QUERY,
    examples: [
      `${tool} mentions list kind:phone`,
      `${tool} mentions list domain:google.com`,
      `${tool} mentions list --new`,
    ],
  })
    .description(
      "this account's mentions matching the query, newest first; --new for those found since the last review",
    )
    .argument("[query...]", "fields below; a bare word is a value, so a phone typed with 8 finds it written with +7")
    .option("--limit <n>", "how many to show", positiveCount("--limit"))
    .option("--page <n>", "which page, starting at 1", positiveCount("--page"))
    .option(
      "--new",
      "undecided mentions found since the last --new run that showed them all; the first run shows every one",
    )
    .addHelpText("after", queryHelp(MENTION_QUERY))
    .action(async function (this: Command, query: string[]) {
      const context = messengerContext(this, messenger)
      const fresh = this.opts<{ new?: boolean }>().new === true
      const point = fresh ? reviewPoint(messenger.app, context.settings.profile, context.env) : undefined
      const typed = query.join(" ")
      const asked = fresh && !/(^|\s)status:/.test(typed) ? `status:found ${typed}`.trim() : typed
      const found = await context.withServices((services) =>
        services.mentions.list(asked, {
          ...window(context.settings),
          ...(point?.after === undefined ? {} : { foundAfter: point.after }),
        }),
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
      // Moved only past a complete answer: rows are in message order, so a cut page could skip one found earlier.
      if (point && !found.hasMore) point.save(found.items.map((item) => item.foundAt))
      else if (point) context.renderer.note("more remain — a larger --limit shows them all and moves the --new point")
    })

  annotate(mentions.command("domains"), {
    effects: LOCAL_READ,
    query: MENTION_QUERY,
    examples: [`${tool} mentions domains`, `${tool} mentions domains status:found`],
  })
    .description("the sites this account's links point to, most linked first, with chats and first and last time")
    .argument("[query...]", "narrows the links counted: the fields below; dismissed links are never counted")
    .option("--limit <n>", "how many to show", positiveCount("--limit"))
    .option("--page <n>", "which page, starting at 1", positiveCount("--page"))
    .addHelpText("after", queryHelp(MENTION_QUERY))
    .action(async function (this: Command, query: string[]) {
      const context = messengerContext(this, messenger)
      const sites = await context.withServices((services) =>
        services.mentions.domains(query.join(" "), window(context.settings)),
      )
      renderAnswer(
        this,
        context,
        pagedList("mentions domains", context.settings, {
          items: sites.items.map(snakeKeys),
          has_more: sites.hasMore,
          args: { query: query.join(" ") },
        }),
        () =>
          sites.items
            .map(
              ({ domain, links, chats, firstAt, lastAt }) =>
                `${domain}  ${links} link${links === 1 ? "" : "s"} in ${chats} chat${chats === 1 ? "" : "s"}  ` +
                `${firstAt.slice(0, 10)}…${lastAt.slice(0, 10)}\n`,
            )
            .join(""),
      )
    })

  annotate(mentions.command("show"), { effects: LOCAL_READ, examples: [`${tool} mentions show 12`] })
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
          `same ${found.kind} in ${found.sameValue} other place${found.sameValue === 1 ? "" : "s"}\n` +
          (found.candidates.length > 0 ? `may be ${found.candidates.join(", ")}\n` : ""),
      )
    })

  annotate(mentions.command("confirm"), {
    effects: LOCAL_WRITE,
    examples: [
      `${tool} mentions confirm 12 person:7`,
      `${tool} mentions confirm 15`,
      `${tool} mentions confirm 31 person:7 --all-in-chat`,
    ],
  })
    .summary("say what a mention is, everywhere its value is written")
    .description(
      "say what a mention is: a phone's owner everywhere it is written, the stored document, who a name means",
    )
    .argument("<id>", "the mention's id, from mentions list", positiveCount("<id>"))
    .argument(
      "[person]",
      "person:<uid> or organization:<id> that owns the phone or the address; person:<uid> a name means; a document needs none",
    )
    .option("--all-in-chat", "a name: also every undecided place of the same name in its chat")
    .option("--as-owner", "record it as yours although an agent's terminal runs the tool (AI_AGENT or CLAUDECODE set)")
    .action(async function (this: Command, id: number, person: string | undefined) {
      const context = messengerContext(this, messenger)
      refuseLocalWrite(context, tool, "mentions.confirm")
      const by = authorOf(environmentOf(this).env ?? process.env, this.opts<{ asOwner?: boolean }>().asOwner)
      const inChat = this.opts<{ allInChat?: boolean }>().allInChat === true
      const decided = await context.withServices((services) => services.mentions.confirm(id, person, by, inChat))
      renderAnswer(this, context, itemOf(snakeKeys(decided)))
    })

  annotate(mentions.command("reject"), {
    effects: LOCAL_WRITE,
    examples: [`${tool} mentions reject 12`],
  })
    .summary("dismiss a mention's value everywhere, and on later syncs")
    .description("not a real mention: dismiss its value everywhere and on later syncs; a name only where it is")
    .argument("<id>", "the mention's id, from mentions list", positiveCount("<id>"))
    .option("--all-in-chat", "a name: also every undecided place of the same name in its chat")
    .option("--as-owner", "record it as yours although an agent's terminal runs the tool (AI_AGENT or CLAUDECODE set)")
    .action(async function (this: Command, id: number) {
      const context = messengerContext(this, messenger)
      refuseLocalWrite(context, tool, "mentions.reject")
      const by = authorOf(environmentOf(this).env ?? process.env, this.opts<{ asOwner?: boolean }>().asOwner)
      const inChat = this.opts<{ allInChat?: boolean }>().allInChat === true
      const decided = await context.withServices((services) => services.mentions.reject(id, by, inChat))
      renderAnswer(this, context, itemOf(snakeKeys(decided)))
    })

  annotate(mentions.command("rebuild"), {
    effects: LOCAL_WRITE,
    examples: [`${tool} mentions rebuild`, `${tool} mentions rebuild person-name`],
  })
    .description("find the mentions of every stored message again; decisions are kept")
    .addArgument(
      new Argument("[kind]", "only this kind: person-name after people were added or renamed").choices(MENTION_KINDS),
    )
    .action(async function (this: Command, kind?: MentionKind) {
      const context = messengerContext(this, messenger)
      refuseLocalWrite(context, tool, "mentions.rebuild")
      const done = await context.withServices((services) =>
        services.mentions.rebuild({
          ...(kind ? { kinds: [kind] } : {}),
          onBatch: (read, total) => context.renderer.note(`${read} of ${total} messages read`),
        }),
      )
      renderAnswer(this, context, itemOf(snakeKeys(done)))
    })

  return mentions
}
