import { existsSync, rmSync } from "node:fs"
import { homedir } from "node:os"
import { resolve as absolute, isAbsolute, join, sep } from "node:path"
import {
  CliError,
  Credentials,
  type CredentialsOptions,
  isMovedRun,
  type KeyringStore,
  resolvePaths,
  saveConfigFile,
} from "@wirecat/cli-base"
import { annotate } from "@wirecat/cli-base/commands"
import { Command } from "commander"
import { lockPath, readLock, servingProfiles } from "../background/lock.js"
import { alive } from "../background/processes.js"
import { listSchedules, type Schedule, scheduleFile, timerFor } from "../background/schedules.js"
import { type ServerSystem, thisMachine } from "../background/system.js"
import { locationVariables, platformFor, type Unit } from "../background/units.js"
import type { Provider } from "../domain/models.js"
import { httpLockFile } from "../mcp/http/state.js"
import type { AppIdentity } from "../ports/app.js"
import { sendsPathFor } from "../sends/journal.js"
import { accountHome, inOwnerFolder, settled, storePath } from "../store/path.js"
import { openStore } from "../store/store.js"
import type { AccountKey } from "../store/types.js"
import { readConfigFile, withoutPath } from "./config-issues.js"
import { type BaseEnvironment, baseContext, environmentOf } from "./context.js"
import { logsInOrOut, REMOTE_WRITE } from "./effects.js"
import { itemOf, renderAnswer } from "./envelope.js"
import { accountFileFor, recalledAccount } from "./messenger/accounts.js"
import { answerOf } from "./messenger/ask.js"
import { profileFiles } from "./profile-files.js"
import type { GlobalFlags, ResolveOptions, Settings } from "./settings.js"

export interface AccountRemovalContext {
  env: NodeJS.ProcessEnv
  /** The run's keyring; `undefined` is the system one. A test hands in `memoryKeyring()`. */
  keyring?: KeyringStore
  /**
   * False in a run with moved folders (WC-SECR-24): it shares the owner's keyring entry and must not revoke the
   * owner's sign-in at the provider, only forget its own copy.
   */
  mayRevoke: boolean
}

/**
 * Whether a sign-out may revoke the sign-in at the provider. A run with moved folders shares the owner's keyring
 * entry and session (WC-SECR-24), so it only forgets its own copy. An injected keyring is a test's own.
 */
export const mayRevoke = (app: AppIdentity, env: NodeJS.ProcessEnv, keyring?: KeyringStore): boolean =>
  keyring !== undefined || !isMovedRun({ appName: app.appName, prefix: app.envPrefix, env })

export interface SignedOut {
  /** Whether the provider confirmed it took the sign-in back; `null` when the tool does not revoke. */
  revoked: boolean | null
  /** What the sign-out deleted, in words or paths the owner recognises: "the Telegram session", a session file. */
  removed: string[]
}

/** One set of keyring entries of the profile, at the options the tool reads them with. */
export interface AccountSecrets {
  credentials: CredentialsOptions
  accounts: readonly string[]
}

/**
 * What a tool hands `account remove`. Only `signOut` is required: the tool alone knows what its sign-in is. Every
 * path a hook names must lie inside the tool's own config, state or cache folder; the command refuses one outside.
 */
export interface AccountRemoval {
  /**
   * Signs the profile out the tool's own way: ends the session at the provider, deletes the token or the device keys,
   * revokes when `mayRevoke`. It runs before anything is forgotten, so a throw stops the removal with everything kept.
   */
  signOut(profile: string, context: AccountRemovalContext): Promise<SignedOut>
  /** The profile's account in the shared store. Unset: the account `rememberAccount` recorded for it. */
  account?(profile: string, context: AccountRemovalContext): AccountKey | undefined
  /** Keyring entries of this profile the sign-out leaves: app keys, a bot token. Removing a missing one is fine. */
  secrets?(profile: string, context: AccountRemovalContext): AccountSecrets[]
  /** The tool's own files and folders for this profile that hold no messages: cursors, a device id. Always removed. */
  stateFiles?(profile: string, context: AccountRemovalContext): string[]
  /** Files and folders holding this account's data outside the store: removed only with `--delete-data`. */
  dataFiles?(profile: string, context: AccountRemovalContext): string[]
  /** Removes the profile from a config file the tool keeps itself. Unset: cli-core's config file, as `settingsFor` reads it. */
  forgetConfig?(profile: string, context: AccountRemovalContext): string[]
  /** What holds this profile now, beyond a serve cli-core sees itself: "a sync", or `undefined`. */
  busy?(profile: string, context: AccountRemovalContext): string | undefined
  /**
   * Folders the tool keeps outside the ones its cli-core identity names, where its hooks' paths may also lie: zoom's
   * `~/.config/zm` and `~/.local/share/zm`. Each must be absolute and inside the home folder.
   */
  ownFolders?(context: AccountRemovalContext): string[]
}

