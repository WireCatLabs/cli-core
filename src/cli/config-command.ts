import { CliError, configFilePath, pathsAreOverridden, resolvePaths, saveConfigFile } from "@wirecat/cli-base"
import { annotate } from "@wirecat/cli-base/commands"
import { Command } from "commander"
import * as v from "valibot"
import { type AppIdentity, envName } from "./app.js"
import { declaredSettingName, loadSnakeCaseConfig } from "./config-keys.js"
import { baseContext } from "./context.js"
import { LOCAL_READ, LOCAL_WRITE } from "./effects.js"
import { itemOf, renderAnswer } from "./envelope.js"
import { knownBeside, knownPermissionKeys, type PermissionKeyOf } from "./permission-keys.js"
import { hasPermissionConfig, migratePermissionConfig } from "./permission-migration.js"
import { type Configuration, fromFile, NONE_NAMED, type Settings } from "./settings.js"
import { nextStep } from "./steps.js"
import { changeStoreSetting, isStoreSetting, STORE_SETTINGS, storeSettings } from "./store-settings.js"

/**
 * The settings in force and where each came from, and changing them. Printed whole: no field the
 * configuration accepts can hold a secret — the schema has nowhere to put one.
 */
export const configCommand = (
  app: AppIdentity,
  config: Configuration,
  { permissionKey }: { permissionKey?: PermissionKeyOf } = {},
): Command => {
  const command = new Command("config").description("the settings in force, and where each one came from")

  command.addCommand(
    annotate(new Command("migrate"), { effects: LOCAL_WRITE })
      .description("replace legacy access settings with permissions, preserving this file's effective levels")
      .option("--dry-run", "show the migration without writing the file")
      .action(function () {
        const dryRun = this.opts<{ dryRun?: boolean }>().dryRun === true
        const context = baseContext(this, (flags, options) =>
          config.resolveSettings(flags, { ...options, needsProfile: false, readOnly: dryRun }),
        )
        const { env } = context
        if (!dryRun && env[envName(app, "PROFILE_LOCK")])
          throw new CliError("permission_error", "config migrate changes every profile — run outside the profile lock")
        const path = configFilePath(resolvePaths({ appName: app.appName, prefix: app.envPrefix, env }).config)
        const migrated = migratePermissionConfig(
          loadSnakeCaseConfig(path, config.schema, () => ({ profiles: {} }), { rewrite: !dryRun }),
        )
        if (migrated.changed) {
          const checked = v.safeParse(config.schema, migrated.config)
          if (!checked.success)
            throw new CliError(
              "configuration_error",
              "the migrated configuration is not valid — the file was not changed",
            )
          if (!dryRun) saveConfigFile(path, checked.output)
        }
        renderAnswer(
          this,
          context,
          itemOf({ config_file: path, changed: migrated.changed, dry_run: dryRun, changes: migrated.changes }),
        )
      }),
  )

  annotate(command.command("show"), { effects: LOCAL_READ })
    .description("the profile, the profiles that exist, and each setting with where it came from")
    .option("--bot", "the settings a bot command on this profile gets, rather than the personal account's")
    .action(async function (this: Command) {
      const bot = this.opts<{ bot?: boolean }>().bot === true
      const context = baseContext(this, (flags, options) =>
        config.resolveSettings(flags, { ...options, needsProfile: false, ...(bot ? { kind: "bot" } : {}) }),
      )
      const { settings, renderer, env } = context
      const overridden = pathsAreOverridden({ appName: app.appName, prefix: app.envPrefix, env })

      renderAnswer(
        this,
        context,
        itemOf({
          profile: settings.sources.profile === NONE_NAMED ? null : settings.profile,
          profile_from: settings.sources.profile,
          profiles: settings.profilesHere,
          config_file: settings.configPath,
          config_found: settings.configFound,
          paths_overridden: overridden,
          settings: [...config.allSettings, "command_timeout_ms"]
            .filter((setting) => bot || setting !== "read_other_bots")
            .map((setting) => sourced(settings, setting, config.schema)),
          store_settings: await storeSettings(env),
        }),
      )

      if (overridden) {
        renderer.note(
          `${envName(app, "CONFIG_DIR")}, ${envName(app, "STATE_DIR")} or ${envName(app, "CACHE_DIR")} is set — ` +
            "a profile's keyring entry is not the usual one, so a session made without them reads as none",
        )
      }
    })

  for (const action of ["set", "unset"] as const) {
    const sub = annotate(command.command(action), { effects: LOCAL_WRITE })
      .argument("<setting>", `one of: ${[...config.allSettings, ...STORE_SETTINGS, "accountGroups.<name>"].join(", ")}`)
      .option("--defaults", "change what every profile gets, rather than this profile")
      .option("--personal", "only for personal accounts — the personal section of the file")
      .option("--bot", "only for bots — the bot section of the file")
    if (action === "set")
      sub
        .argument(
          "<value>",
          "a number, true or false, or for allow a list like send,reaction; for a group tg:work,max:Alice,email:me@x",
        )
        .description("save a setting to the configuration file")
    else sub.description("remove a setting from the configuration file")

    sub.action(async function (this: Command, typed: string, given: unknown) {
      const head = typed.split(".")[0] ?? typed
      const setting = config.allSettings.includes(head) || isStoreSetting(typed) ? typed : declaredSettingName(typed)
      const {
        defaults: everyone,
        personal,
        bot,
      } = this.opts<{ defaults?: boolean; personal?: boolean; bot?: boolean }>()
      const context = baseContext(this, (flags, options) =>
        config.resolveSettings(flags, {
          ...options,
          needsProfile: !everyone && setting !== "default_profile" && !isStoreSetting(setting),
        }),
      )
      const { settings, renderer, env } = context
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
          itemOf(changed.result, { next: "reindex" in changed ? [nextStep("store.reindex", { args: {} })] : [] }),
        )
        renderer.note(changed.note)
        return
      }
      const defaults = everyone === true
      if (setting === "default_profile" && (defaults || personal || bot))
        throw new CliError(
          "validation_error",
          "default_profile is one for the whole file — drop --defaults, --personal and --bot",
        )
      if (personal && bot)
        throw new CliError("validation_error", "--personal and --bot name different sections; use one")
      const kind = bot ? "bot" : personal ? "personal" : undefined
      const lock = envName(app, "PROFILE_LOCK")
      if ((defaults || setting === "default_profile") && env[lock]) {
        // The defaults are every other profile's settings too, and default_profile picks one of them.
        throw new CliError(
          "permission_error",
          `this process is locked to profile ${settings.profile} (${lock}) — ${setting === "default_profile" ? setting : "--defaults"} changes other profiles`,
        )
      }
      if (
        ["read_only", "allow", "mcpTools"].includes(setting) &&
        hasPermissionConfig(loadSnakeCaseConfig(settings.configPath, config.schema, () => ({ profiles: {} })))
      ) {
        throw new CliError(
          "validation_error",
          `${setting} is a legacy setting — use permissions instead; config migrate --dry-run previews the translation`,
        )
      }
      if (action === "set") refuseUnknownKey(this, setting, String(given), permissionKey)
      const saved = config.changeSetting(settings.configPath, {
        profile: defaults || setting === "default_profile" ? undefined : settings.profile,
        setting,
        value: action === "set" ? String(given) : undefined,
        kind,
      })
      renderAnswer(
        this,
        context,
        itemOf({
          config_file: settings.configPath,
          scope:
            setting === "default_profile" ? "default_profile" : scopeOf(kind, defaults ? undefined : settings.profile),
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
  permissionKey?: PermissionKeyOf,
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
const sourced = (settings: Settings, setting: string, schema: Configuration["schema"]) => {
  if (setting === "default_profile") {
    const named = loadSnakeCaseConfig(settings.configPath, schema, () => ({ profiles: {} })).default_profile
    return { setting, value: named ?? null, from: named === undefined ? "default" : "config file" }
  }
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
    // No list is every action, and `null` would read as none.
    return { setting, value: setting === "allow" ? (value ?? "all") : (value ?? null), from: settings.sources[field] }
  }
  const { value, from } = fromFile<unknown>(settings, setting, UNLISTED_DEFAULTS[setting] ?? null)
  return { setting, value, from }
}

/** Settings read where they are used rather than in `resolveSettings`, and what an unset one means there. */
const UNLISTED_DEFAULTS: Record<string, unknown> = { transcribe_with: "auto" }
