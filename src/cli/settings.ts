import { existsSync } from "node:fs"
import { CliError, configFilePath, resolvePaths, saveConfigFile } from "@wirecat/cli-base"
import * as v from "valibot"
import { AI_ENTRIES, type AISettings, resolveAISettings } from "../analysis/settings.js"
import {
  fromOldSettings,
  LEVELS,
  type Level,
  layerPermissions,
  PERMISSIONS,
  type Permission,
  type PermissionKey,
  permissionOverrides,
  RESOURCES,
} from "../sends/permissions.js"
import { type AppIdentity, envName } from "./app.js"
import { loadSnakeCaseConfig, settingAt } from "./config-keys.js"
import { DEFAULT_CONFIG, ensureDefaultConfig } from "./default-config.js"
import { profilesHere } from "./messenger/accounts.js"
import { DEFAULT_PROFILE, usableProfileName } from "./profile.js"

const DEFAULT_LIMIT = DEFAULT_CONFIG.defaults.limit
const DEFAULT_KEEP_RUNS_FOR_DAYS = DEFAULT_CONFIG.defaults.keep_runs_for_days
/** On by default: a limit that is off protects nobody from a loop. */
const DEFAULT_SENDS_PER_HOUR = DEFAULT_CONFIG.defaults.sends_per_hour

export const plain =
  (rule: string) =>
  (issue: v.BaseIssue<unknown>): string =>
    `${rule}, not ${issue.received}`
const wholeNumber = plain("has to be a whole number, 1 or more")
export const count = v.pipe(v.number(wholeNumber), v.integer(wholeNumber), v.minValue(1, wholeNumber))
const zeroOrMore = plain("has to be a whole number, 0 or more")
const countOrZero = v.pipe(v.number(zeroOrMore), v.integer(zeroOrMore), v.minValue(0, zeroOrMore))
export const flag = v.boolean(plain("has to be true or false"))

const wholeOrZero = (text: string, name: string): number => {
  const value = Number(text)
  if (!Number.isInteger(value) || value < 0)
    throw new CliError("validation_error", `${name} has to be a whole number, 0 or more`)
  return value
}
const permissionList = v.array(
  v.picklist(PERMISSIONS, (issue) => `has to be one of ${PERMISSIONS.join(", ")}, not ${issue.received}`),
  plain("has to be a list of actions, like send,reaction"),
)

const permissionLevels = v.record(
  v.pipe(
    v.string(),
    v.regex(
      new RegExp(`^(${RESOURCES.join("|")})(\\.[a-z][a-z-]*)*$`),
      (issue) => `${issue.input} is not a command path — it starts with one of ${RESOURCES.join(", ")}`,
    ),
  ),
  v.picklist(LEVELS, (issue) => `has to be one of ${LEVELS.join(", ")}, not ${issue.received}`),
  plain('has to be an object of command paths and levels, like {"messages.delete": "ask"}'),
)

/** valibot's own words ("Expected never but received …") mean nothing to someone editing a file. */
const objectMessage =
  (known: string[]): v.ErrorMessage<v.StrictObjectIssue> =>
  (issue) =>
    issue.expected === "never"
      ? `unknown setting — the known ones are ${known.join(", ")}`
      : "has to be an object, in braces"

/**
 * What every messenger CLI's profile can set. ⚠ Read through `strictObject`, so an unknown key is an
 * error: `object()` drops what it does not recognise, and a misspelled setting would run with the
 * default and never say why.
 *
 * **No field here can hold a secret.** No token, no phone number, no chat id: a schema with nowhere
 * to put one is stronger than a rule saying do not put one there.
 */