export interface AccountRemoveOptions {
  /** The provider of the remembered account. Needed only when `account` is unset. */
  provider?: Provider
  /** Unset: the one `run()` set. */
  resolveSettings?: (flags: GlobalFlags, options?: ResolveOptions) => Settings
  /** The owner's own home; unset, the account's from the user database. A test names its sandbox. */
  ownerHome?: string
}

type Kind = "sign_in" | "keyring" | "config" | "file" | "store" | "unit" | "schedule"
interface Entry {
  kind: Kind
  target: string
}
interface Kept extends Entry {
  reason: string
}

const choiceOf = ({ keepData, deleteData }: { keepData?: boolean; deleteData?: boolean }): "kept" | "deleted" => {
  if (keepData === deleteData)
    throw new CliError(
      "validation_error",
      keepData
        ? "--keep-data and --delete-data ask for opposite things — pick one"
        : "say what happens to this account's data: --keep-data leaves it searchable, --delete-data deletes it",
      { reason: "account-remove.no-choice" },
    )
  return keepData ? "kept" : "deleted"
}

/** Inside the tool's own folders and not one of them: a hook's mistake must not reach the home folder. */
const insideOwnFolders = (app: AppIdentity, env: NodeJS.ProcessEnv, extra: readonly string[]) => {
  const home = absolute(env.HOME ?? env.USERPROFILE ?? homedir())
  for (const root of extra)
    if (!isAbsolute(root) || !absolute(root).startsWith(`${home}${sep}`))
      throw new CliError(
        "configuration_error",
        `${app.command} named ${root} as one of its folders, but it is not an absolute path inside ${home} — nothing was removed; report this as a bug`,
        { reason: "account-remove.folder-outside" },
      )
  const roots = [...Object.values(resolvePaths({ appName: app.appName, prefix: app.envPrefix, env })), ...extra].map(
    (root) => absolute(root),
  )
  return (path: string): string => {
    const full = absolute(path)
    if (!roots.some((root) => full.startsWith(`${root}${sep}`)))
      throw new CliError(
        "configuration_error",
        `${app.command} named ${full} for removal, outside its own folders — nothing was removed; report this as a bug`,
        { reason: "account-remove.path-outside" },
      )
    return full
  }
}

const under = (path: string, root: string) => path === root || path.startsWith(`${root}${sep}`)
const within = (path: string, root: string) => under(path, root) || under(settled(path), settled(root))

/**
 * WC-SECR-24: the tool's folders as the owner's own run has them. A run with moved folders shares the rest with the
 * owner (only the config folder moved leaves the state folder the owner's), so it removes nothing inside these.
 */
const ownerFolders = (
  app: AppIdentity,
  removal: AccountRemoval,
  hooks: AccountRemovalContext,
  home: string | undefined,
): string[] => {
  if (home === undefined) return []
  const env = { HOME: home, USERPROFILE: home }
  return [
    ...Object.values(resolvePaths({ appName: app.appName, prefix: app.envPrefix, env })),
    ...(removal.ownFolders?.({ ...hooks, env }) ?? []),
  ].map((root) => absolute(root))
}

/** The profile's own serve unit, by its exact name, when one is installed; never a pattern over the unit folder. */
const serveUnit = (app: AppIdentity, system: ServerSystem, profile: string, env: NodeJS.ProcessEnv) => {
  if (!env.HOME) return undefined
  const unit = platformFor(app, system, env).unit({
    profile,
    command: [],
    environment: { [`${app.envPrefix}_PROFILE`]: profile, ...locationVariables(app, env) },
  })
  return unit.path && existsSync(unit.path) ? unit : undefined
}

