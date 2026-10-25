import { existsSync } from "node:fs"
import { CliError, configFilePath, resolvePaths, saveConfigFile } from "@wirecat/cli-base"
import * as v from "valibot"
import { AI_ENTRIES, type AISettings, resolveAISettings } from "../analysis/settings.js"
import { parseDuration } from "../domain/duration.js"
import { DEFAULT_RERANK_MODEL, RERANK_MODELS } from "../embeddings/models.js"
import { type AppIdentity, envName, readOnlyLockOf } from "../ports/app.js"
import {
  assertOverridesTighten,
  CEILING_KEY,
  LEVELS,
  type Level,
  layerPermissions,
  type PermissionKey,
  permissionOverrides,
  RESOURCES,
} from "../sends/permissions.js"
import { storePath } from "../store/path.js"
import { sharedConfigPath } from "../store/shared-config.js"
import {
  type ConfigIssue,
  checkConfigText,
  issueMessage,
  readConfigFile,
  readConfigText,
  savedPermissionKeys,
  schemaIssues,
  settingPathOf,
  withoutPath,
} from "./config-issues.js"
import { DEFAULT_CONFIG, ensureDefaultConfig } from "./default-config.js"
import { profilesHere } from "./messenger/accounts.js"
import { usableProfileName } from "./profile.js"
import { permissionCeiling } from "./setup-answers.js"

const DEFAULT_LIMIT = DEFAULT_CONFIG.defaults.limit
const DEFAULT_KEEP_RUNS_FOR_DAYS = DEFAULT_CONFIG.defaults.keep_runs_for_days
/** On by default: a limit that is off protects nobody from a loop. */
const DEFAULT_SENDS_PER_HOUR = DEFAULT_CONFIG.defaults.sends_per_hour

/** The first-run answer caps every profile; a config file cannot name its key, so only `setup` writes it. */
const withCeiling = (
  permissions: { levels: Record<PermissionKey, Level>; sources: Record<PermissionKey, Source> },
  env: NodeJS.ProcessEnv,
) => {
  const ceiling = permissionCeiling(sharedConfigPath(storePath(env), env))
  return ceiling
    ? {
        levels: { ...permissions.levels, [CEILING_KEY]: ceiling },
        sources: { ...permissions.sources, [CEILING_KEY]: "setup answer" },
      }
    : permissions
}

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
const objectMessage: v.ErrorMessage<v.StrictObjectIssue> = (issue) =>
  issue.expected === "never" ? "unknown setting" : "has to be an object, in braces"

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
  permissions: v.optional(permissionLevels),
  sends_per_hour: v.optional(count),
  requests_per_minute: v.optional(countOrZero),
  transcribe_with: v.optional(v.picklist(["auto", "messenger", "local"], plain("has to be auto, messenger or local"))),
  speech_model: v.optional(v.string(plain("has to be a model id from `models list`, in quotes"))),
  search_catch_up: v.optional(flag),
  picture_search: v.optional(flag),
  search_reranker: v.optional(
    v.picklist(
      [...RERANK_MODELS.map((model) => model.id), "off"],
      plain(`has to be off or a reranker id: ${RERANK_MODELS.map((model) => model.id).join(", ")}`),
    ),
  ),
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
  searchCatchUp?: boolean
  /** Search and `images embed` read the pictures themselves, with a model on this machine. Off until set. */
  pictureSearch?: boolean
  /** The reranker that orders `search messages --discover`'s first hits once it is downloaded, or `off`. */
  searchReranker: string
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
  /** The variable that made this process read-only, above every level and flag (`<PREFIX>_READ_ONLY`). */
  readOnlyLock?: string
  /**
   * The levels the owner set in the file's `permissions`. The built-in defaults are not here: `levelFor`
   * adds them, and they only ever tighten.
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
  /**
   * What is wrong in the file; empty unless resolved `withIssues`, which leaves those settings out. Optional for an
   * app that builds `Settings` from a file of its own.
   */
  configIssues?: ConfigIssue[]
  /**
   * Every permission key saved anywhere in the file, for the program to check against its commands. An app that
   * builds `Settings` itself leaves it out, and only the keys in force are checked.
   */
  savedPermissions?: { key: PermissionKey; at: string[] }[]
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
  /** Read the config file without writing it: no default file. For a dry run. */
  readOnly?: boolean
  /**
   * Load what is valid and report the rest in `configIssues`, rather than refuse: for `doctor`, which reports,
   * and `config`, which repairs. Invalid JSON loads as an empty file.
   */
  withIssues?: boolean
}

