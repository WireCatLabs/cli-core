import { join } from "node:path"
import { CliError, type KeyringStore, resolvePaths } from "@wirecat/cli-base"
import { annotate } from "@wirecat/cli-base/commands"
import { Command } from "commander"
import { type AccountRemoval, accountRemoveCommand } from "../../cli/account-remove.js"
import { baseContext, environmentOf } from "../../cli/context.js"
import { LOCAL_READ, LOCAL_WRITE } from "../../cli/effects.js"
import { profilesHere, recalledAccount, rememberAccount } from "../../cli/messenger/accounts.js"
import { ProfileTokenStore } from "../../cli/profile-token.js"
import type { GlobalFlags, ResolveOptions, Settings } from "../../cli/settings.js"
import type { TokenSessionOptions } from "../../cli/token-session.js"
import type { AppIdentity } from "../../ports/app.js"
import { CRM_SHARED_FOLDERS } from "../state-folders.js"

export interface CrmAccountContext {
  env: NodeJS.ProcessEnv
  /** The run's keyring; `undefined` is the system one. */
  keyring?: KeyringStore
}

/** The CRM account a profile holds: `account` as the store names it, `user` where one account has several users. */
export interface CrmHeld {
  account: string
  user?: string
  /** A sign-in is saved for the profile here. False: only what `session start` remembered outlives `session end`. */
  signedIn: boolean
}

/** `addCrmCommands`'s `account`: mounts `account remove`, which refuses `--delete-data` on an account others read. */
export interface CrmAccountOptions {
  /** The store's provider name for the CRM, the `provider` of the account's `AccountKey`. */
  provider: string
  /** The CRM's name, as the owner knows it: "HubSpot". */
  service: string
  /**
   * What a profile holds, from its saved sign-in or else from what `session start` remembered. Unset: the account
   * `rememberAccount` recorded, signed in while a token is saved in the profile's entry.
   */
  held?: (profile: string, context: CrmAccountContext) => CrmHeld | undefined
  /** Parts of `account remove`'s own: the sign-out's words, an OAuth entry among `secrets`. */
  removal?: Partial<AccountRemoval>
  /** Unset: the one `run()` set. */
  resolveSettings?: (flags: GlobalFlags, options?: ResolveOptions) => Settings
}

const SHARED: ReadonlySet<string> = new Set(Object.values(CRM_SHARED_FOLDERS))

const savedToken = (tokens: ProfileTokenStore, profile: string) => {
  const saved = tokens.read(profile)
  // `<PREFIX>_TOKEN` is every profile's at once, so it is no profile's own sign-in.
  return saved !== undefined && saved.source !== "environment"
}

const heldBy = (app: AppIdentity, options: CrmAccountOptions) => (profile: string, context: CrmAccountContext) => {
  try {
    if (options.held) return options.held(profile, context)
    const account = recalledAccount(app, options.provider, profile, context.env)?.account
    if (account === undefined) return undefined
    const tokens = new ProfileTokenStore({ app, ...context })
    return { account, signedIn: savedToken(tokens, profile) }
  } catch {
    // A keyring that does not answer for one profile must not stop the check of the others.
    return undefined
  }
}

const also = (names: readonly string[]) => `${names.join(", ")} also read${names.length === 1 ? "s" : ""}`

export interface CrmSignIn extends CrmAccountContext {
  /** The profile signing in. */
  profile: string
  /** The profiles the configuration names; those `session start` remembered are added. */
  profiles?: readonly string[]
}

/**
 * Refuses a sign-in to an account and user another profile here is signed in to: two profiles would sync the same
 * copy twice and split its permissions. A profile that ended its session no longer holds the account.
 */
export const refuseTakenCrmAccount = (
  app: AppIdentity,
  options: CrmAccountOptions,
  { profile, profiles = [], ...context }: CrmSignIn,
  at: { account: string; user?: string },
): void => {
  const held = heldBy(app, options)
  const other = profilesHere(app, profiles, context.env).find((one) => {
    if (one === profile) return false
    const found = held(one, context)
    return found?.signedIn === true && found.account === at.account && found.user === at.user
  })
  if (!other) return
  const command = app.command
  throw new CliError(
    "conflict",
    `profile ${other} already signs in to ${options.service} account ${at.account}` +
      `${at.user === undefined ? "" : ` as user ${at.user}`}. Use \`${command} ${other}\`, sign it in again with ` +
      `\`${command} ${other} session start\`, or end it with \`${command} ${other} session end\` first`,
    { reason: "session.duplicate", profile: other, account: at.account },
  )
}