const removeUnit = async (app: AppIdentity, system: ServerSystem, unit: Unit, env: NodeJS.ProcessEnv) => {
  const platform = platformFor(app, system, env)
  for (const argv of platform.uninstall(unit)) {
    const ran = await system.run(argv, env)
    if (ran.code !== 0) throw new CliError("configuration_error", `${argv.join(" ")} failed: ${ran.stderr.trim()}`)
  }
  rmSync(unit.path, { force: true })
}

/** As `schedule remove` does: the timer and the schedule's file go, its past output stays. */
const removeSchedules = async (
  app: AppIdentity,
  system: ServerSystem,
  state: string,
  schedules: readonly Schedule[],
  env: NodeJS.ProcessEnv,
) => {
  const timer = timerFor(app, system, env)
  for (const { name } of schedules) {
    await timer.remove(name)
    rmSync(scheduleFile(state, name), { force: true })
  }
}

/** The profile's sections in cli-core's config file; a profile's shared section stays while its bot side uses it. */
const configSections = (path: string, profile: string): string[][] => {
  const read = readConfigFile(path)
  if ("issue" in read || typeof read.raw !== "object" || read.raw === null) return []
  const raw = read.raw as Record<string, Record<string, Record<string, unknown>> | undefined>
  const has = (...at: string[]) => at.reduce<unknown>((node, key) => (node as Record<string, unknown>)?.[key], raw)
  const bot = has("bot", "profiles", profile) !== undefined
  return [
    ...(has("personal", "profiles", profile) === undefined ? [] : [["personal", "profiles", profile]]),
    ...(has("profiles", profile) === undefined || bot ? [] : [["profiles", profile]]),
  ]
}

const removeSections = (path: string, sections: string[][]): void => {
  const read = readConfigFile(path)
  if ("issue" in read) return
  saveConfigFile(
    path,
    sections.reduce<unknown>((config, at) => withoutPath(config, at).config, read.raw),
  )
}

/**
 * `<tool> <profile> account remove --keep-data|--delete-data`: signs the profile out the tool's way, forgets it on
 * this computer, and keeps or deletes what the store holds of its account. Asks first, or `--yes`; `--dry-run` lists
 * every entry, file and section it would remove.
 */
