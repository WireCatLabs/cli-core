import { existsSync, mkdirSync, renameSync } from "node:fs"
import { dirname, join, sep } from "node:path"
import { CliError, Credentials, resolvePaths, saveConfigFile } from "@wirecat/cli-base"
import { annotate } from "@wirecat/cli-base/commands"
import { Command } from "commander"
import { lockPath, readLock, servingProfiles } from "../background/lock.js"
import { alive } from "../background/processes.js"
import { listSchedules } from "../background/schedules.js"
import { type ServerSystem, thisMachine } from "../background/system.js"
import { httpLockFile } from "../mcp/http/state.js"
import type { AppIdentity } from "../ports/app.js"
import { sendsPathFor } from "../sends/journal.js"
import { storePath } from "../store/path.js"
import { openStore } from "../store/store.js"
import {
  type AccountRemoval,
  type AccountRemovalContext,
  type AccountSecrets,
  insideOwnFolders,
  mayRevoke,
  serveUnit,
} from "./account-remove.js"
import { readConfigFile, withoutPath } from "./config-issues.js"
import { type BaseEnvironment, baseContext, environmentOf } from "./context.js"
import { LOCAL_WRITE } from "./effects.js"
import { itemOf, renderAnswer } from "./envelope.js"
import { accountFileFor } from "./messenger/accounts.js"
import { answerOf } from "./messenger/ask.js"
import { usableProfileName } from "./profile.js"
import { profileFiles } from "./profile-files.js"
import type { GlobalFlags, ResolveOptions, Settings } from "./settings.js"

export type AccountRenaming = AccountRemoval & Required<Pick<AccountRemoval, "signIn">>

export interface AccountRenameOptions {
  /** Unset: the one `run()` set. */
  resolveSettings?: (flags: GlobalFlags, options?: ResolveOptions) => Settings
}

interface Move {
  kind: "keyring" | "config" | "file" | "store"
  from: string
  to: string
}

const refuse = (reason: string, message: string, details: Record<string, unknown> = {}) =>
  new CliError("conflict", message, { reason: `account-rename.${reason}`, ...details })

/** Every hook is a function of the profile name, so the same hook asked for both names pairs old with new. */
const paired = <T>(app: AppIdentity, from: readonly T[], to: readonly T[]): [T, T][] => {
  if (from.length !== to.length)
    throw new CliError(
      "configuration_error",
      `${app.command} names a different number of paths or entries for the new name — nothing was renamed; report this as a bug`,
      { reason: "account-rename.unpaired" },
    )
  return from.map((one, at) => [one, to[at] as T])
}

const at = (raw: unknown, path: readonly string[]) =>
  path.reduce<unknown>((node, key) => (node as Record<string, unknown> | undefined)?.[key], raw)

const withValue = (raw: unknown, path: readonly string[], value: unknown): unknown => {
  const [key, ...rest] = path
  if (key === undefined) return value
  const node = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {}
  return { ...node, [key]: withValue(node[key], rest, value) }
}

/**
 * `<tool> <profile> account rename <new>`: gives the profile another name and moves everything it owns on this
 * computer — the sign-in, its other keyring entries, its settings, its files and what the store records of it. The
 * account's data in the store is keyed by the account, not the name, and stays where it is. Asks first, or `--yes`.
 */