/** `claim` for `tokenSessionCommand`: refuses an account another profile is signed in to, then remembers it. */
export const crmAccountClaim =
  (app: AppIdentity, options: CrmAccountOptions): NonNullable<TokenSessionOptions["claim"]> =>
  (env, profile, id, _tokens, keyring) => {
    refuseTakenCrmAccount(app, options, { env, profile, ...(keyring ? { keyring } : {}) }, { account: id })
    rememberAccount(app, profile, id, env)
  }

/** The store keeps one copy per account, so deleting one profile's data deletes every profile's on that account. */
const refuseSharedDelete = (app: AppIdentity, options: CrmAccountOptions, command: Command) => {
  const given = command.opts<{ deleteData?: boolean; dryRun?: boolean }>()
  if (given.deleteData !== true) return
  const resolveSettings = options.resolveSettings ?? environmentOf(command).resolveSettings
  if (!resolveSettings) return
  const { env, keyring, settings, renderer } = baseContext(command, resolveSettings)
  const context = { env, ...(keyring ? { keyring } : {}) }
  const held = heldBy(app, options)
  const own = held(settings.profile, context)?.account
  if (own === undefined) return
  const sharing = settings.profilesHere.filter((one) => one !== settings.profile && held(one, context)?.account === own)
  if (sharing.length === 0) return
  if (given.dryRun === true) {
    renderer.warn(`without --dry-run this refuses: ${also(sharing)} ${options.service} account ${own}`)
    return
  }
  const names = sharing.join(", ")
  throw new CliError(
    "conflict",
    `${also(sharing)} ${options.service} account ${own}, and the store keeps one copy of an account: ` +
      `--delete-data would delete their deals, contacts and companies too. Use --keep-data, or remove ${names} first`,
    { reason: "account-remove.account-shared", profiles: sharing, account: own },
  )
}

const removalOf = (app: AppIdentity, options: CrmAccountOptions): AccountRemoval => {
  const held = heldBy(app, options)
  const folders = (env: NodeJS.ProcessEnv) => resolvePaths({ appName: app.appName, prefix: app.envPrefix, env })
  return {
    // A CRM's API token has no call that revokes it; the CRM's own settings do.
    signOut: async (profile) => ({
      revoked: null,
      removed: [`the sign-in of ${profile} (the token stays valid in ${options.service} until you delete it there)`],
    }),
    account: (profile, context) => {
      const found = held(profile, context)
      return found ? { provider: options.provider, account: found.account } : undefined
    },
    secrets: (profile, { env, keyring }) => [
      {
        credentials: {
          configDir: folders(env).config,
          service: app.appName,
          envVar: `${app.envPrefix}_TOKEN`,
          env,
          ...(keyring ? { keyring } : {}),
        },
        accounts: [`token:${profile}`],
      },
    ],
    // A profile named after a folder every account shares has no folder of its own there.
    stateFiles: (profile, { env }) => (SHARED.has(profile) ? [] : [join(folders(env).state, "crm", profile)]),
    ...options.removal,
  }
}

/**
 * `account remove` of a CRM CLI: cli-core's own, which refuses `--delete-data` while another profile here reads the
 * same account, whose one copy the store shares. Under `--dry-run` it warns instead.
 */
export const crmAccountCommand = (app: AppIdentity, options: CrmAccountOptions): Command =>
  annotate(new Command("account"), { effects: LOCAL_READ })
    .description("this profile on this computer")
    .addCommand(
      annotate(
        accountRemoveCommand(app, removalOf(app, options), {
          ...(options.resolveSettings ? { resolveSettings: options.resolveSettings } : {}),
        }),
        { effects: LOCAL_WRITE },
      ).hook("preAction", (_, action) => refuseSharedDelete(app, options, action)),
    )