export const accountRemoveCommand = (
  app: AppIdentity,
  removal: AccountRemoval,
  options: AccountRemoveOptions = {},
): Command =>
  logsInOrOut(
    annotate(new Command("remove"), {
      effects: REMOTE_WRITE,
      mcp: false,
      output: { entity: "account_removal" },
      examples: [
        `${app.command} personal account remove --keep-data --dry-run`,
        `${app.command} personal account remove --delete-data --yes`,
      ],
    }),
  )
    .summary("sign this profile out and forget it, keeping or deleting its data")
    .description(
      "sign the profile out, then forget it on this computer: its settings, its saved sign-in and its files; " +
        "--keep-data leaves its messages in the store, where search still finds them, --delete-data deletes them; " +
        "asks first, or --yes",
    )
    .option("--keep-data", "leave what the store holds of this account, still searchable")
    .option("--delete-data", "delete what the store and the tool's own files hold of this account")
    .option("--dry-run", "list what it would remove and keep, and change nothing")
    .action(async function (this: Command) {
      const given = this.opts<{ keepData?: boolean; deleteData?: boolean; dryRun?: boolean }>()
      const data = choiceOf(given)
      const resolveSettings = options.resolveSettings ?? environmentOf(this).resolveSettings
      if (!resolveSettings) throw new Error("account remove runs inside run(), or is given resolveSettings")
      const context = baseContext(this, resolveSettings)
      const { env, settings } = context
      const profile = settings.profile
      const accountFile = accountFileFor(app, profile, env)
      if (!settings.profilesHere.includes(profile) && !existsSync(accountFile))
        throw new CliError(
          "not_found",
          `no profile ${profile} on this computer — ${settings.profilesHere.join(", ") || "there is none"}`,
          { reason: "account-remove.unknown-profile", profiles: settings.profilesHere },
        )

      const moved = !mayRevoke(app, env, context.keyring)
      const hooks: AccountRemovalContext = {
        env,
        ...(context.keyring ? { keyring: context.keyring } : {}),
        mayRevoke: !moved,
      }
      const state = resolvePaths({ appName: app.appName, prefix: app.envPrefix, env }).state
      const httpLock = readLock(httpLockFile(join(state, "mcp-http", `${profile}.json`)))
      const holder = servingProfiles(app, env).includes(profile)
        ? `\`${app.command} serve\``
        : httpLock && alive(httpLock.pid)
          ? `\`${app.command} mcp serve --http\``
          : removal.busy?.(profile, hooks)
      if (holder)
        throw new CliError(
          "conflict",
          `${holder} is running for ${profile} — stop it first (\`${app.command} ${profile} server stop\`), then remove the account`,
          { reason: "account-remove.busy" },
        )

      const own = insideOwnFolders(app, env, removal.ownFolders?.(hooks) ?? [])
      const ownerHome = options.ownerHome ?? accountHome()
      const movedFolders = isMovedRun({ appName: app.appName, prefix: app.envPrefix, env })
      const owners = movedFolders ? ownerFolders(app, removal, hooks, ownerHome) : []
      const inOwners = (path: string) => owners.some((root) => within(absolute(path), root))
      const ownerHomeHere = movedFolders && ownerHome !== undefined && absolute(env.HOME ?? "") === absolute(ownerHome)
      const ownersReason = "a run with moved folders never removes what lies in the owner's own folders"
      const ownersKept: Kept[] = []
      const theRun = (paths: string[]) =>
        paths.flatMap((path) => {
          if (!inOwners(path)) return [own(path)]
          if (existsSync(path)) ownersKept.push({ kind: "file", target: absolute(path), reason: ownersReason })
          return []
        })
      const schedules =
        movedFolders && (inOwners(state) || ownerHomeHere)
          ? []
          : listSchedules(state).filter((schedule) => schedule.environment[`${app.envPrefix}_PROFILE`] === profile)
      const serveLock = lockPath(app, profile, env)
      const staleLock = readLock(serveLock)
      const stateFiles = theRun([
        accountFile,
        ...profileFiles(app, profile, env, listSchedules(state)),
        ...(staleLock && !alive(staleLock.pid) ? [serveLock] : []),
        ...(removal.stateFiles?.(profile, hooks) ?? []),
      ])
      const dataFiles = theRun(removal.dataFiles?.(profile, hooks) ?? [])
      const account =
        removal.account?.(profile, hooks) ??
        (options.provider === undefined ? undefined : recalledAccount(app, options.provider, profile, env))
      const secrets = (removal.secrets?.(profile, hooks) ?? []).map(({ credentials, accounts }) => ({
        store: new Credentials({
          ...credentials,
          ...(context.keyring && !credentials.keyring ? { keyring: context.keyring } : {}),
          ...(credentials.isolated === undefined ? { isolated: moved } : {}),
          warn: (line) => context.renderer.warn(line),
        }),
        accounts,
      }))
      const ownersConfig = inOwners(settings.configPath)
      const sections = removal.forgetConfig || ownersConfig ? [] : configSections(settings.configPath, profile)
      if (ownersConfig) ownersKept.push({ kind: "config", target: settings.configPath, reason: ownersReason })
      const ownersStore = movedFolders && inOwnerFolder(storePath(env), ownerHome)
      const storeHere = existsSync(storePath(env))
      const system = environmentOf<BaseEnvironment & { system?: ServerSystem }>(this).system ?? thisMachine()
      const unit = ownerHomeHere ? undefined : serveUnit(app, system, profile, env)
      if (unit && (await platformFor(app, system, env).state(unit)).active)
        throw new CliError(
          "conflict",
          `${unit.name} is running for ${profile} — stop it first (\`${app.command} ${profile} server stop\`), then remove the account`,
          { reason: "account-remove.busy" },
        )

      const signIn: Entry = { kind: "sign_in", target: `${app.command} sign-in of ${profile}` }
      // The tool's own sign-out deletes its session where the run's state folder says; here that folder is the owner's.
      const signsOut = !(movedFolders && inOwners(state))
      const removed: Entry[] = signsOut ? [signIn] : []
      const kept: Kept[] = [...ownersKept, ...(signsOut ? [] : [{ ...signIn, reason: ownersReason }])]
      // An entry the environment supplies is not this tool's to remove.
      const saved = (store: Credentials, name: string) => (store.read(name)?.source ?? "environment") !== "environment"
      for (const { store, accounts } of secrets)
        for (const name of accounts) if (saved(store, name)) removed.push({ kind: "keyring", target: name })
      for (const at of sections) removed.push({ kind: "config", target: at.join(".") })
      const present = (path: string) => existsSync(path)
      for (const file of stateFiles.filter(present)) removed.push({ kind: "file", target: file })
      if (unit) removed.push({ kind: "unit", target: unit.path })
      for (const { name } of schedules) removed.push({ kind: "schedule", target: name })
      const journal = sendsPathFor(app, profile, env)
      if (existsSync(journal))
        kept.push({ kind: "file", target: journal, reason: "the record of what was sent for this account" })
      const accountName = account ? `${account.provider}:${account.account}` : undefined
      if (data === "deleted") {
        for (const file of dataFiles.filter(present)) removed.push({ kind: "file", target: file })
        if (accountName && storeHere && ownersStore)
          kept.push({ kind: "store", target: accountName, reason: ownersReason })
        else if (accountName && storeHere) removed.push({ kind: "store", target: accountName })
        else
          kept.push({
            kind: "store",
            target: accountName ?? profile,
            reason: accountName
              ? "the store does not exist yet, so it holds nothing of this account"
              : "this profile never recorded which account it is, so nothing in the store can be told apart as its",
          })
      } else {
        for (const file of dataFiles.filter(present))
          kept.push({ kind: "file", target: file, reason: "--keep-data keeps the account's files" })
        if (accountName)
          kept.push({
            kind: "store",
            target: accountName,
            reason: "--keep-data: its messages stay in the store, and search still finds them",
          })
      }

      const answer = (dryRun: boolean, signedOut?: SignedOut) =>
        renderAnswer(
          this,
          context,
          itemOf({
            profile,
            data,
            dry_run: dryRun,
            account: account ? { provider: account.provider, account: account.account } : null,
            revoked: signedOut?.revoked ?? null,
            config_file: settings.configPath,
            removed,
            kept,
          }),
        )

      if (given.dryRun) {
        answer(true)
        return
      }
      if (this.optsWithGlobals<{ yes?: boolean }>().yes !== true) {
        const what = `this signs ${profile} out and forgets it, and ${data === "deleted" ? "deletes" : "keeps"} its data`
        const lines = removed.map((one) => `  ${one.kind}: ${one.target}`).join("\n")
        const reply = await answerOf(this, `${what}:\n${lines}\nGo ahead? [y/N] `)
        if (reply === null)
          throw new CliError("confirmation_required", `${what} — add --yes to go ahead, or --dry-run to see the list`, {
            reason: "account-remove.unconfirmed",
          })
        if (!/^\s*y(es)?\s*$/i.test(reply)) throw new CliError("cancelled", `cancelled — ${profile} is unchanged`)
      }

      await context.run(async () => {
        const signedOut = signsOut ? await removal.signOut(profile, hooks) : undefined
        if (signedOut)
          removed.splice(0, 1, ...signedOut.removed.map((target) => ({ kind: "sign_in" as const, target })))

        const keyringEntries = removed.filter((one) => one.kind === "keyring")
        const gone = new Set<string>()
        for (const { store, accounts } of secrets)
          for (const name of accounts) if (store.remove(name).length > 0) gone.add(name)
        for (const entry of keyringEntries) {
          if (gone.has(entry.target)) continue
          removed.splice(removed.indexOf(entry), 1)
          if (moved)
            kept.push({
              kind: "keyring",
              target: entry.target,
              reason: "a run with moved folders never removes the owner's sign-in",
            })
        }

        if (removed.some((one) => one.kind === "store") && account) {
          const store = await openStore({ env, command: app.command })
          try {
            await store.accounts.purge(account)
            await store.accounts.forgetProfile(app.command, profile)
          } finally {
            await store.close()
          }
        }
        if (unit) await removeUnit(app, system, unit, env)
        if (schedules.length > 0) await removeSchedules(app, system, state, schedules, env)
        for (const entry of removed) if (entry.kind === "file") rmSync(entry.target, { recursive: true, force: true })
        if (removal.forgetConfig && !ownersConfig)
          for (const target of removal.forgetConfig(profile, hooks)) removed.push({ kind: "config", target })
        else if (sections.length > 0) removeSections(settings.configPath, sections)

        answer(false, signedOut)
        if (context.format === "pretty")
          context.renderer.success(
            data === "deleted"
              ? `removed ${profile} and deleted its data`
              : `removed ${profile}; its messages stay in the store, and search still finds them`,
          )
      })
    })
