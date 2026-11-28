import { annotate } from "@wirecat/cli-base/commands"
import { Command } from "commander"
import { withoutPhone } from "../../services/people.js"
import { accountRemoveCommand } from "../account-remove.js"
import { accountRenameCommand } from "../account-rename.js"
import { REMOTE_READ, REMOTE_WRITE } from "../effects.js"
import { itemOf, renderAnswer } from "../envelope.js"
import { accountDevicesCommand } from "./account-devices-command.js"
import { photoHelp, readProfilePhoto } from "./admin-commands.js"
import { accountAnswer, renderItem } from "./chat-answers.js"
import { type Messenger, messengerContext } from "./context.js"
import { hideNever } from "./lacks.js"
import { privacyCommand } from "./records-command.js"

export const accountCommand = (messenger: Messenger): Command => {
  const tool = `${messenger.app.command} personal`
  const account = new Command("account")
    .description("the logged-in account")
    .addCommand(
      annotate(new Command("show"), {
        effects: REMOTE_READ,
        output: { entity: "account" },
        examples: [`${tool} account show`],
      })
        .description("who this profile is logged in as, with the phone number")
        .option("--hide-phone", "leave the phone number out")
        .action(async function (this: Command) {
          const hide = this.opts<{ hidePhone?: boolean }>().hidePhone === true
          const context = messengerContext(this, messenger)
          const account = await context.withMessenger((connection) => connection.me())
          renderAnswer(this, context, itemOf(accountAnswer(messenger.provider, hide ? withoutPhone(account) : account)))
        }),
    )
    .addCommand(
      annotate(new Command("update"), {
        effects: REMOTE_WRITE,
        output: { entity: "account_change" },
        examples: [`${tool} account update --first-name Alex`],
      })
        .description("change the name, the description or the photo everyone sees on your profile")
        .option("--first-name <name>", "your first name")
        .option("--last-name <name>", "your last name")
        .option("--description <text>", "about you")
        .option("--photo <file>", `a new profile photo — ${photoHelp(messenger)}`)
        .option("--hide-phone", "leave the phone number out of the answer")
        .action(async function (this: Command) {
          const context = messengerContext(this, messenger)
          const { firstName, lastName, description, photo, hidePhone } = this.opts<{
            firstName?: string
            lastName?: string
            description?: string
            photo?: string
            hidePhone?: boolean
          }>()
          const upload = photo === undefined ? undefined : await readProfilePhoto(messenger, photo, context.env)
          const changed = await context.withServices((services) =>
            services.account.update({
              ...(firstName === undefined ? {} : { firstName }),
              ...(lastName === undefined ? {} : { lastName }),
              ...(description === undefined ? {} : { description }),
              ...(upload === undefined ? {} : { photo: upload }),
            }),
          )
          renderItem(this, context, hidePhone ? { ...changed, account: withoutPhone(changed.account) } : changed)
        }),
    )
    .addCommand(accountDevicesCommand(messenger))
  if (messenger.accountRemoval)
    account.addCommand(
      accountRemoveCommand(messenger.app, messenger.accountRemoval, {
        provider: messenger.provider,
        resolveSettings: messenger.resolveSettings,
      }),
    )
  const renaming = messenger.accountRemoval
  if (renaming?.signIn)
    account.addCommand(
      accountRenameCommand(
        messenger.app,
        { ...renaming, signIn: renaming.signIn },
        {
          resolveSettings: messenger.resolveSettings,
        },
      ),
    )
  if (messenger.privacy === true) account.addCommand(privacyCommand(messenger))
  return hideNever(messenger, account)
}