const SHARED_PROFILE_ENTRIES = {
  limit: v.optional(count),
  timeout_ms: v.optional(count),
  color: v.optional(flag),
  sender_colors: v.optional(flag),
  record: v.optional(flag),
  keep_runs_for_days: v.optional(count),
  read_only: v.optional(flag),
  allow: v.optional(permissionList),
  permissions: v.optional(permissionLevels),
  sends_per_hour: v.optional(count),
  requests_per_minute: v.optional(countOrZero),
  transcribe_with: v.optional(v.picklist(["auto", "messenger", "local"], plain("has to be auto, messenger or local"))),
  speech_model: v.optional(v.string(plain("has to be a model id from `models audio list`, in quotes"))),
  catch_up_marks_read: v.optional(flag),
  search_catch_up: v.optional(flag),
  picture_search: v.optional(flag),
  ...AI_ENTRIES,
}

/**
 * Only a bot reads these. `read_other_bots`: whether this bot may read the local copy of other bots on
 * this machine — every one, or those named — when a command asks for it.
 */
const BOT_ONLY_ENTRIES = {
  read_other_bots: v.optional(
    v.union(
      [flag, v.array(v.string(), plain("has to be a list of profile names"))],
      plain("has to be true, false or a list of profile names"),
    ),
  ),
}

/** One program, one version: whether to look for a newer one is not a per-profile matter. */
const SHARED_DEFAULTS_ONLY = {
  update_check: v.optional(flag),
  skill_hint: v.optional(flag),
}

/**
 * **What one messenger adds to the file**, merged into the one strict schema — a field an adapter
 * reads but the schema did not know would be refused as unknown. Each entry must be optional.
 */
export interface SettingsExtension<T extends object = Record<never, never>> {
  schema?: v.GenericSchema
  sourcePaths?: boolean
  parseDuration?: (value: string, source: string) => number
  resolve?: (context: SettingsExtensionContext) => { values: T; sources: Record<string, Source> }
  profile?: v.ObjectEntries
  /** For the whole program only, never per profile. */
  defaults?: v.ObjectEntries
  /** Profiles this messenger keeps in files of its own, beyond the config file and the remembered accounts. */
  profiles?: (env: NodeJS.ProcessEnv) => string[]
}

export interface SettingsExtensionContext {
  flags: GlobalFlags
  settings: Settings
  layers: [Source, Scope | undefined][]
  fromLayers: <T>(key: string, fallback: T) => { value: T; from: Source }
}

type Scope = Record<string, unknown>

/** Which side of a profile a command speaks for: `<tool> <profile> bot …` is the bot, every other command the account. */
export type ProfileKind = "personal" | "bot"

/** Every personal account, or every bot, and then one of them by name. */
interface KindSection {
  defaults?: Scope
  profiles?: Record<string, Scope>
}

export interface Config {
  default_profile?: string
  defaults?: Scope
  profiles: Record<string, Scope>
  personal?: KindSection
  bot?: KindSection
}

/** Whatever the command line carried. Everything is optional: absent means "not given here". */
export interface GlobalFlags {
  permission?: string[]
  profile?: string
  json?: boolean
  jsonl?: boolean
  quiet?: boolean
  verbose?: number
  trace?: boolean
  limit?: number
  page?: number
  all?: boolean
  record?: boolean
  offline?: boolean
  /** Raw text from `--timeout`, parsed here so the unit rule lives in one place. */
  timeout?: string
}

/** `first word`, `flag`, `TG_PROFILE`, `config file`, `config defaults`, `default`… */
export type Source = string

