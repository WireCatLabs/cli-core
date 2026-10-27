import { existsSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { CliError, configFilePath, resolvePaths } from "@wirecat/cli-base"
import { annotate } from "@wirecat/cli-base/commands"
import { Command } from "commander"
import { type AppIdentity, envName, readOnlyLockOf } from "../ports/app.js"
import { storePath } from "../store/path.js"
import { environmentOf, outputFor } from "./context.js"
import { LOCAL_READ } from "./effects.js"
import { itemOf, renderAnswer } from "./envelope.js"
import { privateFiles } from "./messenger/private-files.js"
import { unknownPermissionIssues } from "./permission-keys.js"
import { profileFree } from "./profile.js"
import type { Configuration } from "./settings.js"

export interface AppDoctorOptions {
  /**
   * Which OAuth client the CLI signs in with — WireCat's or one of the owner's own — read from the environment and
   * files only. A throw is reported as its message.
   */
  oauthClient?: (env: NodeJS.ProcessEnv) => { client: "wirecat" | "own" }
}

const failure = (error: unknown) => {
  if (error instanceof CliError) return error.message
  throw error
}

const configFiles = (path: string) => {
  const files = privateFiles({ files: [path], dirs: [dirname(path)] })
  if (!files.checked) return { files, fixes: [] }
  return {
    files: { ...files, problems: files.problems.map(({ path, mode, want }) => ({ path, mode, want })) },
    fixes: files.problems.map((problem) => problem.fix),
  }
}

/**
 * Run when everything else is broken, so a problem in the config file or the OAuth setting is a field, never a throw.
 * It reads no keyring, opens no store and calls no service: each can hang or prompt. `fixes` are the `chmod` commands
 * that make the config private; they go to stderr, not into the answer.
 */
export const appDoctorReport = (
  app: AppIdentity,
  configuration: Configuration,
  env: NodeJS.ProcessEnv,
  command: Command,
  options: AppDoctorOptions = {},
) => {
  const paths = resolvePaths({ appName: app.appName, prefix: app.envPrefix, env })
  const store = resolve(storePath(env))
  let oauth: { client: "wirecat" | "own" | null; error?: string } | undefined
  if (options.oauthClient)
    try {
      oauth = options.oauthClient(env)
    } catch (error) {
      oauth = { client: null, error: failure(error) }
    }
  const common = {
    version: app.version,
    runtime: { node: process.versions.node, platform: process.platform },
    paths: { config: paths.config, state: paths.state, cache: paths.cache },
    store: { path: store, exists: existsSync(store) },
    ...(oauth ? { oauth_client: oauth } : {}),
    read_only: readOnlyLockOf(app, env) ?? null,
    profile_lock: env[envName(app, "PROFILE_LOCK")]?.trim() || null,
  }
  try {
    const settings = configuration.resolveSettings({}, { env, readOnly: true, needsProfile: false, withIssues: true })
    const { files, fixes } = configFiles(settings.configPath)
    return {
      report: {
        ...common,
        config: {
          path: settings.configPath,
          found: settings.configFound,
          issues: [
            ...(settings.configIssues ?? []),
            ...unknownPermissionIssues(command, settings, app.command, configuration.permissions),
          ],
        },
        profiles: settings.configuredProfiles,
        files,
      },
      fixes,
    }
  } catch (error) {
    const file = configFilePath(paths.config)
    const { files, fixes } = configFiles(file)
    return {
      report: {
        ...common,
        config: { path: file, found: existsSync(file), issues: [] },
        settings: { error: failure(error) },
        profiles: null,
        files,
      },
      fixes,
    }
  }
}

/** `doctor` for a CLI that is not a messenger: gcal, drive, zoom. A messenger's is `doctorCommand(messenger)`. */
export const appDoctorCommand = (app: AppIdentity, configuration: Configuration, options: AppDoctorOptions = {}) =>
  profileFree(
    annotate(new Command("doctor"), {
      effects: LOCAL_READ,
      examples: [`${app.command} doctor`, `${app.command} doctor --json`],
    }),
  )
    .description("check this installation: version, paths, config, profiles, store; no keyring or network")
    .action(function (this: Command) {
      const env = environmentOf(this).env ?? process.env
      const { report, fixes } = appDoctorReport(app, configuration, env, this, options)
      const output = outputFor(this)
      renderAnswer(this, output, itemOf(report))
      for (const fix of fixes) output.renderer.note(`to make it private: ${fix}`)
    })
