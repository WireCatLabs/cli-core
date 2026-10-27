import { existsSync } from "node:fs"
import { annotate } from "@wirecat/cli-base/commands"
import { Command } from "commander"
import { maskedAccount } from "../../services/people.js"
import { storePath } from "../../store/path.js"
import { openStore } from "../../store/store.js"
import { REMOTE_READ, REMOTE_WRITE } from "../effects.js"
import { itemOf, renderAnswer } from "../envelope.js"
import { queryTerms, withQuery } from "../list-query.js"
import { NONE_NAMED } from "../settings.js"
import { ACCOUNT_PROFILES_QUERY } from "./account-profile-query.js"
import { accountSessionsCommand } from "./account-sessions-command.js"
import { recalledAccount } from "./accounts.js"
import { photoHelp, readProfilePhoto } from "./admin-commands.js"
import { accountAnswer, renderItem, wholeList } from "./chat-answers.js"
import { type Messenger, messengerContext } from "./context.js"
import { hideNever } from "./lacks.js"
import { privacyCommand } from "./records-command.js"

export const accountCommand = (messenger: Messenger): Command => {
  const tool = `${messenger.app.command} personal`
  const account = new Command("account")
    .description("the logged-in account")
    .addCommand(
      withQuery(
        annotate(new Command("list"), { effects: REMOTE_READ, examples: [`${tool} account list`] }),
        ACCOUNT_PROFILES_QUERY,
      )
        .summary("profiles on this computer and their signed-in accounts")
        .description("every profile on this computer, and the account each is logged in as; asks the messenger nothing")
        .action(async function (this: Command, words: string[]) {
          const terms = queryTerms(words, ACCOUNT_PROFILES_QUERY, "account list")
          const context = messengerContext(this, messenger, { needsProfile: false })
          const { app, provider } = messenger
          const current = context.settings.sources.profile === NONE_NAMED ? undefined : context.settings.profile
          const profiles = [...new Set([...(current === undefined ? [] : [current]), ...context.settings.profilesHere])]
            .filter((profile) => terms.get("profile") === undefined || profile === terms.get("profile"))
            .filter(
              (profile) =>
                terms.get("current") === undefined ||
                (profile === current) === (terms.get("current")?.toLowerCase() === "true"),
            )
            .sort()
          const store = existsSync(storePath(context.env))
            ? await openStore({ env: context.env }).catch(() => undefined)
            : undefined
          try {
            const items = []
            for (const profile of profiles) {
              const key = recalledAccount(app, provider, profile, context.env)
              items.push({
                profile,
                current: profile === current,
                account: key?.account ?? null,
                name: key && store ? await store.accounts.accountName(key) : null,
                ...(messenger.profileState
                  ? { signed_in: messenger.profileState(profile, context.env) !== "signed-out" }
                  : {}),
              })
            }
            renderAnswer(this, context, wholeList("account list", items))
          } finally {
            await store?.close()
          }
        }),
    )
    .addCommand(
      annotate(new Command("show"), {
        effects: REMOTE_READ,
        output: { entity: "account" },
        examples: [`${tool} account show`],
      })
        .description("who this profile is logged in as; the phone number shows its last four digits")
        .option("--show-phone", "print the whole phone number")
        .action(async function (this: Command) {
          const whole = this.opts<{ showPhone?: boolean }>().showPhone === true
          const context = messengerContext(this, messenger)
          const account = await context.withMessenger((connection) => connection.me())
          renderAnswer(
            this,
            context,
            itemOf(accountAnswer(messenger.provider, whole ? account : maskedAccount(account))),
          )
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
        .action(async function (this: Command) {
          const context = messengerContext(this, messenger)
          const { firstName, lastName, description, photo } = this.opts<{
            firstName?: string
            lastName?: string
            description?: string
            photo?: string
          }>()
          const upload = photo === undefined ? undefined : await readProfilePhoto(messenger, photo, context.env)
          renderItem(
            this,
            context,
            await context.withServices((services) =>
              services.account.update({
                ...(firstName === undefined ? {} : { firstName }),
                ...(lastName === undefined ? {} : { lastName }),
                ...(description === undefined ? {} : { description }),
                ...(upload === undefined ? {} : { photo: upload }),
              }),
            ),
          )
        }),
    )
    .addCommand(accountSessionsCommand(messenger))
  if (messenger.privacy === true) account.addCommand(privacyCommand(messenger))
  return hideNever(messenger, account)
}