export interface Settings extends AISettings {
  profile: string
  json: boolean
  jsonl: boolean
  quiet: boolean
  /** How much of what the model knows a human view shows: `-v`, `-vv`. */
  detail: 0 | 1 | 2
  trace: boolean
  offline: boolean
  /** Unset means "decide from the terminal", which is `resolveOutput`'s job, not this one's. */
  color: boolean | undefined
  senderColors: boolean
  /** `inbox` and `review` mark each chat they show read, as `--mark-read` does; the other side sees it. Off unless set. */
  catchUpMarksRead: boolean
  searchCatchUp?: boolean
  /** Search and `images embed` read the pictures themselves, with a model on this machine. Off until set. */
  pictureSearch?: boolean
  limit: number
  /** Which page, 1-based. Per invocation only — a page number in a file is a setting nobody wants twice. */
  page: number
  all: boolean
  /** One request's wait. Unset means the transport's own default. */
  timeoutMs: number | undefined
  /**
   * How long the **whole command** may take, or `undefined` for no bound. ⚠ Not `timeoutMs`: one
   * read is a connect, a login, a name to resolve and the request itself. They are spelled
   * differently on purpose — milliseconds in the file, a duration with a unit on the command line.
   */
  commandTimeoutMs: number | undefined
  record: boolean
  /** A failed run is kept even unrecorded, unless recording was turned off by name. */
  keepFailedRuns: boolean
  keepRunsForDays: number
  readOnly: boolean
  /** The variable that made this process read-only, above every level and flag (`<PREFIX>_READ_ONLY`). */
  readOnlyLock?: string
  /** `undefined` is every action; a list is only those. */
  allow: readonly Permission[] | undefined
  /**
   * The levels the owner set — `readOnly` and `allow` folded in under what the file's `permissions`
   * says. The built-in defaults are not here: `levelFor` adds them, and they only ever tighten.
   */
  permissions: Readonly<Record<PermissionKey, Level>>
  /** Where each key of `permissions` came from. */
  permissionSources: Readonly<Record<PermissionKey, Source>>
  sendsPerHour: number
  /** Calls a minute this profile may make, across every process; 0 is no pace. Unset: the messenger's own default. */
  requestsPerMinute?: number
  /** The side these settings are for. */
  kind: ProfileKind
  /** A bot only: which other bots' local copy it may read when a command asks. Always `false` for the account. */
  readOtherBots: boolean | readonly string[]
  updateCheck: boolean
  /** Whether an agent is told, once a day, that `<cli> skill install` would give it this tool's guide. */
  skillHint: boolean
  configPath: string
  configFound: boolean
  /** Profiles the configuration file names, whether or not anyone has logged in to them. */
  configuredProfiles: string[]
  /** Every profile on this computer — what `account list` shows and a missing profile's error lists. */
  profilesHere: string[]
  /** Where each value came from — `config show` prints it. */
  sources: Record<string, Source>
  /** This profile's entries and the shared defaults, for an adapter resolving its own fields with `first`. */
  configured: Scope
  shared: Scope
}

export interface ResolveOptions {
  env?: NodeJS.ProcessEnv
  configDir?: string
  /** `personal` unless given. */
  kind?: ProfileKind
  /**
   * `false` for a command that touches no account — `account list`, `config show` — so it still runs
   * when no profile is named. Its `profile` is then `default`, from `none named`.
   */
  needsProfile?: boolean
}

/** Where `profile` came from when none was named and the command needs none. */
export const NONE_NAMED = "none named"

/** The first candidate that is set, and which layer it came from. */
export const first = <T>(candidates: [Source, T | undefined][], fallback: T): { value: T; from: Source } => {
  for (const [from, value] of candidates) if (value !== undefined) return { value, from }
  return { value: fallback, from: "default" }
}

/** A value of an adapter's own field, from the profile, then the shared defaults, then the built-in one. */
export const fromFile = <T>(settings: Pick<Settings, "configured" | "shared">, key: string, fallback: T) =>
  first<T>(
    [
      ["config file", settings.configured[key] as T | undefined],
      ["config defaults", settings.shared[key] as T | undefined],
    ],
    fallback,
  )

/**
 * Everything one CLI needs to read and change its configuration, built once for its identity and
 * its extension. **Flag → environment → config file → built-in default**, decided here and only
 * here; a command that re-derived the order would disagree with the others.
 */