export const accountRenameCommand = (
  app: AppIdentity,
  renaming: AccountRenaming,
  options: AccountRenameOptions = {},
): Command =>
  annotate(new Command("rename"), {
    effects: LOCAL_WRITE,
    mcp: false,
    output: { entity: "account_rename" },
    examples: [
      `${app.command} personal account rename home --dry-run`,
      `${app.command} personal account rename home --yes`,
    ],
  })
    .summary("give this profile another name, keeping its sign-in, settings and data")
    .description(
      "give the profile another name: its sign-in, settings, files and what the store records of it move to the new " +
        "name, and nothing is signed out; asks first, or --yes",
    )
    .argument("<new>", "the profile's new name")
    .option("--dry-run", "list what it would move, and change nothing")
    .action(async function (this: Command, wanted: string) {
      const given = this.opts<{ dryRun?: boolean }>()
      const resolveSettings = options.resolveSettings ?? environmentOf(this).resolveSettings
      if (!resolveSettings) throw new Error("account rename runs inside run(), or is given resolveSettings")
      const context = baseContext(this, resolveSettings)
      const { env, settings } = context
      const profile = settings.profile
      const next = usableProfileName(wanted)
      const known = (name: string) => settings.profilesHere.includes(name) || existsSync(accountFileFor(app, name, env))
      if (!known(profile))
        throw new CliError(
          "not_found",
          `no profile ${profile} on this computer — ${settings.profilesHere.join(", ") || "there is none"}`,
          { reason: "account-rename.unknown-profile", profiles: settings.profilesHere },
        )
      if (next === profile) throw new CliError("validation_error", `${profile} already has that name`)
      if (known(next) || (settings.botProfiles ?? []).includes(next))
        throw refuse("taken", `a profile called ${next} already exists — pick another name`)
      if (!mayRevoke(app, env, context.keyring))
        throw new CliError(
          "permission_error",
          "this run's folders are moved, and a profile is renamed only from a run with the owner's own folders",
          { reason: "account-rename.moved-run" },
        )
      if ((settings.botProfiles ?? []).includes(profile))
        throw refuse("bot", `${profile} is also a bot profile, and a bot keeps its name — nothing was renamed`)

      const hooks: AccountRemovalContext = {
        env,
        ...(context.keyring ? { keyring: context.keyring } : {}),
        mayRevoke: true,
      }
      const state = resolvePaths({ appName: app.appName, prefix: app.envPrefix, env }).state
      const httpLock = readLock(httpLockFile(join(state, "mcp-http", `${profile}.json`)))
      const system = environmentOf<BaseEnvironment & { system?: ServerSystem }>(this).system ?? thisMachine()
      const unit = serveUnit(app, system, profile, env)
      const schedules = listSchedules(state).filter(
        (schedule) => schedule.environment[`${app.envPrefix}_PROFILE`] === profile,
      )
      const holder = servingProfiles(app, env).includes(profile)
        ? `\`${app.command} serve\` is running for ${profile} — stop it first (\`${app.command} ${profile} server stop\`)`
        : httpLock && alive(httpLock.pid)
          ? `\`${app.command} mcp serve --http\` is running for ${profile} — stop it first`
          : unit
            ? `${profile} has a background service — remove it first (\`${app.command} ${profile} server uninstall\`)`
            : schedules.length > 0
              ? `schedules run as ${profile}: ${schedules.map(({ name }) => name).join(", ")} — remove them first ` +
                `(\`${app.command} schedule remove <name>\`)`
              : renaming.busy?.(profile, hooks)
      if (holder) throw refuse("busy", `${holder}, then rename the profile`)

      const own = insideOwnFolders(app, env, renaming.ownFolders?.(hooks) ?? [])
      const filesOf = (name: string) => {
        const serve = lockPath(app, name, env)
        return [
          accountFileFor(app, name, env),
          sendsPathFor(app, name, env),
          serve,
          ...profileFiles(app, name, env, []),
          ...(renaming.signIn(name, hooks).files ?? []),
          ...(renaming.stateFiles?.(name, hooks) ?? []),
          ...(renaming.dataFiles?.(name, hooks) ?? []),
        ].map(own)
      }
      // A hook may repeat a path cli-core keeps, or name a folder holding another entry: that one moves with it.
      const files = [
        ...new Map(
          paired(app, filesOf(profile), filesOf(next))
            .filter(([from]) => existsSync(from))
            .map(([from, to]) => [from, to] as const),
        ),
      ].filter(([from], _, all) => !all.some(([outer]) => outer !== from && from.startsWith(`${outer}${sep}`)))
      const clash = files.find(([, to]) => existsSync(to))
      if (clash) throw refuse("taken", `${clash[1]} already exists — nothing was renamed`)

      const config = resolvePaths({ appName: app.appName, prefix: app.envPrefix, env }).config
      const secretsOf = (name: string): AccountSecrets[] => [
        { credentials: { configDir: config, service: app.appName, env }, accounts: [`token:${name}`] },
        ...(renaming.signIn(name, hooks).secrets ?? []),
        ...(renaming.secrets?.(name, hooks) ?? []),
      ]
      const seen = new Set<string>()
      const entries = paired(app, secretsOf(profile), secretsOf(next)).flatMap(([from, to]) => {
        const store = new Credentials({
          ...from.credentials,
          ...(context.keyring && !from.credentials.keyring ? { keyring: context.keyring } : {}),
          warn: (line) => context.renderer.warn(line),
        })
        return paired(app, from.accounts, to.accounts).flatMap(([old, now]) => {
          const id = `${from.credentials.service}\0${from.credentials.configDir}\0${old}`
          if (seen.has(id)) return []
          seen.add(id)
          const found = store.read(old)
          return found && found.source !== "environment" ? [{ store, from: old, to: now }] : []
        })
      })
      const taken = entries.find(({ store, to }) => (store.read(to)?.source ?? "environment") !== "environment")
      if (taken) throw refuse("taken", `the keyring already holds ${taken.to} — nothing was renamed`)

      const read = readConfigFile(settings.configPath)
      if ("issue" in read)
        throw new CliError("configuration_error", `${settings.configPath} cannot be read — fix it first`, {
          reason: "account-rename.config",
        })
      const sections = [["profiles"], ["personal", "profiles"]].filter(
        (path) => at(read.raw, [...path, profile]) !== undefined,
      )

      const storeHere = existsSync(storePath(env))
      const recorded = storeHere ? await recordedOf(app, env, profile) : { key: undefined, groups: [] }

      const moved: Move[] = [
        ...entries.map(({ from, to }) => ({ kind: "keyring" as const, from, to })),
        ...sections.map((path) => ({
          kind: "config" as const,
          from: [...path, profile].join("."),
          to: [...path, next].join("."),
        })),
        ...files.map(([from, to]) => ({ kind: "file" as const, from, to })),
        ...(recorded.key
          ? [{ kind: "store" as const, from: `${app.command}:${profile}`, to: `${app.command}:${next}` }]
          : []),
        ...recorded.groups.map((group) => ({
          kind: "store" as const,
          from: `group ${group}: ${app.command}:${profile}`,
          to: `group ${group}: ${app.command}:${next}`,
        })),
      ]
      const answer = (dryRun: boolean) =>
        renderAnswer(
          this,
          context,
          itemOf({ profile, renamed_to: next, dry_run: dryRun, config_file: settings.configPath, moved }),
        )

      if (given.dryRun) {
        answer(true)
        return
      }
      if (this.optsWithGlobals<{ yes?: boolean }>().yes !== true) {
        const what = `this renames ${profile} to ${next}`
        const lines = moved.map((one) => `  ${one.kind}: ${one.from} → ${one.to}`).join("\n")
        const reply = await answerOf(this, `${what}:\n${lines}\nGo ahead? [y/N] `)
        if (reply === null)
          throw new CliError("confirmation_required", `${what} — add --yes to go ahead, or --dry-run to see the list`, {
            reason: "account-rename.unconfirmed",
          })
        if (!/^\s*y(es)?\s*$/i.test(reply)) throw new CliError("cancelled", `cancelled — ${profile} is unchanged`)
      }

      await context.run(async () => {
        // Every new entry is written before an old one goes, so a failure leaves the old name signed in.
        for (const { store, from, to } of entries) {
          const found = store.read(from)
          if (found) store.write(to, found.secret)
        }
        if (sections.length > 0)
          saveConfigFile(
            settings.configPath,
            sections.reduce<unknown>(
              (raw, path) =>
                withoutPath(withValue(raw, [...path, next], at(raw, [...path, profile])), [...path, profile]).config,
              read.raw,
            ),
          )
        for (const [from, to] of files) {
          mkdirSync(dirname(to), { recursive: true })
          renameSync(from, to)
        }
        if (recorded.key || recorded.groups.length > 0) await moveRecords(app, env, profile, next)
        for (const { store, from } of entries) store.remove(from)

        answer(false)
        if (context.format === "pretty") context.renderer.success(`renamed ${profile} to ${next}`)
      })
    })

const recordedOf = async (app: AppIdentity, env: NodeJS.ProcessEnv, profile: string) => {
  const store = await openStore({ env, command: app.command })
  try {
    const member = `${app.command}:${profile}`
    return {
      key: (await store.accounts.profiles())[app.command]?.[profile],
      groups: Object.entries(await store.accounts.accountGroups())
        .filter(([, members]) => members.includes(member))
        .map(([group]) => group),
    }
  } finally {
    await store.close()
  }
}

const moveRecords = async (app: AppIdentity, env: NodeJS.ProcessEnv, profile: string, next: string) => {
  const store = await openStore({ env, command: app.command })
  try {
    const key = (await store.accounts.profiles())[app.command]?.[profile]
    if (key) {
      await store.accounts.saveProfile(app.command, next, key)
      await store.accounts.forgetProfile(app.command, profile)
    }
    const member = `${app.command}:${profile}`
    for (const [group, members] of Object.entries(await store.accounts.accountGroups()))
      if (members.includes(member))
        await store.accounts.saveAccountGroup(
          group,
          members.map((one) => (one === member ? `${app.command}:${next}` : one)),
        )
  } finally {
    await store.close()
  }
}
