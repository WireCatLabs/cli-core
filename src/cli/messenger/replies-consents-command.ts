import { CliError } from "@wirecat/cli-base"
import { annotate } from "@wirecat/cli-base/commands"
import { Command } from "commander"
import { modelTarget } from "../../models/index.js"
import { readReplyConsent, replyConsentPathFor, replyModelIdentity, writeReplyConsent } from "../../replies/consents.js"
import { renderItem } from "./chat-answers.js"
import { type Messenger, messengerContext } from "./context.js"

export const replyConsentsCommand = (messenger: Messenger): Command => {
  const consents = new Command("consents").description(
    "consent for reply models once per profile and endpoint, with chat opt-outs",
  )
  consents
    .command("show")
    .description("show the reply model consent and chat opt-outs; never calls a model")
    .action(function (this: Command) {
      const context = messengerContext(this, messenger)
      const { settings, env } = context
      renderItem(this, context, readReplyConsent(replyConsentPathFor(messenger.app, settings.profile, env)))
    })
  for (const grant of [true, false])
    consents.addCommand(
      annotate(new Command(grant ? "grant" : "revoke"), { mutates: true, local: true })
        .description(
          grant
            ? "allow incoming message data to go to the configured reply model for this profile; chat opt-outs remain"
            : "revoke the profile's reply model consent immediately; chat opt-outs remain",
        )
        .action(function (this: Command) {
          const context = messengerContext(this, messenger)
          const { settings, env } = context
          const path = replyConsentPathFor(messenger.app, settings.profile, env)
          const consent = readReplyConsent(path)
          if (grant) {
            const target = modelTarget(settings, "replies")
            if (!target)
              throw new CliError(
                "configuration_error",
                "set models.replies.provider and models.replies.model before replies consents grant",
              )
            consent.provider = replyModelIdentity(
              target.provider,
              target.baseUrl ??
                (target.provider === "anthropic" ? "https://api.anthropic.com" : "https://api.openai.com/v1"),
            )
          } else consent.provider = null
          writeReplyConsent(path, consent)
          renderItem(this, context, consent)
        }),
    )
  for (const deny of [true, false])
    consents.addCommand(
      annotate(new Command(deny ? "deny" : "allow"), { mutates: true, local: true })
        .description(
          deny
            ? "keep this chat's incoming data away from the reply model"
            : "remove this chat's model opt-out; does not grant profile consent",
        )
        .argument("<chat>", "the native chat id, used as written; never resolved over the network")
        .action(function (this: Command, chat: string) {
          if (!chat.trim()) throw new CliError("validation_error", "a chat id cannot be empty")
          const context = messengerContext(this, messenger)
          const { settings, env } = context
          const path = replyConsentPathFor(messenger.app, settings.profile, env)
          const consent = readReplyConsent(path)
          consent.deniedChats = consent.deniedChats.filter((id) => id !== chat)
          if (deny) consent.deniedChats.push(chat)
          writeReplyConsent(path, consent)
          renderItem(this, context, consent)
        }),
    )
  return consents
}
