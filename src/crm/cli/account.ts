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
import { oauthAccount } from "../../oauth/storage.js"
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
   * `rememberAccount` recorded, signed in while a token is saved in the profile's entry. A CLI whose remembered
   * account is not the store's name for it (bitrix24's and amo's `<host>:<userId>`) passes its own.
   */
  held?: (profile: string, context: CrmAccountContext) => CrmHeld | undefined
  /** What `account remove` says the sign-out removed, when the CRM keeps more than a token valid. */
  signedOut?: (profile: string) => string
  /** Unset: the one `run()` set. `crmAccountClaim` needs it to see the profiles the configuration names. */
  resolveSettings?: (flags: GlobalFlags, options?: ResolveOptions) => Settings
}

const SHARED: ReadonlySet<string> = new Set(Object.values(CRM_SHARED_FOLDERS))
// A folder named Files is the folder files on macOS and Windows.
const isShared = (profile: string) => SHARED.has(profile.toLowerCase())

/** The account alone, which the delete guard needs: the default reads no keyring, so it cannot fail. */
const accountBy = (app: AppIdentity, options: CrmAccountOptions) => (profile: string, context: CrmAccountContext) =>
  options.held
    ? options.held(profile, context)?.account
    : recalledAccount(app, options.provider, profile, context.env)?.account

type Tokens = Pick<ProfileTokenStore, "read">

const signedInBy =
  (app: AppIdentity, options: CrmAccountOptions, tokens: Tokens | undefined) =>
  (profile: string, context: CrmAccountContext): CrmHeld | undefined => {
    try {
      if (options.held) return options.held(profile, context)
      const account = recalledAccount(app, options.provider, profile, context.env)?.account
      if (account === undefined) return undefined
      const saved = (tokens ?? new ProfileTokenStore({ app, ...context, warn: () => {} })).read(profile)
      // `<PREFIX>_TOKEN` is every profile's at once, so it is no profile's own sign-in.
      return { account, signedIn: saved !== undefined && saved.source !== "environment" }
    } catch {
      // A keyring that does not answer for one profile must not stop another profile's sign-in.
      return undefined
    }
  }

const also = (names: readonly string[]) => `${names.join(", ")} also read${names.length === 1 ? "s" : ""}`

export interface CrmSignIn extends CrmAccountContext {
  /** The profile signing in. */
  profile: string
  /** The profiles the configuration names; those `session start` remembered are added. */
  profiles?: readonly string[]
  /** The run's token store, whose warnings go where the run's do. Unset: one that keeps them quiet. */
  tokens?: Tokens
}

/**
 * Refuses a sign-in to an account and user another profile here is signed in to: two profiles would sync the same
 * copy twice and split its permissions. A profile that ended its session no longer holds the account.
 */
export const refuseTakenCrmAccount = (
  app: AppIdentity,
  options: CrmAccountOptions,
  { profile, profiles = [], tokens, ...context }: CrmSignIn,
  at: { account: string; user?: string },
): void => {
  if (isShared(profile))
    throw new CliError(
      "validation_error",
      `"${profile}" names a folder every account shares, where this profile's own files would land. Pick another ` +
        `name than ${Object.values(CRM_SHARED_FOLDERS).join(" or ")}`,
      { reason: "profile.reserved", profile },
    )
  const held = signedInBy(app, options, tokens)
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
      `${at.user === undefined ? "" : ` as user ${at.user}`}. Use \`${command} ${other}\`, ` +
      // Another user's token on the account is a second sign-in only where the account has users.
      (at.user === undefined ? "" : `sign it in again with \`${command} ${other} session start\`, `) +
      `or end it with \`${command} ${other} session end\` first`,
    { reason: "session.duplicate", profile: other, account: at.account },
  )
}

/** `claim` for `tokenSessionCommand`: refuses an account another profile is signed in to, then remembers it. */
export const crmAccountClaim =
  (app: AppIdentity, options: CrmAccountOptions): NonNullable<TokenSessionOptions["claim"]> =>
  (env, profile, id, tokens, keyring) => {
    const profiles = options.resolveSettings?.({}, { env, needsProfile: false }).configuredProfiles ?? []
    refuseTakenCrmAccount(
      app,
      options,
      { env, profile, profiles, tokens, ...(keyring ? { keyring } : {}) },
      { account: id },
    )
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
  const accountOf = accountBy(app, options)
  const read = (profile: string) => {
    try {
      return accountOf(profile, context)
    } catch {
      throw new CliError(
        "conflict",
        `${app.command} could not tell which ${options.service} account ${profile} holds, so --delete-data could ` +
          `delete a copy ${profile} still reads. Fix ${profile}'s sign-in, or use --keep-data`,
        { reason: "account-remove.account-unknown", profile },
      )
    }
  }
  const own = read(settings.profile)
  if (own === undefined) return
  const sharing = settings.profilesHere.filter((one) => one !== settings.profile && read(one) === own)
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
  const accountOf = accountBy(app, options)
  const folders = (env: NodeJS.ProcessEnv) => resolvePaths({ appName: app.appName, prefix: app.envPrefix, env })
  return {
    // A CRM's API token has no call that revokes it; the CRM's own settings do.
    signOut: async (profile) => ({
      revoked: null,
      removed: [
        options.signedOut?.(profile) ??
          `the sign-in of ${profile} (the token stays valid in ${options.service} until you delete it there)`,
      ],
    }),
    account: (profile, context) => {
      try {
        const account = accountOf(profile, context)
        return account === undefined ? undefined : { provider: options.provider, account }
      } catch {
        // --delete-data was refused before this; --keep-data only names the account it keeps.
        return undefined
      }
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
        // An OAuth sign-in's entry; removing a missing one is fine.
        accounts: [`token:${profile}`, oauthAccount(options.provider, profile)],
      },
    ],
    // A profile named after a folder every account shares has no folder of its own there.
    stateFiles: (profile, { env }) => (isShared(profile) ? [] : [join(folders(env).state, "crm", profile)]),
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
      accountRemoveCommand(app, removalOf(app, options), {
        ...(options.resolveSettings ? { resolveSettings: options.resolveSettings } : {}),
        effects: LOCAL_WRITE,
      }).hook("preAction", (_, action) => refuseSharedDelete(app, options, action)),
    )
