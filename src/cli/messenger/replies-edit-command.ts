import { annotate } from "@wirecat/cli-base/commands"
import { Command, Option } from "commander"
import { type AudienceEdits, addRule, editAudience, editRule, type RuleEdits, switchRule } from "../../replies/edit.js"
import { audienceWarnings, repliesPathFor } from "../../replies/rules.js"
import type { Warn } from "../../runs/events.js"
import { grantsAuthority, LOCAL_WRITE } from "../effects.js"
import { renderItem } from "./chat-answers.js"
import { type Messenger, messengerContext } from "./context.js"

export const REPLY_EDIT_OPTIONS = [
  ["--do <actions>", "actions: reply, task, or both, comma-separated"],
  ["--kinds <kinds>", "chat kinds: dialog, group; comma-separated, empty for any"],
  ["--allow-chats <ids>", "only these chat ids, comma-separated; empty for any"],
  ["--deny-chats <ids>", "leave these chat ids out, comma-separated; empty clears"],
  ["--words <words>", "match any of these whole words, comma-separated; empty clears"],
  ["--question", "match only questions"],
  ["--no-question", "do not require a question"],
  ["--mentions-me", "require a mention of you or a reply to you"],
  ["--no-mentions-me", "do not require a mention of you or a reply to you"],
  ["--allow-people <ids>", "only these sender ids, comma-separated; empty for any"],
  ["--deny-people <ids>", "leave these sender ids out, comma-separated; empty clears"],
  ["--contacts-only", "match only contacts"],
  ["--no-contacts-only", "do not require a contact"],
  ["--template <text>", "the reply template"],
  ["--template-mode <mode>", "legacy template mode: fill-only or may-reword; use ai blocks instead"],
  ["--as-reply", "send as a reply to the matched message"],
  ["--no-as-reply", "send without linking to the matched message"],
  ["--per-chat <limit>", "at most this many per chat, such as 1/12h"],
  ["--per-person <limit>", "at most this many per person, such as 1/1d"],
  ["--outside <hours>", "answer outside this 24-hour window, such as 09:00-19:00"],
  ["--days <days>", "days of the working window, such as mon-fri or sat,sun"],
  ["--timezone <zone>", "the IANA timezone for the working window"],
  ["--no-hours", "clear the working window"],
] as const

export const REPLY_AUDIENCE_OPTIONS = [
  ["--reply <mode>", "answer all or only listed senders and chats: all, listed"],
  ["--allow-people <ids>", "replace allowed sender ids, comma-separated; empty clears"],
  ["--allow-chats <ids>", "replace allowed chat ids, comma-separated; empty clears"],
  ["--deny-people <ids>", "replace denied sender ids, comma-separated; empty clears; deny wins"],
  ["--deny-chats <ids>", "replace denied chat ids, comma-separated; empty clears; deny wins"],
] as const

export const addReplyEditors = (replies: Command, messenger: Messenger): void => {
  replies.addCommand(
    grantsAuthority(annotate(new Command("add"), { effects: LOCAL_WRITE }))
      .description("add a rule with every default written out, off until you edit and enable it")
      .argument("<id>", "lower-case letters, digits and -; unique in this profile")
      .action(function (this: Command, id: string) {
        const context = messengerContext(this, messenger)
        const { settings, env } = context
        renderItem(this, context, addRule(repliesPathFor(messenger.app, settings.profile, env), messenger.provider, id))
      }),
  )
  for (const on of [true, false]) {
    replies.addCommand(
      grantsAuthority(annotate(new Command(on ? "on" : "off"), { effects: LOCAL_WRITE }))
        .description(on ? "enable one reply rule; its template must be ready" : "disable one reply rule")
        .argument("<id>", "the rule's id")
        .action(function (this: Command, id: string) {
          const context = messengerContext(this, messenger)
          const { settings, env } = context
          renderItem(
            this,
            context,
            switchRule(repliesPathFor(messenger.app, settings.profile, env), messenger.provider, id, on),
          )
        }),
    )
  }
  const edit = grantsAuthority(annotate(new Command("edit"), { effects: LOCAL_WRITE }))
    .description("change only the named fields of a reply rule; lists replace the whole list")
    .argument("<id>", "the rule's id")
  for (const [flag, help] of REPLY_EDIT_OPTIONS) {
    const option = new Option(flag, help)
    if (flag === "--template-mode <mode>") option.conflicts("model")
    edit.addOption(option)
  }
  edit.addOption(
    new Option("--model <mode>", "compatibility alias for --template-mode").hideHelp().conflicts("templateMode"),
  )
  // Commander gives negated-only flags a true default; omission must preserve the saved field.
  edit.action(function (this: Command, id: string) {
    const options = this.opts<RuleEdits & { templateMode?: string }>()
    if (this.getOptionValueSource("hours") === "default") delete options.hours
    const context = messengerContext(this, messenger)
    const { settings, env } = context
    renderItem(
      this,
      context,
      editRule(repliesPathFor(messenger.app, settings.profile, env), messenger.provider, id, {
        ...options,
        model: options.templateMode ?? options.model,
      }),
    )
  })
  replies.addCommand(edit)
  const audience = grantsAuthority(annotate(new Command("audience"), { effects: LOCAL_WRITE })).description(
    "show the reply audience, who the rules may answer, or replace its named fields; a new file answers everyone a rule matches",
  )
  for (const [flag, help] of REPLY_AUDIENCE_OPTIONS) audience.option(flag, help)
  audience.action(function (this: Command) {
    const context = messengerContext(this, messenger)
    const { settings, renderer, env } = context
    const answer = editAudience(
      repliesPathFor(messenger.app, settings.profile, env),
      messenger.provider,
      this.opts<AudienceEdits>(),
    )
    const warn: Warn = renderer.warn
    for (const { text, warning } of audienceWarnings(answer)) warn(text, warning)
    renderItem(this, context, answer)
  })
  replies.addCommand(audience)
}
