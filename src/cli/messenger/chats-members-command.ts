import { annotate } from "@wirecat/cli-base/commands"
import { Command } from "commander"
import { registriesCover } from "../../botcheck/registries.js"
import { AUDIT_BUDGET, AUDIT_MIN_SCORE, AUDIT_PAGE } from "../../services/members-audit.js"
import { momentOf } from "../../services/moment.js"
import { listed, positiveCount, renderPage, window, withPaging } from "../paging.js"
import { casKey } from "../registry-keys.js"
import { commandCapabilities } from "./capabilities.js"
import { type Messenger, messengerContext } from "./context.js"

/** `chats members …`; a subcommand that changes membership belongs here too. */
export const membersCommand = (messenger: Messenger): Command => {
  const members = new Command("members").description("who is in a group")

  members.addCommand(
    withPaging(
      new Command("list")
        .description("everyone in a group, a page at a time, with their role and when they were last seen")
        .argument("<chat>", messenger.chatArgument),
    ).action(async function (this: Command, chat: string) {
      const context = messengerContext(this, messenger)
      const wanted = window(context.settings)
      const page = await context.withServices((services) => services.chats.members(chat, wanted))
      renderPage(context, page)
    }),
  )

  members.addCommand(
    new Command("audit")
      .description(
        "members that look like bots, each with its reasons — read from the member list and the local store; " +
          "never one request per person, and it removes nobody",
      )
      .argument("<chat>", messenger.chatArgument)
      .option(
        "--budget <pages>",
        `at most this many pages of ${AUDIT_PAGE} members, a pause between them (default: ${AUDIT_BUDGET})`,
        positiveCount("--budget"),
      )
      .option(
        "--min-score <n>",
        `only members scoring at least this; 1 lists everyone with a reason (default: ${AUDIT_MIN_SCORE})`,
        positiveCount("--min-score"),
      )
      .option(
        "--deep <n>",
        registriesCover(messenger.provider)
          ? "also check the top n in full — profile, photos, everything they wrote, and the public ban lists, which " +
              "are sent their ids — one person a second"
          : "also check the top n in full — profile, photos and everything they wrote — one person a second; the " +
              "public ban lists cover Telegram only, so nothing is sent",
        positiveCount("--deep"),
      )
      .action(async function (this: Command, chat: string) {
        const context = messengerContext(this, messenger)
        const { budget, minScore, deep } = this.opts<{ budget?: number; minScore?: number; deep?: number }>()
        const key = deep === undefined ? undefined : casKey(messenger.app, context.env)
        const audit = await context.withServices((services) =>
          services.chats.audit(chat, {
            ...(budget === undefined ? {} : { budget }),
            ...(minScore === undefined ? {} : { minScore }),
            ...(deep === undefined ? {} : { deep }),
            ...(key ? { registry: { casKey: key } } : {}),
          }),
        )
        if (audit.more) {
          const of = audit.participantsCount === null ? "" : ` of ${audit.participantsCount}`
          context.renderer.note(`${audit.read}${of} members read; a higher --budget reads more`)
        }
        if (audit.fetch)
          context.renderer.note(`"never wrote" counts only stored messages — \`${audit.fetch}\` fetches the rest`)
        if (audit.unknown.length > 0)
          context.renderer.note(`not judged, nothing to judge by: ${audit.unknown.join(", ")}`)
        if (context.format !== "pretty") {
          context.renderer.result(audit)
          return
        }
        context.renderer.stream(
          audit.items.map(({ id, name, username, score, reasons, check }) => ({
            score,
            id,
            name: name ?? "",
            username: username ?? "",
            reasons: reasons.join(", "),
            ...(check
              ? {
                  checked: check.score,
                  listed: check.registries
                    .filter(({ answer }) => answer === "listed")
                    .map(({ name }) => name)
                    .join(", "),
                }
              : {}),
          })),
        )
      }),
  )

  members.addCommand(
    new Command("history")
      .description(
        "who joined, who left and whose profile changed, oldest first — what chats members fetch recorded in the " +
          "local store; never asks the messenger",
      )
      .argument("<chat>", messenger.chatArgument)
      .option("--since-time <time>", "ISO 8601, or 2h / 1d ago; everything recorded if not given")
      .action(async function (this: Command, chat: string) {
        const context = messengerContext(this, messenger)
        const { sinceTime } = this.opts<{ sinceTime?: string }>()
        const found = await context.withServices((services) =>
          services.chats.memberHistory(
            chat,
            sinceTime === undefined ? {} : { since: momentOf(sinceTime, "--since-time") },
          ),
        )
        if (found.events.length === 0) {
          context.renderer.note(
            `nothing recorded — \`${messenger.app.command} chats members fetch ${found.chatId} --track\` starts it`,
          )
        }
        if (context.format === "jsonl") return context.renderer.stream(found.events)
        if (context.format !== "pretty")
          return context.renderer.result({ ...listed(found.events), hasMore: false, chatId: found.chatId })
        context.renderer.stream(
          found.events.map(({ at, event, id, name, username, before }) => ({
            time: at,
            event,
            person: [name, username ? `@${username}` : null, `(${id})`].filter(Boolean).join(" "),
            was: before ? [before.name, before.username ? `@${before.username}` : null].filter(Boolean).join(" ") : "",
          })),
        )
      }),
  )

  const fetch = new Command("fetch")
    .description(
      "read a group's whole member list into the local store's member history: who joined, who left, daily " +
        "counts and profile changes; someone is recorded as gone only when every member was read",
    )
    .argument("<chat>", messenger.chatArgument)

  if (commandCapabilities(messenger).tracksMembers) {
    fetch.option("--track", "also fetch it daily while serve runs; chats tracking lists and edits those chats")
  }
  members.addCommand(
    fetch
      .option(
        "--budget <pages>",
        `at most this many pages of ${AUDIT_PAGE} members, a pause between them (default: ${AUDIT_BUDGET})`,
        positiveCount("--budget"),
      )
      .action(async function (this: Command, chat: string) {
        const context = messengerContext(this, messenger)
        const { track, budget } = this.opts<{ track?: boolean; budget?: number }>()
        const fetched = await context.withServices((services) =>
          services.chats.fetchMembers(chat, {
            ...(budget === undefined ? {} : { budget }),
            ...(track ? { track } : {}),
          }),
        )
        if (!fetched.complete) {
          context.renderer.note(
            fetched.more
              ? `${fetched.read} members read; a higher --budget reads more — until then nobody is recorded as gone`
              : "the chat's own member count is unknown or larger than the list — nobody is recorded as gone",
          )
        }
        if (context.format !== "pretty") {
          context.renderer.result(fetched)
          return
        }
        context.streams.data(
          `${fetched.read} members read; ${fetched.joined.length} new, ${fetched.gone.length} gone, ` +
            `${fetched.changed.length} changed their profile${fetched.tracked ? "; tracked daily" : ""}`,
        )
      }),
  )

  const add = annotate(new Command("add"), { mutates: true })
    .description("add people; they are told")
    .argument("<chat>", messenger.chatArgument)
    .argument("<person...>", "an id, or part of a name")
  if (commandCapabilities(messenger).addsWithHistory) {
    add.option("--history", "the people added also see the messages from before they came")
  }
  members.addCommand(
    add.action(async function (this: Command, chat: string, people: string[]) {
      const context = messengerContext(this, messenger)
      const history = this.opts<{ history?: boolean }>().history === true
      context.renderer.result(
        await context.withServices((services) => services.admin.addMembers(chat, people, history ? { history } : {})),
      )
    }),
  )

  members.addCommand(
    annotate(new Command("remove"), { mutates: true })
      .description("remove people; their messages stay")
      .argument("<chat>", messenger.chatArgument)
      .argument("<person...>", "an id, or part of a name")
      .action(async function (this: Command, chat: string, people: string[]) {
        const context = messengerContext(this, messenger)
        context.renderer.result(await context.withServices((services) => services.admin.removeMembers(chat, people)))
      }),
  )

  return members
}