export const settingsFor = <T extends object = Record<never, never>>(
  app: AppIdentity,
  extension: SettingsExtension<T> = {},
) => {
  const profileEntries = { ...SHARED_PROFILE_ENTRIES, ...extension.profile }
  const defaultsOnly = { ...SHARED_DEFAULTS_ONLY, ...extension.defaults }
  const defaultsEntries = { ...profileEntries, ...defaultsOnly }
  const strictOf = (entries: v.ObjectEntries) => v.strictObject(entries, objectMessage(Object.keys(entries)))
  const kindSection = (entries: v.ObjectEntries) =>
    v.strictObject(
      {
        defaults: v.optional(strictOf(entries)),
        profiles: v.optional(v.record(v.string(), strictOf(entries), "has to be an object of profiles, by name")),
      },
      objectMessage(["defaults", "profiles"]),
    )
  const configEntries = {
    default_profile: v.optional(v.string(plain("has to be a profile name, in quotes"))),
    defaults: v.optional(v.strictObject(defaultsEntries, objectMessage(Object.keys(defaultsEntries)))),
    profiles: v.optional(
      v.record(
        v.string(),
        v.strictObject(profileEntries, objectMessage(Object.keys(profileEntries))),
        "has to be an object of profiles, by name",
      ),
      {},
    ),
    personal: v.optional(kindSection(profileEntries)),
    bot: v.optional(kindSection({ ...profileEntries, ...BOT_ONLY_ENTRIES })),
  }
  const schema = v.strictObject(configEntries, objectMessage(Object.keys(configEntries)))
  const defaultsOnlyKeys = Object.keys(defaultsOnly)
  const botOnlyKeys = Object.keys(BOT_ONLY_ENTRIES)
  const allSettings = [...Object.keys(profileEntries), ...botOnlyKeys, ...defaultsOnlyKeys, "default_profile"]

  const PROFILE = envName(app, "PROFILE")
  const PROFILE_LOCK = envName(app, "PROFILE_LOCK")
  const READ_ONLY = envName(app, "READ_ONLY")
  const TIMEOUT = envName(app, "TIMEOUT")
  const REQUESTS_PER_MINUTE = envName(app, "REQUESTS_PER_MINUTE")

  const configPathFor = ({ env = process.env, configDir }: ResolveOptions) =>
    configFilePath(configDir ?? resolvePaths({ appName: app.appName, prefix: app.envPrefix, env }).config)

  const readConfig = (path: string): Config => {
    try {
      return loadSnakeCaseConfig(path, extension.schema ?? schema, () => ({ profiles: {} })) as Config
    } catch (error) {
      throw new CliError("configuration_error", error instanceof Error ? error.message : String(error))
    }
  }

  /**
   * A lock pins a process to one profile: the owner sets it where an agent runs, and a first word
   * or `<PREFIX>_PROFILE` naming any other profile is refused rather than obeyed. What the agent
   * could otherwise do is pick the profile with fewer guards.
   */
  const locked = (profile: { value: string; from: Source }, lock: string | undefined) => {
    if (lock === undefined) return profile
    usableProfileName(lock)
    if (profile.value === lock) return profile
    if (profile.from === "first word" || profile.from === PROFILE) {
      throw new CliError(
        "permission_error",
        `this process is locked to profile ${lock} (${PROFILE_LOCK}) — profile ${profile.value} is refused`,
      )
    }
    return { value: lock, from: PROFILE_LOCK }
  }

  /**
   * **Nothing named a profile, so none is picked** — not among several, not the only one, not
   * `default`: which account a command speaks for is the owner's choice, said every time.
   */
  const unnamed = (config: Config, env: NodeJS.ProcessEnv, needed: boolean): { value: string; from: Source } => {
    if (!needed) return { value: DEFAULT_PROFILE, from: NONE_NAMED }
    const here = profilesOf(config, env)
    throw new CliError(
      "validation_error",
      here.length === 0
        ? `name a profile: there is none on this computer yet — create one with \`${app.command} personal setup\` ` +
            "(any name in place of personal)"
        : `name a profile: \`${app.command} <profile> …\` — profiles here: ${here.join(", ")} (or set ${PROFILE})`,
      { profiles: here },
    )
  }

  const profilesOf = (config: Config, env: NodeJS.ProcessEnv): string[] =>
    profilesHere(app, [...namedProfiles(config), ...(extension.profiles?.(env) ?? [])], env)

  const resolveSettings = (flags: GlobalFlags = {}, options: ResolveOptions = {}): Settings & T => {
    const env = options.env ?? process.env
    const configPath = configPathFor(options)
    try {
      ensureDefaultConfig(configPath)
    } catch (error) {
      throw new CliError("configuration_error", error instanceof Error ? error.message : String(error))
    }
    const config = readConfig(configPath)

    const lock = given(env[PROFILE_LOCK])
    const named = first<string | undefined>(
      [
        ["first word", flags.profile],
        [PROFILE, given(env[PROFILE])],
        [
          extension.sourcePaths ? "config file: default_profile" : "config file",
          settingAt(config as unknown as Record<string, unknown>, "default_profile") as string | undefined,
        ],
        [PROFILE_LOCK, lock],
      ],
      undefined,
    )
    const profile = locked(
      named.value === undefined
        ? unnamed(config, env, options.needsProfile !== false)
        : { value: named.value, from: named.from },
      lock,
    )
    const kind = options.kind ?? "personal"
    const name = usableProfileName(profile.value)
    const configured = config.profiles[name] ?? {}
    const shared = config.defaults ?? {}
    const section = config[kind]
    // The most specific entry wins: this profile's personal or bot entry, the profile, every
    // personal account or every bot, everyone. Naming one account says more than naming them all.
    const layers: [Source, Scope | undefined][] = [
      [`config file: ${kind}.profiles.${name}`, section?.profiles?.[name]],
      [extension.sourcePaths ? `config file: profiles.${name}` : "config file", configured],
      [`config file: ${kind}.defaults`, section?.defaults],
      [extension.sourcePaths ? "config file: defaults" : "config defaults", shared],
    ]
    const fromLayers = <T>(key: string, fallback: T, only = layers) =>
      first<T>(
        only.map(([from, scope]): [Source, T | undefined] => [from, settingAt(scope, key) as T | undefined]),
        fallback,
      )
    const kindLayers = layers.filter(([from]) => from.startsWith(`config file: ${kind}.`))

    const limit = flags.limit === undefined ? fromLayers("limit", DEFAULT_LIMIT) : { value: flags.limit, from: "flag" }
    const record = flags.record === undefined ? fromLayers("record", false) : { value: flags.record, from: "flag" }
    const timeoutMs = fromLayers<number | undefined>("timeout_ms", undefined)
    const color = fromLayers<boolean | undefined>("color", undefined)
    const senderColors = fromLayers("sender_colors", false)
    const catchUpMarksRead = fromLayers("catch_up_marks_read", false)
    const searchCatchUp = fromLayers("search_catch_up", false)
    const pictureSearch = fromLayers("picture_search", false)
    const keepRunsForDays = fromLayers("keep_runs_for_days", DEFAULT_KEEP_RUNS_FOR_DAYS)
    // Set where an agent runs unattended; the config file and `--permission` cannot undo it.
    const readOnlyLock = given(env[READ_ONLY]) !== undefined && env[READ_ONLY] !== "0" ? READ_ONLY : undefined
    const configuredReadOnly = fromLayers("read_only", false)
    const readOnly = readOnlyLock ? { value: true, from: readOnlyLock } : configuredReadOnly
    const allow = fromLayers<readonly Permission[] | undefined>("allow", undefined)
    // A bot has no hourly limit unless the bot section gives it one: a bot that answers people is
    // expected to send a lot, and a limit there is the owner's choice, not the tool's.
    const sendsPerHour =
      kind === "bot"
        ? fromLayers("sends_per_hour", Number.POSITIVE_INFINITY, kindLayers)
        : fromLayers("sends_per_hour", DEFAULT_SENDS_PER_HOUR)
    const paceFromEnv = given(env[REQUESTS_PER_MINUTE])
    const requestsPerMinute =
      paceFromEnv === undefined
        ? fromLayers<number | undefined>("requests_per_minute", undefined)
        : { value: wholeOrZero(paceFromEnv, REQUESTS_PER_MINUTE), from: REQUESTS_PER_MINUTE }
    const readOtherBots =
      kind === "bot"
        ? fromLayers<boolean | readonly string[]>("read_other_bots", false, kindLayers)
        : { value: false, from: "default" }
    // The old settings sit in the layer they were written in, under that layer's own `permissions`.
    const old = configuredReadOnly.value
      ? { label: "read_only", from: configuredReadOnly.from }
      : { label: "allow", from: allow.from }
    const oldLevels = fromOldSettings(configuredReadOnly.value, allow.value, { bot: kind === "bot" })
    const permissions = layerPermissions([
      ["flag", permissionOverrides(flags.permission)],
      ...layers.flatMap(([from, scope]): [Source, Record<PermissionKey, Level> | undefined][] => [
        [from, scope?.permissions as Record<PermissionKey, Level> | undefined],
        ...(from === old.from
          ? [[extension.sourcePaths ? old.from : old.label, oldLevels] as [Source, Record<PermissionKey, Level>]]
          : []),
      ]),
    ])
    const updateCheck = first(
      [
        [
          extension.sourcePaths ? "config file: defaults" : "config defaults",
          settingAt(shared, "update_check") as boolean | undefined,
        ],
      ],
      true,
    )
    const skillHint = first(
      [
        [
          extension.sourcePaths ? "config file: defaults" : "config defaults",
          settingAt(shared, "skill_hint") as boolean | undefined,
        ],
      ],
      true,
    )
    const timeout = first<string | undefined>(
      [
        ["flag", flags.timeout],
        [TIMEOUT, given(env[TIMEOUT])],
      ],
      undefined,
    )

    const ai = resolveAISettings(app.envPrefix, layers, env)
    const settings: Settings = {
      ...ai.values,
      profile: usableProfileName(profile.value),
      json: flags.json === true,
      jsonl: flags.jsonl === true,
      quiet: flags.quiet === true,
      detail: Math.min(2, Math.max(0, flags.verbose ?? 0)) as 0 | 1 | 2,
      trace: flags.trace === true,
      offline: flags.offline === true,
      color: color.value,
      senderColors: senderColors.value,
      catchUpMarksRead: catchUpMarksRead.value,
      searchCatchUp: searchCatchUp.value,
      pictureSearch: pictureSearch.value,
      limit: limit.value,
      page: flags.page ?? 1,
      all: flags.all === true,
      timeoutMs: timeoutMs.value,
      commandTimeoutMs:
        timeout.value === undefined
          ? undefined
          : (extension.parseDuration ?? parseDuration)(timeout.value, timeout.from === TIMEOUT ? TIMEOUT : "--timeout"),
      record: record.value,
      keepFailedRuns: record.value || record.from === "default",
      keepRunsForDays: keepRunsForDays.value,
      readOnly: readOnly.value,
      ...(readOnlyLock ? { readOnlyLock } : {}),
      allow: allow.value,
      permissions: permissions.levels,
      permissionSources: permissions.sources,
      sendsPerHour: sendsPerHour.value,
      ...(requestsPerMinute.value === undefined ? {} : { requestsPerMinute: requestsPerMinute.value }),
      kind,
      readOtherBots: readOtherBots.value,
      updateCheck: updateCheck.value,
      skillHint: skillHint.value,
      configPath,
      configFound: existsSync(configPath),
      configuredProfiles: namedProfiles(config),
      profilesHere: profilesOf(config, env),
      sources: {
        ...ai.sources,
        profile: profile.from,
        limit: limit.from,
        timeoutMs: timeoutMs.from,
        commandTimeoutMs: timeout.from,
        color: color.from,
        senderColors: senderColors.from,
        catchUpMarksRead: catchUpMarksRead.from,
        searchCatchUp: searchCatchUp.from,
        pictureSearch: pictureSearch.from,
        record: record.from,
        keepRunsForDays: keepRunsForDays.from,
        readOnly: readOnly.from,
        allow: allow.from,
        sendsPerHour: sendsPerHour.from,
        requestsPerMinute: requestsPerMinute.from,
        readOtherBots: readOtherBots.from,
        updateCheck: updateCheck.from,
        skillHint: skillHint.from,
      },
      configured,
      shared,
    }

    // The file was checked by the schema; a flag was not, and `--limit abc` is `NaN` by the time it
    // gets here, which slices an array to nothing without complaining.
    if (!Number.isInteger(settings.limit) || settings.limit < 1) {
      throw new CliError("validation_error", `--limit takes a whole number from 1 upwards, not ${flags.limit}`)
    }
    if (!Number.isInteger(settings.page) || settings.page < 1) {
      throw new CliError("validation_error", `--page takes a whole number from 1 upwards, not ${flags.page}`)
    }
    // Refused rather than resolved: one of the two would silently win.
    if (settings.all && flags.page !== undefined) {
      throw new CliError("validation_error", "--all and --page ask for different things; use one or the other")
    }
    const extra = extension.resolve?.({ flags, settings, layers, fromLayers })
    return { ...settings, ...extra?.values, sources: { ...settings.sources, ...extra?.sources } } as Settings & T
  }

  const configuredProfiles = (options: ResolveOptions = {}): string[] =>
    namedProfiles(readConfig(configPathFor(options)))

  /** `config set` and `config unset`: checked by the same schema the reader uses, so it never writes a file the reader refuses. */
  const changeSetting = (
    path: string,
    {
      profile,
      setting,
      value,
      kind,
    }: { profile: string | undefined; setting: string; value: string | undefined; kind?: ProfileKind | undefined },
  ): unknown => {
    const [name = setting, ...rest] = setting.split(".")
    const level = name === "permissions" && rest.length > 0 ? rest.join(".") : undefined
    const modelField = /^models\.([a-z][a-z0-9-]*)\.(provider|model|base_url)$/.exec(setting)
    if (!allSettings.includes(setting) && level === undefined && !modelField) {
      throw new CliError("validation_error", `no setting called "${setting}" — one of: ${allSettings.join(", ")}`)
    }
    if (profile !== undefined && defaultsOnlyKeys.includes(setting)) {
      throw new CliError(
        "validation_error",
        `${setting} is one setting for the whole program, not per profile — add --defaults`,
      )
    }
    if (kind !== undefined && defaultsOnlyKeys.includes(setting)) {
      throw new CliError("validation_error", `${setting} is one setting for the whole program, not per side`)
    }
    if (kind !== "bot" && botOnlyKeys.includes(setting)) {
      throw new CliError("validation_error", `${setting} is a bot's setting — add --bot`)
    }

    const config = readConfig(path)
    if (setting === "default_profile") {
      if (kind !== undefined) {
        throw new CliError("validation_error", "default_profile is one for the whole file — drop --personal and --bot")
      }
      const { default_profile: _, ...rest } = config
      const changed: Config = value === undefined ? rest : { ...rest, default_profile: usableProfileName(value) }
      saveConfigFile(path, changed)
      return changed.default_profile ?? null
    }
    const section = kind === undefined ? undefined : (config[kind] ?? {})
    const current =
      section === undefined
        ? profile === undefined
          ? config.defaults
          : config.profiles[profile]
        : profile === undefined
          ? section.defaults
          : section.profiles?.[profile]
    const scope: Scope = { ...current }
    if (modelField) {
      const purpose = modelField[1] as string
      const field = modelField[2] as string
      const models = { ...(scope.models as Record<string, Scope> | undefined) }
      const target = { ...models[purpose] }
      if (value === undefined) delete target[field]
      else target[field] = parseValue(value)
      if (Object.keys(target).length > 0) models[purpose] = target
      else delete models[purpose]
      if (Object.keys(models).length > 0) scope.models = models
      else delete scope.models
    } else if (level !== undefined) {
      const levels = { ...(scope.permissions as Record<PermissionKey, string> | undefined) }
      if (value === undefined) delete levels[level]
      else levels[level] = value.trim()
      if (Object.keys(levels).length > 0) scope.permissions = levels
      else delete scope.permissions
    } else if (value === undefined) delete scope[setting]
    else scope[setting] = parseValue(value)

    const empty = Object.keys(scope).length === 0
    let changed: Config
    if (kind === undefined || section === undefined) {
      changed =
        profile === undefined
          ? { ...config, defaults: scope }
          : { ...config, profiles: { ...config.profiles, [profile]: scope } }
      if (profile === undefined && empty) delete changed.defaults
      if (profile !== undefined && empty) delete changed.profiles[profile]
    } else {
      const next: KindSection =
        profile === undefined
          ? { ...section, defaults: scope }
          : { ...section, profiles: { ...section.profiles, [profile]: scope } }
      if (profile === undefined && empty) delete next.defaults
      if (profile !== undefined && empty && next.profiles) delete next.profiles[profile]
      if (next.profiles && Object.keys(next.profiles).length === 0) delete next.profiles
      changed = { ...config, [kind]: next }
      if (Object.keys(next).length === 0) delete changed[kind]
    }

    const checked = v.safeParse(extension.schema ?? schema, changed)
    if (!checked.success) {
      throw new CliError(
        "validation_error",
        `${setting} cannot be "${value}": ${checked.issues[0]?.message ?? "invalid"}`,
      )
    }
    saveConfigFile(path, checked.output)
    if (modelField)
      return (
        (scope.models as Record<string, Scope> | undefined)?.[modelField[1] as string]?.[modelField[2] as string] ??
        null
      )
    return level === undefined ? (scope[setting] ?? null) : ((scope.permissions as Scope | undefined)?.[level] ?? null)
  }

  return { resolveSettings, configuredProfiles, changeSetting, allSettings, defaultsOnlyKeys, schema }
}

