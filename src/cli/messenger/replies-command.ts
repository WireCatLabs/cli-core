import { CliError } from "@wirecat/cli-base"
import { Command } from "commander"
import { DRY_RUN_DAYS, dryRun } from "../../replies/dry-run.js"
import { replyRenderer } from "../../replies/rendering.js"
import { audienceWarnings, readReplies, repliesPathFor } from "../../replies/rules.js"
import { paused, readRepliesState, repliesStatePathFor, writeRepliesState } from "../../replies/state.js"
import { levelFor } from "../../sends/permissions.js"
import { momentOf } from "../../services/moment.js"
import { type Messenger, messengerContext } from "./context.js"
import { replyConsentsCommand } from "./replies-consents-command.js"
import { addReplyEditors } from "./replies-edit-command.js"

/** `replies`: rules that answer messages for the owner, from `serve`, and only to the people and chats the audience allows. */
export const repliesCommand = (messenger: Messenger): Command => {
  const replies = new Command("replies").description(
    "rules that answer messages for you, kept in a file of this profile",
  )
  addReplyEditors(replies, messenger)
  replies.addCommand(replyConsentsCommand(messenger))

  replies
    .command("test")
    .description(
      "what the rules would have answered in the stored messages, to whom and why — sends nothing, " +
        "changes nothing, never connects",
    )
    .argument("[rule]", "only this rule, by its id; every rule in file order if not given")
    .option("--since-time <time>", `from this ISO 8601 time, or 2h / 1d ago; ${DRY_RUN_DAYS}d ago if not given`)
    .option(
      "--ai",
      "call the configured reply model with stored message data; requires reply consent, otherwise uses fallback",
    )
    .action(async function (this: Command, rule: string | undefined) {
      const { sinceTime, ai } = this.opts<{ sinceTime?: string; ai?: boolean }>()
      const context = messengerContext(this, messenger)
      const { settings, renderer, format, streams, env } = context
      const controller = new AbortController()
      context.track({ close: async () => controller.abort() })
      if (ai && settings.offline)
        throw new CliError("validation_error", "--ai calls a model and cannot be combined with --offline")
      if (ai && levelFor(settings.permissions, "messages.list").level === "deny")
        throw new CliError(
          "permission_error",
          "this profile denies reading messages — no stored data was sent to a reply model",
        )
      const since = momentOf(sinceTime ?? `${DRY_RUN_DAYS}d`, "--since-time")
      const path = repliesPathFor(messenger.app, settings.profile, env)
      const { rules, audience } = readReplies(path, messenger.provider)
      if (rules.length === 0) {
        renderer.note(`no reply rules yet — they live in ${path}`)
      }
      for (const warning of audienceWarnings(audience)) renderer.warn(warning)
      const found = await context.withStore(
        (store, account) =>
          dryRun(store, account, rules, {
            since,
            audience,
            render: replyRenderer(
              messenger.app,
              settings.profile,
              () => messenger.resolveSettings({ profile: settings.profile }, { env }),
              env,
              renderer.warn,
              { ai: ai === true, preview: ai !== true, signal: controller.signal },
            ),
            ...(rule === undefined ? {} : { only: rule }),
          }),
        { name: "replies test" },
      )
      if (found.botUnknown > 0) {
        renderer.note(`${found.botUnknown} sender(s) not known as bot or person; taken as people`)
      }
      renderer.note(`only what this machine has stored from ${found.since} to ${found.until} was read`)
      if (format !== "pretty") {
        renderer.result(found)
        return
      }
      const lines = found.rules.flatMap(({ id, would, skipped }) => [
        `${id}: would act on ${would.length}`,
        ...would.map(
          (one) =>
            `  ${one.at}  ${one.chatTitle ?? one.chatId} → ${one.to.name ?? one.to.id}: ${[
              one.text === null ? undefined : JSON.stringify(one.text),
              one.task ? "a task" : undefined,
              one.reason,
              ...(one.blocks ?? []).map(
                (block) =>
                  `ai instruction: ${JSON.stringify(block.instruction)}; fallback: ${JSON.stringify(block.fallback)}`,
              ),
            ]
              .filter(Boolean)
              .join(" + ")}`,
        ),
        ...Object.entries(skipped)
          .sort(([, a], [, b]) => b - a)
          .map(([why, count]) => `  passed over ${count}: ${why}`),
      ])
      streams.data(`${lines.join("\n")}\n`)
    })

  const switched = (on: boolean) =>
    async function (this: Command) {
      const { settings, renderer, env } = messengerContext(this, messenger)
      const path = repliesStatePathFor(messenger.app, settings.profile, env)
      writeRepliesState(path, paused(readRepliesState(path), on))
      renderer.note(on ? "reply rules paused — a running serve stops answering now" : "reply rules on again")
      renderer.result({ paused: on })
    }

  replies
    .command("pause")
    .description("stop every reply rule of this profile at once, a running serve too; resume undoes it")
    .action(switched(true))

  replies.command("resume").description("let the reply rules answer again after pause").action(switched(false))

  replies
    .command("status")
    .description("whether the rules may send, which are on, and who they may answer")
    .action(async function (this: Command) {
      const { settings, renderer, env } = messengerContext(this, messenger)
      const { rules, audience } = readReplies(repliesPathFor(messenger.app, settings.profile, env), messenger.provider)
      const warnings = audienceWarnings(audience)
      for (const warning of warnings) renderer.warn(warning)
      const state = readRepliesState(repliesStatePathFor(messenger.app, settings.profile, env))
      const level = levelFor(settings.permissions ?? {}, "replies.send").level
      if (level !== "allow") renderer.note(`replies.send is ${level}: serve sends nothing until it is allow`)
      renderer.result({
        paused: state.paused,
        send: level,
        audience: {
          reply: audience.reply,
          allow: audience.allow.people.length + audience.allow.chats.length,
          deny: audience.deny.people.length + audience.deny.chats.length,
        },
        warnings,
        rules: rules.map(({ id, on }) => ({ id, on })),
      })
    })

  return replies
}
