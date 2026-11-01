import { existsSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { CliError, configFilePath, resolvePaths } from "@wirecat/cli-base"
import { annotate } from "@wirecat/cli-base/commands"
import type { FetchLike } from "@wirecat/cli-base/http"
import { isNewer, latestVersion } from "@wirecat/cli-base/update"
import { Command } from "commander"
import { type AppIdentity, envName, readOnlyLockOf } from "../ports/app.js"
import { storePath } from "../store/path.js"
import { type BaseEnvironment, environmentOf, outputFor } from "./context.js"
import { DOCTOR_ONLINE_OPTION, DOCTOR_SUMMARY } from "./doctor-text.js"
import { REMOTE_READ } from "./effects.js"
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
  /** The npm package, so `--online` can say whether a newer version is published; without it that check is left out. */
  packageName?: string
  /**
   * What `--online` checks of the service: a login, a folder read. Its fields join the `online` answer, and `ok: false`
   * (or a throw, reported as `error_code` and `error`) makes the whole check fail without failing the command.
   */
  online?: (env: NodeJS.ProcessEnv) => Promise<{ ok: boolean } & Record<string, unknown>>
  /**
   * What the CLI reads of its own state from disk, with no call out: a run left half done, a deadline near. `fields`
   * join the answer; each of `notes` goes to stderr, as a fix does. A throw is reported as `local.error`.
   */
  local?: (env: NodeJS.ProcessEnv) => { fields: Record<string, unknown>; notes?: string[] }
}

const localCheck = (env: NodeJS.ProcessEnv, options: AppDoctorOptions) => {
  if (!options.local) return { fields: {}, notes: [] }
  try {
    const { fields, notes = [] } = options.local(env)
    return { fields, notes }
  } catch (error) {
    return { fields: { local: { error: error instanceof Error ? error.message : String(error) } }, notes: [] }
  }
}

const onlineCheck = async (app: AppIdentity, env: NodeJS.ProcessEnv, fetcher: FetchLike, options: AppDoctorOptions) => {
  const started = Date.now()
  let service: Record<string, unknown> = { ok: true }
  if (options.online)
    try {
      service = await options.online(env)
    } catch (error) {
      service = {
        ok: false,
        error_code: error instanceof CliError ? error.code : "generic_failure",
        error: error instanceof Error ? error.message : String(error),
      }
    }
  const latest = options.packageName
    ? await latestVersion(options.packageName, fetcher, { timeoutMs: 3000 })
    : undefined
  return {
    ...service,
    duration_ms: Date.now() - started,
    ...(options.packageName
      ? {
          version: {
            current: app.version,
            latest: latest ?? null,
            newer: latest !== undefined && isNewer(latest, app.version),
          },
        }
      : {}),
  }
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

/**
 * `doctor` for a CLI that is not a messenger: gcal, drive, zoom. A messenger's is `doctorCommand(messenger)`, and both
 * say the same thing: the state from disk, and only with `--online` a call out. Here that call is `options.online`
 * and, with `options.packageName`, whether npm has a newer version.
 */
export const appDoctorCommand = (app: AppIdentity, configuration: Configuration, options: AppDoctorOptions = {}) =>
  profileFree(
    annotate(new Command("doctor"), {
      effects: REMOTE_READ,
      examples: [`${app.command} doctor`, `${app.command} doctor --json`],
    }),
  )
    .description(DOCTOR_SUMMARY)
    .option("--online", DOCTOR_ONLINE_OPTION)
    .action(async function (this: Command) {
      const environment = environmentOf<BaseEnvironment & { fetch?: FetchLike }>(this)
      const env = environment.env ?? process.env
      const { report, fixes } = appDoctorReport(app, configuration, env, this, options)
      const local = localCheck(env, options)
      const online = this.opts<{ online?: boolean }>().online
        ? await onlineCheck(app, env, environment.fetch ?? fetch, options)
        : undefined
      const output = outputFor(this)
      renderAnswer(this, output, itemOf({ ...report, ...local.fields, ...(online ? { online } : {}) }))
      for (const fix of fixes) output.renderer.note(`to make it private: ${fix}`)
      for (const note of local.notes) output.renderer.note(note)
    })
