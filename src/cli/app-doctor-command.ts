import { existsSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { CliError, configFilePath, resolvePaths, writeSecurely } from "@wirecat/cli-base"
import { annotate } from "@wirecat/cli-base/commands"
import { type FetchLike, hostFetch } from "@wirecat/cli-base/http"
import { timezoneOf } from "@wirecat/cli-base/query"
import { clockMeta } from "@wirecat/cli-base/standards"
import { isNewer, latestVersion } from "@wirecat/cli-base/update"
import { Command } from "commander"
import type { OAuthClientReport } from "../constants/index.js"
import { type AppIdentity, envName, readOnlyLockOf } from "../ports/app.js"
import { runsDirFor } from "../runs/run.js"
import { storePath } from "../store/path.js"
import { type BaseEnvironment, environmentOf, inCommandRun, outputFor } from "./context.js"
import { DOCTOR_ONLINE_OPTION, DOCTOR_SUMMARY } from "./doctor-text.js"
import { destroysNothing, LOCAL_WRITE, NO_EFFECTS, REMOTE_READ } from "./effects.js"
import { itemOf, renderAnswer } from "./envelope.js"
import { privateFiles } from "./messenger/private-files.js"
import { buildReport, reportFileName } from "./messenger/report.js"
import { unknownPermissionIssues } from "./permission-keys.js"
import { profileFree, rootOf } from "./profile.js"
import type { Configuration } from "./settings.js"
import { lineOf, nextStep } from "./steps.js"

export interface AppDoctorOptions {
  /**
   * The OAuth app a new sign-in would use (WC-SECR-25), read from the environment and files only, usually
   * `oauthClientReport` of the tool's `googleApp`/`oauthApp`. A throw is reported as a null client with its message as
   * the reason.
   */
  oauthClient?: (env: NodeJS.ProcessEnv) => OAuthClientReport
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
  let oauth: OAuthClientReport | undefined
  if (options.oauthClient)
    try {
      oauth = options.oauthClient(env)
    } catch (error) {
      oauth = { client: null, source: null, reason: failure(error) }
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
      const answer = async () => {
        const online = this.opts<{ online?: boolean }>().online
          ? await onlineCheck(app, env, environment.fetch ?? hostFetch({ hosts: ["registry.npmjs.org"] }), options)
          : undefined
        const output = outputFor(this)
        renderAnswer(
          this,
          output,
          itemOf(
            { ...report, ...local.fields, ...(online ? { online } : {}) },
            { meta: clockMeta(Date.now(), timezoneOf()) },
          ),
        )
        for (const fix of fixes) output.renderer.note(`to make it private: ${fix}`)
        for (const note of local.notes) output.renderer.note(note)
      }
      // A call out is recorded and ended by `--timeout` as any other command's; a config that will not load opens no
      // run, and doctor still answers.
      if (this.opts<{ online?: boolean }>().online && !("settings" in report)) await inCommandRun(this, answer)
      else await answer()
    })
    .addCommand(reportsCommand(app, configuration, options))

const INCLUDES = [
  "the version, the runtime and the operating system",
  "what `doctor` answers: paths with the home folder shown as ~, the store's path, the config's problems, the locks",
  "the failed run — the newest, or the one named: each request's operation, duration and error code",
  "every id replaced by a label that means nothing outside the file",
]
const EXCLUDES = ["what the tool reads or writes", "names", "e-mail addresses", "phone numbers", "the sign-in"]

/** `doctor reports`: one file for the author, as a messenger's `doctor reports` writes it, without the send journal. */
const reportsCommand = (app: AppIdentity, configuration: Configuration, options: AppDoctorOptions): Command => {
  const reports = new Command("reports").description("problem reports")
  annotate(reports.command("show"), { effects: NO_EFFECTS, examples: [`${app.command} doctor reports show`] })
    .description("what a problem report holds; writes nothing")
    .action(function (this: Command) {
      const create = lineOf(this, "doctor reports create")
      renderAnswer(
        this,
        outputFor(this),
        itemOf(
          { includes: INCLUDES, excludes: EXCLUDES, ...(app.issues ? { send_to: app.issues } : {}) },
          { next: [nextStep("doctor.report-create", { args: {} })] },
        ),
        () =>
          [
            `A problem report is one file for the author of ${app.command}.`,
            "",
            "It holds:",
            ...INCLUDES.map((line) => `- ${line}`),
            "",
            `It never holds: ${EXCLUDES.join(", ")}.`,
            "",
            `Create one:          ${create}`,
            `About a given run:   ${create} --run <id>   (ids: ${lineOf(this, "runs list")})`,
          ].join("\n"),
      )
    })
  destroysNothing(
    annotate(reports.command("create"), {
      effects: LOCAL_WRITE,
      examples: [`${app.command} doctor reports create --output ./problem-report.json`],
    }),
  )
    .description("write a problem report to a file, and say where to send it")
    .option("--run <id>", "the run the report is about; the newest failed one if not given")
    .option("--output <file>", "where to write it; a new file in this directory if not given")
    .action(function (this: Command) {
      const given = this.opts<{ run?: string; output?: string }>()
      const env = environmentOf(this).env ?? process.env
      const now = new Date()
      const built = buildReport({
        doctor: appDoctorReport(app, configuration, env, this, options).report,
        runsDir: runsDirFor(app, env),
        command: app.command,
        sends: [],
        now,
        home: env.HOME ?? env.USERPROFILE,
        program: rootOf(this),
        ...(given.run === undefined ? {} : { runId: given.run }),
      })
      const path = resolve(given.output ?? reportFileName(app.command, now))
      writeSecurely(path, `${JSON.stringify(built, null, 2)}\n`, 0o600)
      const output = outputFor(this)
      renderAnswer(
        this,
        output,
        itemOf({ path, run: built.run?.metadata.runId ?? null, ...(app.issues ? { send_to: app.issues } : {}) }),
      )
      if (!built.run)
        output.renderer.note(
          "no failed run is recorded — run the failing command again, and the failure is kept by itself",
        )
      output.renderer.note(
        `read it before sending: ids are labels${app.issues ? ` — attach it to a new issue at ${app.issues}` : ""}`,
      )
    })
  return reports
}