/** Where `profile` came from when none was named and the command needs none. */
export const NONE_NAMED = "none named"

/** A name for a command that speaks for no account; never chosen for one that does. */
const NO_PROFILE = "default"

/** The profile a run is for: none when nothing named one, even though `Settings.profile` holds a placeholder. */
export const namedProfile = (settings: Pick<Settings, "profile"> & Partial<Pick<Settings, "sources">>) =>
  settings.sources?.profile === NONE_NAMED ? undefined : settings.profile

/**
 * No profile named and none on this computer. The settings cannot see the program, so the program swaps the
 * `setup` this suggests for `withoutSetup` when it has no such command.
 */
export class NoProfileHere extends CliError {
  constructor(private readonly app: AppIdentity) {
    super(
      "validation_error",
      `name a profile: there is none on this computer yet — create one with \`${app.command} personal setup\` ` +
        "(any name in place of personal)",
      { profiles: [] },
    )
  }

  /** `words`: the command that was typed, without its arguments, so the suggestion runs as written. */
  withoutSetup(words: string): CliError {
    const command = words ? `${this.app.command} personal ${words}` : `${this.app.command} personal …`
    return new CliError(
      "validation_error",
      `name a profile: there is none on this computer yet — any name works, such as \`${command}\` ` +
        `(or set ${envName(this.app, "PROFILE")})`,
      { profiles: [] },
    )
  }
}

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
  const strictOf = <E extends v.ObjectEntries>(entries: E) => v.strictObject(entries, objectMessage)
  const kindSection = (entries: v.ObjectEntries) =>
    v.strictObject(
      {
        defaults: v.optional(strictOf(entries)),
        profiles: v.optional(v.record(v.string(), strictOf(entries), "has to be an object of profiles, by name")),
      },
      objectMessage,
    )
  const configEntries = {
    defaults: v.optional(strictOf(defaultsEntries)),
    profiles: v.optional(
      v.record(v.string(), strictOf(profileEntries), "has to be an object of profiles, by name"),
      {},
    ),
    personal: v.optional(kindSection(profileEntries)),
    bot: v.optional(kindSection({ ...profileEntries, ...BOT_ONLY_ENTRIES })),
  }
  const schema = strictOf(configEntries)
  const defaultsOnlyKeys = Object.keys(defaultsOnly)
  const botOnlyKeys = Object.keys(BOT_ONLY_ENTRIES)
  const allSettings = [...Object.keys(profileEntries), ...botOnlyKeys, ...defaultsOnlyKeys]

  const PROFILE = envName(app, "PROFILE")
  const PROFILE_LOCK = envName(app, "PROFILE_LOCK")
  const TIMEOUT = envName(app, "TIMEOUT")
  const REQUESTS_PER_MINUTE = envName(app, "REQUESTS_PER_MINUTE")

  const configPathFor = ({ env = process.env, configDir }: ResolveOptions) =>
    configFilePath(configDir ?? resolvePaths({ appName: app.appName, prefix: app.envPrefix, env }).config)

  const readSchema = extension.schema ?? schema
  const context = (file: string) => ({ file, tool: app.command })

  /** The file with every problem found; what loads is the file without the settings they name. */
  const loadConfig = (path: string): { config: Config; issues: ConfigIssue[] } => {
    const read = readConfigText(path)
    if ("issue" in read) return { config: { profiles: {} }, issues: [read.issue] }
    if (read.text === undefined) return { config: { profiles: {} }, issues: [] }
    const { config, issues } = checkConfigText(read.text, { file: path, tool: app.command, schema: readSchema })
    return { config: (config ?? { profiles: {} }) as Config, issues }
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
    if (!needed) return { value: NO_PROFILE, from: NONE_NAMED }
    const here = profilesOf(config, env)
    if (here.length === 0) throw new NoProfileHere(app)
    throw new CliError(
      "validation_error",
      `name a profile: \`${app.command} <profile> …\` — profiles here: ${here.join(", ")} (or set ${PROFILE})`,
      { profiles: here },
    )
  }

  const profilesOf = (config: Config, env: NodeJS.ProcessEnv): string[] =>
    profilesHere(app, [...namedProfiles(config), ...(extension.profiles?.(env) ?? [])], env)

  const resolveSettings = (flags: GlobalFlags = {}, options: ResolveOptions = {}): Settings & T => {
    const env = options.env ?? process.env
    const configPath = configPathFor(options)
    try {
      if (!options.readOnly) ensureDefaultConfig(configPath)
    } catch (error) {
      throw new CliError("configuration_error", error instanceof Error ? error.message : String(error))
    }
    const loaded = loadConfig(configPath)
    if (loaded.issues.length > 0 && !options.withIssues)
      throw new CliError("configuration_error", issueMessage(loaded.issues))
    const { config } = loaded

    const lock = given(env[PROFILE_LOCK])
    const named = first<string | undefined>(
      [
        ["first word", flags.profile],
        [PROFILE, given(env[PROFILE])],
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
        only.map(([from, scope]): [Source, T | undefined] => [from, scope?.[key] as T | undefined]),
        fallback,
      )
    const kindLayers = layers.filter(([from]) => from.startsWith(`config file: ${kind}.`))

    const limit = flags.limit === undefined ? fromLayers("limit", DEFAULT_LIMIT) : { value: flags.limit, from: "flag" }
    const record = flags.record === undefined ? fromLayers("record", false) : { value: flags.record, from: "flag" }
    const timeoutMs = fromLayers<number | undefined>("timeout_ms", undefined)
    const color = fromLayers<boolean | undefined>("color", undefined)
    const senderColors = fromLayers("sender_colors", false)
    const searchCatchUp = fromLayers("search_catch_up", false)
    const pictureSearch = fromLayers("picture_search", false)
    const searchReranker = fromLayers<string>("search_reranker", DEFAULT_RERANK_MODEL)
    const keepRunsForDays = fromLayers("keep_runs_for_days", DEFAULT_KEEP_RUNS_FOR_DAYS)
    // Set where an agent runs unattended; the config file and `--permission` cannot undo it.
    const readOnlyLock = readOnlyLockOf(app, env)
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
    const fileLayers = layers.map(([from, scope]): [Source, Record<PermissionKey, Level> | undefined] => [
      from,
      scope?.permissions as Record<PermissionKey, Level> | undefined,
    ])
    const overrides = permissionOverrides(flags.permission)
    assertOverridesTighten(overrides, layerPermissions(fileLayers).levels)
    const permissions = withCeiling(layerPermissions([["flag", overrides], ...fileLayers]), env)
    const updateCheck = first(
      [
        [
          extension.sourcePaths ? "config file: defaults" : "config defaults",
          shared.update_check as boolean | undefined,
        ],
      ],
      true,
    )
    const skillHint = first(
      [[extension.sourcePaths ? "config file: defaults" : "config defaults", shared.skill_hint as boolean | undefined]],
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
      searchCatchUp: searchCatchUp.value,
      pictureSearch: pictureSearch.value,
      searchReranker: searchReranker.value,
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
      ...(readOnlyLock ? { readOnlyLock } : {}),
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
        searchCatchUp: searchCatchUp.from,
        pictureSearch: pictureSearch.from,
        searchReranker: searchReranker.from,
        record: record.from,
        keepRunsForDays: keepRunsForDays.from,
        sendsPerHour: sendsPerHour.from,
        requestsPerMinute: requestsPerMinute.from,
        readOtherBots: readOtherBots.from,
        updateCheck: updateCheck.from,
        skillHint: skillHint.from,
      },
      configured,
      shared,
      configIssues: loaded.issues,
      savedPermissions: savedPermissionKeys(config),
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

  const configuredProfiles = (options: ResolveOptions = {}): string[] => {
    const { config, issues } = loadConfig(configPathFor(options))
    if (issues.length > 0 && !options.withIssues) throw new CliError("configuration_error", issueMessage(issues))
    return namedProfiles(config)
  }

  /**
   * `config set` and `config unset`, on the file as written, so they also run on a file with problems. A set is
   * refused only for a problem it would add; an unset removes the setting whether or not the schema knows it.
   * `root` reaches a path outside any profile or `defaults`, and only one that has a problem.
   */
  const changeSetting = (
    path: string,
    {
      profile,
      setting,
      value,
      kind,
      root = false,
    }: {
      profile: string | undefined
      setting: string
      value: string | undefined
      kind?: ProfileKind | undefined
      root?: boolean
    },
  ): unknown => {
    const [name = setting, ...rest] = setting.split(".")
    const level = name === "permissions" && rest.length > 0 ? rest.join(".") : undefined
    const modelField = /^models\.([a-z][a-z0-9-]*)\.(provider|model|base_url)$/.exec(setting)
    const known = allSettings.includes(setting) || level !== undefined || modelField !== null
    const read = readConfigFile(path)
    if ("issue" in read) throw new CliError("configuration_error", issueMessage([read.issue]))
    const raw = read.raw === undefined ? {} : read.raw
    if (!isScope(raw)) throw new CliError("configuration_error", `${path}: the file has to be an object, in braces`)
    const scopePath = root
      ? []
      : [...(kind === undefined ? [] : [kind]), ...(profile === undefined ? ["defaults"] : ["profiles", profile])]
    const keyPath = root
      ? settingPathOf(setting)
      : level !== undefined
        ? ["permissions", level]
        : modelField
          ? ["models", modelField[1] as string, modelField[2] as string]
          : [setting]
    const at = [...scopePath, ...keyPath]
    const before = schemaIssues(raw, readSchema, context(path))

    if (value === undefined) {
      if (root && !before.some((issue) => issue.at.join(".") === at.join(".")))
        throw new CliError(
          "validation_error",
          `${setting} has no problem to remove — name the profile, or add --defaults, to unset a setting`,
        )
      if (!known && valueAt(raw, at) === undefined)
        throw new CliError("validation_error", `no setting called "${setting}" — one of: ${allSettings.join(", ")}`)
      saveConfigFile(path, withoutPath(raw, at).config)
      return null
    }

    if (!known)
      throw new CliError("validation_error", `no setting called "${setting}" — one of: ${allSettings.join(", ")}`)
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
    const changed = structuredClone(raw)
    setAt(changed, at, level === undefined ? parseValue(value) : value.trim())
    const had = new Set(before.map((issue) => issue.at.join(".")))
    const added = schemaIssues(changed, readSchema, context(path)).find(
      (issue) => !had.has(issue.at.join(".")) || issue.at.join(".") === at.join("."),
    )
    if (added) throw new CliError("validation_error", `${setting} cannot be "${value}": ${added.what}`)
    const checked = v.safeParse(readSchema, changed)
    saveConfigFile(path, checked.success ? checked.output : changed)
    return valueAt(checked.success ? checked.output : changed, at) ?? null
  }

  return { resolveSettings, configuredProfiles, changeSetting, allSettings, defaultsOnlyKeys, schema }
}

const isScope = (value: unknown): value is Scope => typeof value === "object" && value !== null && !Array.isArray(value)

const valueAt = (node: unknown, path: readonly string[]): unknown =>
  path.reduce<unknown>((at, key) => (isScope(at) || Array.isArray(at) ? (at as Scope)[key] : undefined), node)

const setAt = (node: Scope, path: readonly string[], value: unknown): void => {
  let at = node
  for (const key of path.slice(0, -1)) {
    if (!isScope(at[key])) at[key] = {}
    at = at[key] as Scope
  }
  at[path.at(-1) as string] = value
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
