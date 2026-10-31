import { CliError, pathsAreOverridden } from "@wirecat/cli-base"
import { annotate } from "@wirecat/cli-base/commands"
import { Command } from "commander"
import { type AppIdentity, envName } from "../ports/app.js"
import { AUTHORITY_KEY, BOT_API_KEY } from "../sends/permissions.js"
import { baseContext, environmentOf } from "./context.js"
import { grantsAuthority, LOCAL_READ, LOCAL_WRITE } from "./effects.js"
import { itemOf, renderAnswer } from "./envelope.js"
import {
  knownBeside,
  knownPermissionKeys,
  type PermissionKeySource,
  unknownPermissionIssues,
} from "./permission-keys.js"
import { type Configuration, fromFile, NONE_NAMED, type Settings } from "./settings.js"
import { nextStep } from "./steps.js"
import {
  changeStoreSetting,
  isStoreSetting,
  offersStoreSetting,
  storeSettings,
  storeSettingsOf,
} from "./store-settings.js"

/**
 * The settings in force and where each came from, and changing them. Printed whole: no field the
 * configuration accepts can hold a secret — the schema has nowhere to put one.
 */

export const configCommand = (
  app: AppIdentity,
  config: Configuration,
  { permissionKey = config.permissions }: { permissionKey?: PermissionKeySource | undefined } = {},
): Command => {
  const command = new Command("config").description("the settings in force, and where each one came from")

  // Only a messenger has bots, and with them the personal and bot sections of the file.
  const bots = app.messenger !== false
  const show = annotate(command.command("show"), {
    effects: LOCAL_READ,
    examples: [`${app.command} personal config show`],
  }).description("the profile, the profiles that exist, and each setting with where it came from")
  if (bots) show.option("--bot", "the settings a bot command on this profile gets, rather than the personal account's")
  show.action(async function (this: Command) {
    const bot = this.opts<{ bot?: boolean }>().bot === true
    const context = baseContext(this, (flags, options) =>
      config.resolveSettings(flags, {
        ...options,
        needsProfile: false,
        withIssues: true,
        ...(bot ? { kind: "bot" } : {}),
      }),
    )
    const { settings, renderer, env } = context
    const overridden = pathsAreOverridden({ appName: app.appName, prefix: app.envPrefix, env })

    renderAnswer(
      this,
      context,
      itemOf({
        profile: settings.sources.profile === NONE_NAMED ? null : settings.profile,
        profile_from: settings.sources.profile,
        kind: settings.kind,
        permissions: settings.permissions,
        permission_sources: settings.permissionSources,
        profiles: settings.profilesHere,
        config_file: settings.configPath,
        config_found: settings.configFound,
        paths_overridden: overridden,
        settings: [...config.allSettings, "command_timeout_ms"]
          .filter((setting) => bot || setting !== "read_other_bots")
          .map((setting) => sourced(settings, setting)),
        store_settings: await storeSettings(env),
      }),
    )

    for (const issue of [
      ...(settings.configIssues ?? []),
      ...unknownPermissionIssues(this, settings, app.command, permissionKey),
    ])
      renderer.warn(`${issue.what}, so it is left out${issue.fix ? ` — \`${issue.fix}\` removes it` : ""}`)
    if (overridden) {
      renderer.note(
        `${envName(app, "CONFIG_DIR")}, ${envName(app, "STATE_DIR")} or ${envName(app, "CACHE_DIR")} is set — ` +
          "a session is still read from the usual keyring entry, but a sign-in made with them is kept apart, in a " +
          "temporary entry that session end removes",
      )
    }
  })

  for (const action of ["set", "unset"] as const) {
    const sub = grantsAuthority(
      annotate(command.command(action), {
        effects: LOCAL_WRITE,
        examples: [`${app.command} personal config ${action} limit${action === "set" ? " 20" : ""}`],
      }),
    )
      .argument("<setting>", `one of: ${[...config.allSettings, ...storeSettingsOf(app)].join(", ")}`)
      .option("--defaults", "change what every profile gets, rather than this profile")
    if (bots)
      sub
        .option("--personal", "only for personal accounts — the personal section of the file")
        .option("--bot", "only for bots — the bot section of the file")
    if (action === "set")
      sub
        .argument("<value>", "a number, true or false; for a group tg:work,max:Alice,email:me@x")
        .description("save a setting to the configuration file")
    else sub.description("remove a setting from the configuration file")

    sub.action(async function (this: Command, setting: string, given: unknown) {
      const {
        defaults: everyone,
        personal,
        bot,
      } = this.opts<{ defaults?: boolean; personal?: boolean; bot?: boolean }>()
      const context = baseContext(this, (flags, options) =>
        config.resolveSettings(flags, { ...options, needsProfile: false, withIssues: true }),
      )
      const { settings, renderer, env } = context
      if (isStoreSetting(setting) && !offersStoreSetting(app, setting))
        throw new CliError(
          "validation_error",
          `no setting called "${setting}" here — it belongs to the messenger CLIs; one of: ${[...config.allSettings, ...storeSettingsOf(app)].join(", ")}`,
        )
      if (isStoreSetting(setting)) {
        if (everyone || personal || bot)
          throw new CliError(
            "validation_error",
            `${setting} is store-wide — --defaults, --personal and --bot do not apply`,
          )
        const lock = envName(app, "PROFILE_LOCK")
        if (env[lock]) {
          throw new CliError(
            "permission_error",
            `this process is locked to profile ${settings.profile} (${lock}) — ${setting} changes every profile, tg and MAX`,
          )
        }
        const changed = await changeStoreSetting(app, env, setting, action === "set" ? String(given) : undefined)
        renderAnswer(
          this,
          context,
          itemOf(changed.result, {
            next:
              "reindex" in changed
                ? [nextStep("store.reindex", { args: {} })]
                : "rebuild" in changed
                  ? [nextStep("mentions.rebuild", { args: { kind: "phone" } })]
                  : [],
          }),
        )
        renderer.note(changed.note)
        return
      }
      const defaults = everyone === true
      // The unset `doctor` gives for a problem outside any profile: one with no profile typed reaches it, whatever
      // profile the environment names.
      const root =
        action === "unset" &&
        !defaults &&
        !personal &&
        !bot &&
        settings.sources.profile !== "first word" &&
        (settings.configIssues ?? []).some((issue) => issue.fix === `${app.command} config unset ${setting}`)
      if (!root && !defaults && settings.sources.profile === NONE_NAMED)
        config.resolveSettings(this.optsWithGlobals(), { env, withIssues: true })
      if (personal && bot)
        throw new CliError("validation_error", "--personal and --bot name different sections; use one")
      const kind = bot ? "bot" : personal ? "personal" : undefined
      const lock = envName(app, "PROFILE_LOCK")
      if ((defaults || root) && env[lock]) {
        // The defaults are every other profile's settings too, and the top of the file is everyone's.
        throw new CliError(
          "permission_error",
          `this process is locked to profile ${settings.profile} (${lock}) — ${root ? setting : "--defaults"} changes other profiles`,
        )
      }
      if (environmentOf(this).agent) refuseGuardedKey(setting, action === "set" ? String(given) : undefined)
      if (action === "set") refuseUnknownKey(this, setting, String(given), permissionKey)
      const saved = config.changeSetting(settings.configPath, {
        profile: defaults || root ? undefined : settings.profile,
        setting,
        value: action === "set" ? String(given) : undefined,
        kind,
        root,
      })
      renderAnswer(
        this,
        context,
        itemOf({
          config_file: settings.configPath,
          scope: root ? "file" : scopeOf(kind, defaults ? undefined : settings.profile),
          setting,
          value: saved,
        }),
      )
    })
  }

  return command
}

/**
 * A key no command or write is checked against would be saved and do nothing (BUG-137) — whether it
 * comes as `permissions.<key>` or inside a whole `permissions` object.
 */
export const refuseUnknownKey = (
  command: Command,
  setting: string,
  value: string,
  permissionKey?: PermissionKeySource,
): void => {
  const keys = setting.startsWith("permissions.")
    ? [setting.slice("permissions.".length)]
    : setting === "permissions"
      ? objectKeys(value)
      : []
  if (keys.length === 0) return
  const known = knownPermissionKeys(command, permissionKey)
  for (const key of keys) {
    if (known.has(key)) continue
    const beside = knownBeside(key, known)
    throw new CliError(
      "validation_error",
      `permissions.${key} names no command` +
        (beside.length > 0 ? ` — the known ones there are ${beside.join(", ")}` : ""),
    )
  }
}

/**
 * An agent may hold `mcp.authority` or `bot.api` and change other settings, but never the key that let it in: on any
 * profile, in the defaults, or by replacing `permissions` whole. Only the owner, in a terminal, turns it on or off
 * (NEED-1662, NEED-1679).
 */
const refuseGuardedKey = (setting: string, value: string | undefined): void => {
  const keys = setting.startsWith("permissions.")
    ? [setting.slice("permissions.".length)]
    : setting === "permissions"
      ? value === undefined
        ? ["mcp"]
        : objectKeys(value)
      : []
  const guarded = keys.some((key) => key === BOT_API_KEY || key.startsWith(`${BOT_API_KEY}.`))
    ? BOT_API_KEY
    : keys.some((key) => key === "mcp" || key.startsWith("mcp."))
      ? AUTHORITY_KEY
      : undefined
  if (!guarded) return
  throw new CliError(
    "permission_error",
    `an agent cannot change permissions.${guarded} — the owner sets it in a terminal`,
    { permission: guarded },
  )
}

/** The keys of a `permissions` object given whole; anything else is left to the schema to refuse. */
const objectKeys = (value: string): string[] => {
  try {
    const parsed: unknown = JSON.parse(value)
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? Object.keys(parsed) : []
  } catch {
    return []
  }
}

const scopeOf = (kind: string | undefined, profile: string | undefined): string =>
  [kind, profile === undefined ? "defaults" : `profiles.${profile}`].filter(Boolean).join(".")

/** A shared setting from what was resolved; a messenger's own from the file, where it lives. */
const sourced = (settings: Settings, setting: string) => {
  if (setting === "models") {
    return {
      setting,
      value: settings.models ?? {},
      from: "resolved per purpose",
      sources: Object.fromEntries(Object.entries(settings.sources).filter(([key]) => key.startsWith("models."))),
    }
  }
  // Every layer adds to `permissions`, so the nearest layer's object alone is not what holds.
  if (setting === "permissions") {
    const from = Object.keys(settings.permissions).length > 0 ? "config file" : "default"
    return { setting, value: settings.permissions, from, sources: settings.permissionSources }
  }
  // The code reads `timeoutMs`; the file says `timeout_ms`.
  const field = setting.replace(/_([a-z0-9])/g, (_, letter: string) => letter.toUpperCase())
  if (field in settings.sources) {
    const value = (settings as unknown as Record<string, unknown>)[field]
    return { setting, value: value ?? null, from: settings.sources[field] }
  }
  const { value, from } = fromFile<unknown>(settings, setting, UNLISTED_DEFAULTS[setting] ?? null)
  return { setting, value, from }
}

/** Settings read where they are used rather than in `resolveSettings`, and what an unset one means there. */
const UNLISTED_DEFAULTS: Record<string, unknown> = { transcribe_with: "auto" }