/** Every profile the file names, in any section. */
const namedProfiles = (config: Config): string[] =>
  [
    ...new Set([
      ...Object.keys(config.profiles),
      ...Object.keys(config.personal?.profiles ?? {}),
      ...Object.keys(config.bot?.profiles ?? {}),
    ]),
  ].sort()

const DURATION = /^(\d+)(ms|s|m|h|d)$/
const UNIT_MS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }

/** Named by where it came from, so somebody who set the variable weeks ago is told which thing is wrong. */
export const parseDuration = (value: string, source: string): number => {
  const match = DURATION.exec(value.trim())
  if (!match?.[1] || !match[2]) {
    throw new CliError(
      "validation_error",
      `${source} takes a duration with a unit — 500ms, 30s, 2m, 4h or 1d — not "${value}"`,
    )
  }
  const ms = Number(match[1]) * (UNIT_MS[match[2]] ?? 0)
  if (ms <= 0) throw new CliError("validation_error", `${source} has to be more than zero, and "${value}" is not`)
  return ms
}

/** A list is written `a,b` on the command line and kept as an array; everything else is JSON or a string. */
const parseValue = (value: string): unknown => {
  const trimmed = value.trim()
  if (/^[^[{"]/.test(trimmed) && trimmed.includes(",")) {
    return trimmed
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
  }
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

const given = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim()
  return trimmed === undefined || trimmed === "" ? undefined : trimmed
}

/** What `settingsFor` hands a CLI — named, so a CLI can export it without naming the schema library's types. */
export type Configuration = ReturnType<typeof settingsFor>
