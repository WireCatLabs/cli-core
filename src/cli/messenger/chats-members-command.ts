import { annotate } from "@wirecat/cli-base/commands"
import { Command } from "commander"
import { registriesCover } from "../../botcheck/registries.js"
import { AUDIT_BUDGET, AUDIT_PAGE } from "../../services/members-audit.js"
import { itemOf, renderAnswer, snakeKeys } from "../envelope.js"
import { withQuery } from "../list-query.js"
import { positiveCount, withPaging } from "../paging.js"
import { casKey } from "../registry-keys.js"
import { lines } from "./chat-answers.js"
import { membersAudit, membersHistory, membersList } from "./chat-lists.js"
import { AUDIT_QUERY, HISTORY_QUERY } from "./chat-queries.js"
import { type Messenger, messengerContext } from "./context.js"

/** `chats members …`; a subcommand that changes membership belongs here too. */
export const membersCommand = (messenger: Messenger): Command => {
  const members = new Command("members").description("who is in a group")

  members.addCommand(
    annotate(
      withPaging(
        new Command("list")
          .description("everyone in a group, a page at a time, with their role and when they were last seen")
          .argument("<chat>", messenger.chatArgument),
      ),
      { output: { entity: "member" } },
    ).action(async function (this: Command, chat: string) {
      const context = messengerContext(this, messenger)
      const body = await context.withServices((services) => membersList(services, chat, context.settings))
      renderAnswer(
        this,
        context,
        body,
        lines(({ id, name, username, role }) =>
          [id, name ?? "", username ? `@${username}` : "", role ?? ""].join("  "),
        ),
      )
    }),
  )

  members.addCommand(
    withQuery(
      annotate(
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
            "--deep <n>",
            registriesCover(messenger.provider)
              ? "also check the top n in full — profile, photos, everything they wrote, and the public ban lists, which " +
                  "are sent their ids — one person a second"
              : "also check the top n in full — profile, photos and everything they wrote — one person a second; the " +
                  "public ban lists cover Telegram only, so nothing is sent",
            positiveCount("--deep"),
          ),
        { output: { entity: "member" } },
      ),
      AUDIT_QUERY,
    ).action(async function (this: Command, chat: string, words: string[]) {
      const context = messengerContext(this, messenger)
      const { budget, deep } = this.opts<{ budget?: number; deep?: number }>()
      const key = deep === undefined ? undefined : casKey(messenger.app, context.env)
      const { audit, body } = await context.withServices((services) =>
        membersAudit(services, chat, words, {
          ...(budget === undefined ? {} : { budget }),
          ...(deep === undefined ? {} : { deep }),
          ...(key ? { registry: { casKey: key } } : {}),
        }),
      )
      if (audit.more) {
        const of = audit.participantsCount === null ? "" : ` of ${audit.participantsCount}`
        context.renderer.note(`${audit.read}${of} members read; a higher --budget reads more`)
      }
      renderAnswer(
        this,
        context,
        body,
        lines(({ score, id, name, username, reasons, check }) =>
          [
            score,
            id,
            name ?? "",
            username ? `@${username}` : "",
            (reasons ?? []).join(", "),
            check ? `checked ${String(check.score)}` : "",
          ].join("  "),
        ),
      )
    }),
  )

  members.addCommand(
    withQuery(
      annotate(
        new Command("history")
          .description(
            "who joined, who left and whose profile changed, oldest first — what chats members fetch recorded in the " +
              "local store; never asks the messenger",
          )
          .argument("<chat>", messenger.chatArgument),
        { output: { entity: "chat_event" } },
      ),
      HISTORY_QUERY,
    ).action(async function (this: Command, chat: string, words: string[]) {
      const context = messengerContext(this, messenger)
      const body = await context.withServices((services) => membersHistory(services, chat, words))
      renderAnswer(
        this,
        context,
        body,
        lines(({ time, type, people, before }) =>
          [
            time,
            type,
            people
              .map((one) =>
                [one.name, one.username ? `@${one.username}` : null, `(${one.id ?? "?"})`].filter(Boolean).join(" "),
              )
              .join(", "),
            before ? [before.name, before.username ? `@${before.username}` : null].filter(Boolean).join(" ") : "",
          ].join("  "),
        ),
      )
    }),
  )

  const fetch = new Command("fetch")
    .description(
      "read a group's whole member list into the local store's member history: who joined, who left, daily " +
        "counts and profile changes; someone is recorded as gone only when every member was read",
    )
    .argument("<chat>", messenger.chatArgument)

  if (messenger.tracksMembers !== false) {
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
        renderAnswer(
          this,
          context,
          itemOf(snakeKeys(fetched)),
          () =>
            `${fetched.read} members read; ${fetched.joined.length} new, ${fetched.gone.length} gone, ` +
            `${fetched.changed.length} changed their profile${fetched.tracked ? "; tracked daily" : ""}\n`,
        )
      }),
  )

  const add = annotate(new Command("add"), { mutates: true })
    .description("add people; they are told")
    .argument("<chat>", messenger.chatArgument)
    .argument("<person...>", "an id, or part of a name")
  if (messenger.addsWithHistory !== false) {
    add.option("--history", "the people added also see the messages from before they came")
  }
  members.addCommand(
    add.action(async function (this: Command, chat: string, people: string[]) {
      const context = messengerContext(this, messenger)
      const history = this.opts<{ history?: boolean }>().history === true
      const added = await context.withServices((services) =>
        services.admin.addMembers(chat, people, history ? { history } : {}),
      )
      renderAnswer(this, context, itemOf(snakeKeys(added)))
    }),
  )

  members.addCommand(
    annotate(new Command("remove"), { mutates: true })
      .description("remove people; their messages stay")
      .argument("<chat>", messenger.chatArgument)
      .argument("<person...>", "an id, or part of a name")
      .action(async function (this: Command, chat: string, people: string[]) {
        const context = messengerContext(this, messenger)
        const removed = await context.withServices((services) => services.admin.removeMembers(chat, people))
        renderAnswer(this, context, itemOf(snakeKeys(removed)))
      }),
  )

  return members
}
