import { existsSync } from "node:fs"
import { annotate } from "@wirecat/cli-base/commands"
import { Command } from "commander"
import { withoutPhone } from "../../services/people.js"
import { storePath } from "../../store/path.js"
import { openStore } from "../../store/store.js"
import { LOCAL_READ, REMOTE_READ } from "../effects.js"
import { itemOf, renderAnswer } from "../envelope.js"
import { queryTerms, withQuery } from "../list-query.js"
import { profileFree } from "../profile.js"
import { NONE_NAMED } from "../settings.js"
import { ACCOUNT_PROFILES_QUERY } from "./account-profile-query.js"
import { recalledAccount } from "./accounts.js"
import { accountAnswer, wholeList } from "./chat-answers.js"
import { type Messenger, messengerContext } from "./context.js"

const storeOf = async (env: NodeJS.ProcessEnv) =>
  existsSync(storePath(env)) ? await openStore({ env }).catch(() => undefined) : undefined

/** What `session list` answers: the profiles here and the account each is logged in as. */
export const listProfiles = async (command: Command, messenger: Messenger, words: string[], label: string) => {
  const terms = queryTerms(words, ACCOUNT_PROFILES_QUERY, label)
  const context = messengerContext(command, messenger, { needsProfile: false })
  const { app, provider } = messenger
  const current = context.settings.sources.profile === NONE_NAMED ? undefined : context.settings.profile
  const { profilesHere, accountProfiles = profilesHere, botProfiles = [] } = context.settings
  const isAccount = (profile: string) =>
    accountProfiles.includes(profile) || messenger.profileState?.(profile, context.env) === "signed-in"
  const profiles = [...new Set([...(current === undefined ? [] : [current]), ...profilesHere.filter(isAccount)])]
    .filter((profile) => terms.get("profile") === undefined || profile === terms.get("profile"))
    .filter(
      (profile) =>
        terms.get("current") === undefined ||
        (profile === current) === (terms.get("current")?.toLowerCase() === "true"),
    )
    .sort()
  const store = await storeOf(context.env)
  try {
    const items = []
    for (const profile of profiles) {
      const key = recalledAccount(app, provider, profile, context.env)
      items.push({
        profile,
        current: profile === current,
        account: key?.account ?? null,
        name: key && store ? await store.accounts.accountName(key) : null,
        ...(messenger.profileState ? { signed_in: messenger.profileState(profile, context.env) !== "signed-out" } : {}),
        ...(botProfiles.includes(profile) ? { bot: true } : {}),
      })
    }
    renderAnswer(command, context, wholeList(label, items))
  } finally {
    await store?.close()
  }
}

/**
 * `session status` and `session list`, for a messenger's own `session` group beside its `start` and `end`
 * (WC-ACCT-12). Both read this computer; only `status --check` asks the messenger.
 */
export const messengerSessionCommands = (messenger: Messenger): Command[] => {
  const cli = messenger.app.command
  const status = annotate(new Command("status"), {
    effects: REMOTE_READ,
    examples: [`${cli} personal session status`, `${cli} personal session status --check --json`],
  })
    .summary("show whether this profile is logged in, and as whom")
    .description(
      "show whether this profile has a session on this computer and the account it was logged in as; " +
        "--check asks the messenger whose the session is, without the phone number (`account show` has it)",
    )
    .option("--check", "ask the messenger whether the session still works, and whose it is")
    .action(async function (this: Command, { check }: { check?: boolean }) {
      const context = messengerContext(this, messenger)
      const { profile, env } = context
      const { botProfiles = [] } = context.settings
      const key = recalledAccount(messenger.app, messenger.provider, profile, env)
      const state = messenger.profileState?.(profile, env)
      const signedIn = state === undefined ? key !== undefined : state !== "signed-out"
      const bot = botProfiles.includes(profile) ? { bot: true } : {}
      if (!check || !signedIn) {
        const store = key ? await storeOf(env) : undefined
        try {
          const name = key && store ? await store.accounts.accountName(key) : null
          renderAnswer(
            this,
            context,
            itemOf({ profile, signed_in: signedIn, account: key?.account ?? null, name, ...bot, verified: false }),
          )
        } finally {
          await store?.close()
        }
        return
      }
      const me = await context.withMessenger((connection) => connection.me())
      const { id, ...who } = accountAnswer(messenger.provider, withoutPhone(me))
      renderAnswer(this, context, itemOf({ profile, signed_in: true, account: id, ...who, ...bot, verified: true }))
    })
  const list = profileFree(
    withQuery(
      annotate(new Command("list"), {
        effects: LOCAL_READ,
        examples: [`${cli} session list`, `${cli} session list --json`],
      }),
      ACCOUNT_PROFILES_QUERY,
    ),
  )
    .summary("list the profiles on this computer and the account each is logged in as")
    .description(
      "every account profile on this computer, and the account each is logged in as; a name that is only a bot " +
        "is left out (`bot list` has it), one that is a bot too says `bot: true`; asks the messenger nothing",
    )
    .action(async function (this: Command, words: string[]) {
      await listProfiles(this, messenger, words, "session list")
    })
  return [status, list]
}
