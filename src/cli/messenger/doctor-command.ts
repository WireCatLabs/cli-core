import { existsSync } from "node:fs"
import { dirname } from "node:path"
import { configFilePath, resolvePaths } from "@wirecat/cli-base"
import { annotate } from "@wirecat/cli-base/commands"
import { Command } from "commander"
import { engineStates } from "../../attachments/extract.js"
import type { AccountStanding, MessengerAdapter } from "../../ports/messenger.js"
import { providerErrorKey } from "../../runs/events.js"
import { type ProviderWarnings, providerLogPathFor, providerWarnings } from "../../runs/provider-log.js"
import { listRuns, runsDirFor, runtime } from "../../runs/run.js"
import { FloodMemory, floodPathFor } from "../../sends/flood.js"
import { SendJournal, sendsPathFor } from "../../sends/journal.js"
import { storePath } from "../../store/path.js"
import { type BaseContext, baseContext, environmentOf, outputFor } from "../context.js"
import { doctorReportsCommand } from "../doctor-reports-command.js"
import { DOCTOR_ONLINE_OPTION, DOCTOR_SUMMARY } from "../doctor-text.js"
import { REMOTE_READ } from "../effects.js"
import { itemOf, renderAnswer, snakeKeys } from "../envelope.js"
import { unknownPermissionIssues } from "../permission-keys.js"
import { NONE_NAMED } from "../settings.js"
import { nextStep } from "../steps.js"
import { recalledAccount } from "./accounts.js"
import { type Messenger, messengerContext } from "./context.js"
import { type PrivateFiles, privateFiles, withSqliteSidecars } from "./private-files.js"
import { DAY_MS } from "./serve-members.js"
import { storeSummary } from "./store-maintenance-command.js"

/**
 * The state this installation is in, read from disk and **never from the messenger unless
 * `--online`**. ⚠ It must answer when everything is broken, because that is when anybody runs it:
 * a configuration that will not load, a store written by a newer version, a keyring that will not
 * open — each is a field in the answer, never an exception.
 */
export const doctorCommand = (messenger: Messenger): Command => {
  const command = annotate(new Command("doctor"), { effects: REMOTE_READ })
    .description(DOCTOR_SUMMARY)
    .option("--online", DOCTOR_ONLINE_OPTION)
    .action(async function (this: Command) {
      const { online } = this.opts<{ online?: boolean }>()
      const { report, renderer, fixes = [] } = await diagnose(this, messenger)
      if (online && renderer) {
        const checked = await onlineCheck(this, messenger, rememberedOf(report))
        report.online = checked
        report.login = { state: checked.ok ? "ok" : "failed" }
        const flood = report.flood as { path: string } | undefined
        if (flood) report.flood = floodState(followStanding(new FloodMemory(flood.path), checked.standing))
      }
      const output = outputFor(this)
      const unchecked = (report.login as { state?: string } | undefined)?.state === "not checked"
      renderAnswer(
        this,
        { ...output, ...(renderer ? { renderer } : {}) },
        itemOf(report, { next: unchecked ? [nextStep("doctor.online", { args: { online: true } })] : [] }),
      )
      for (const fix of fixes) (renderer ?? output.renderer).note(`to make it private: ${fix}`)
      for (const line of damageNotes(report.store)) (renderer ?? output.renderer).note(line)
    })
  command.addCommand(reportCommand(messenger))
  return command
}

export const DOCTOR_DEEP_OPTION =
  "also read every page of the store and check every search index (about 30 s for 6 GB); without it, only the file header and schema"

/** The shared doctor stays quick; `store recover` is its deep check, and a CLI may add `--deep` to its own doctor. */
const summaryOptions = (command: Command, app: { command: string; version: string }) => ({
  deep: command.opts<{ deep?: boolean }>().deep === true,
  command: app.command,
  version: app.version,
})

/** The plain-words account of a damaged store, under the answer. */
export const damageNotes = (store: unknown): string[] => {
  const { damage, damage_mark_cleared: cleared } =
    (store as
      | {
          damage?: { what_happened: string; external_data_safe: string; steps: { command: string }[] }
          damage_mark_cleared?: { at: string; command: string }
        }
      | undefined) ?? {}
  return [
    ...(cleared
      ? [
          `the deep check passed, so writes are allowed again: \`${cleared.command}\` had found the store damaged at ${cleared.at}`,
        ]
      : []),
    ...(damage
      ? [damage.what_happened, damage.external_data_safe, ...damage.steps.map(({ command }) => `next: ${command}`)]
      : []),
  ]
}

const INCLUDES = [
  "the version, the runtime and the operating system",
  "what `doctor` answers: paths with the home folder shown as ~, the store's schema and counts, the messenger's own checks",
  "the failed run — the newest, or the one named: each request's operation, duration and error code",
  "the last 20 send attempts: outcome and length",
  "every chat, message and account id replaced by a label that means nothing outside the file",
]
const EXCLUDES = ["message text", "chat titles", "names", "phone numbers", "the session", "the app credentials"]

const reportCommand = (messenger: Messenger): Command =>
  doctorReportsCommand({
    app: messenger.app,
    includes: INCLUDES,
    excludes: EXCLUDES,
    example: `${messenger.app.command} personal`,
    check: "no message text, and ids are labels",
    collect: async (command) => {
      const env = environmentOf(command).env ?? process.env
      const { report, renderer, profile } = await diagnose(command, messenger)
      return {
        doctor: report,
        sends: profile ? new SendJournal(sendsPathFor(messenger.app, profile, env)).entries() : [],
        ...(renderer ? { renderer } : {}),
      }
    },
  })

const rememberedOf = (report: Record<string, unknown>) =>
  (report.account as { remembered?: string | null } | undefined)?.remembered ?? undefined

/**
 * What `doctor` answers, as data. A configuration that will not load is a field, not an exception:
 * then there is no renderer from the settings, and the caller renders with the defaults.
 */
const providerLogState = ({ path, total, kinds }: ProviderWarnings) => ({ path, last_day: { total, kinds } })

const diagnose = async (
  command: Command,
  messenger: Messenger,
): Promise<{
  report: Record<string, unknown>
  renderer?: BaseContext["renderer"]
  profile?: string
  /** The shell line that makes each file private: for a person, not a step this CLI can run. */
  fixes?: string[]
}> => {
  const { app, provider } = messenger
  const env = environmentOf(command).env ?? process.env
  const cli = {
    command: app.command,
    version: app.version,
    runtime: runtime(),
    platform: process.platform,
    arch: process.arch,
  }

  // Every problem in the file is reported, not refused: doctor is what a person runs when nothing else will.
  let context: BaseContext
  try {
    context = baseContext(command, (flags, options) =>
      messenger.resolveSettings(flags, { ...options, needsProfile: false, readOnly: true, withIssues: true }),
    )
  } catch (error) {
    // Not the file: a profile lock, a flag or an environment variable the settings refuse.
    const path = configFilePath(resolvePaths({ appName: app.appName, prefix: app.envPrefix, env }).config)
    const files = privateFiles(configFiles(path))
    return {
      fixes: fixesOf(files),
      report: {
        cli,
        config: { path, found: existsSync(path), issues: [] },
        settings: { error: messageOf(error) },
        store: snakeKeys(await storeSummary(env, summaryOptions(command, app))),
        runs: { directory: runsDirFor(app, env), kept: listRuns(runsDirFor(app, env)).length },
        files: filesReport(files),
      },
    }
  }
  const { settings, renderer } = context
  const config = {
    path: settings.configPath,
    found: settings.configFound,
    issues: [
      ...(settings.configIssues ?? []),
      ...unknownPermissionIssues(command, settings, app.command, messenger.permissionKey),
    ],
  }
  const own = configFiles(settings.configPath)
  if (settings.sources.profile === NONE_NAMED) {
    const files = privateFiles(own)
    return {
      renderer,
      fixes: fixesOf(files),
      report: {
        cli,
        profile: null,
        config,
        store: snakeKeys(await storeSummary(env, summaryOptions(command, app))),
        readers: engineStates(),
        runs: { directory: runsDirFor(app, env), kept: listRuns(runsDirFor(app, env)).length },
        files: filesReport(files),
      },
    }
  }
  const { profile } = settings
  const account = recalledAccount(app, provider, profile, env)
  const store = storePath(env)
  const sends = sendsPathFor(app, profile, env)
  const flood = floodPathFor(app, profile, env)
  const providerLog = providerLogPathFor(app, profile, env)
  const files = privateFiles({
    files: [...own.files, ...withSqliteSidecars(store), sends, flood, providerLog],
    // A folder the owner chose with MESSAGING_STORE may rightly be shared, like the home folder itself.
    dirs: [
      ...own.dirs,
      ...(env.MESSAGING_STORE ? [] : [dirname(store)]),
      dirname(sends),
      dirname(flood),
      runsDirFor(app, env),
      dirname(providerLog),
    ],
  })

  return {
    renderer,
    profile,
    fixes: fixesOf(files),
    report: {
      cli,
      profile,
      config,
      account: { remembered: account?.account ?? null },
      // A session file on disk says nothing about whether the messenger still accepts it.
      login: { state: "not checked" },
      store: snakeKeys(await storeSummary(env, summaryOptions(command, app))),
      readers: engineStates(),
      sends: sendsState(new SendJournal(sendsPathFor(app, profile, env))),
      flood: floodState(new FloodMemory(flood)),
      provider_log: providerLogState(providerWarnings(providerLog, new Date(Date.now() - DAY_MS))),
      runs: { directory: runsDirFor(app, env), kept: listRuns(runsDirFor(app, env)).length },
      // The messenger's own block keeps the keys it gives: some of them are file paths.
      files: filesReport(files),
      [provider]: await (messenger.diagnose?.(command, context) ?? Promise.resolve({})).catch((error) => ({
        error: messageOf(error),
      })),
    },
  }
}

/**
 * The config folder is checked even when `<APP>_CONFIG_DIR` names it: it is the tool's own folder, and the
 * credential file falls back to it when there is no keyring.
 */
const configFiles = (path: string) => ({ files: [path], dirs: [dirname(path)] })

const fixesOf = (files: PrivateFiles) => (files.checked ? files.problems.map((problem) => problem.fix) : [])

const filesReport = (files: PrivateFiles) =>
  files.checked ? { ...files, problems: files.problems.map(({ path, mode, want }) => ({ path, mode, want })) } : files

/** What the messenger asked this profile to wait for, still in force — what the next command would be refused. */
export const floodState = (memory: FloodMemory) => {
  const { deadlines, sendBlock } = memory.read()
  return { path: memory.path, deadlines: snakeKeys(deadlines), send_block: snakeKeys(sendBlock ?? null) }
}

/**
 * A frozen or banned account seen here holds writes as a refused one would; one seen active lifts
 * either hold. A spam limit is never lifted here: the messenger does not say when one ends.
 */
const followStanding = (memory: FloodMemory, standing: { state: string; until?: string; hint?: string }) => {
  try {
    if (standing.state === "frozen" || standing.state === "banned") {
      memory.block({
        state: standing.state,
        hint: standing.hint ?? `the account is ${standing.state}`,
        ...(standing.until ? { until: standing.until } : {}),
      })
    } else if (standing.state === "active") {
      memory.unblock("frozen")
      memory.unblock("banned")
    }
  } catch {}
  return memory
}

const sendsState = (journal: SendJournal) => {
  const entries = journal.entries()
  const hourAgo = Date.now() - 60 * 60 * 1000
  return {
    attempts: entries.length,
    last_hour: entries.filter((entry) => Date.parse(entry.at) > hourAgo).length,
  }
}

/**
 * MTProto (Telegram) refuses a request stamped more than 30 s ahead of its clock or 300 s behind it
 * (core.telegram.org/mtproto/description). A client library may correct its own offset, but times
 * this tool computes — `--at-time`, `--since-time` — would still be off, so warn well inside the
 * tighter limit and well above what one whole-second reading over a round trip can measure.
 */
export const CLOCK_SKEW_WARN_MS = 10_000

const STANDINGS = new Set<AccountStanding["state"]>(["frozen", "limited", "banned", "deactivated", "revoked"])

const standingOf = (error: unknown): AccountStanding | undefined => {
  const standing = (error as { details?: { standing?: AccountStanding } })?.details?.standing
  return standing && STANDINGS.has(standing.state) ? standing : undefined
}

interface Health {
  clock: { skewMs: number; uncertaintyMs: number; ok: boolean; warnAboveMs: number } | null
  /** A messenger without `health` has no restriction a login would not show. */
  standingChecked: boolean
  standing?: AccountStanding
  healthError?: string
}

const healthOf = async (connection: MessengerAdapter): Promise<Health> => {
  if (!connection.health) return { clock: null, standingChecked: true }
  const sent = Date.now()
  try {
    const { serverTime, serverTimeResolutionMs = 0, standing, standingChecked } = await connection.health()
    const received = Date.now()
    const skewMs = serverTime === undefined ? undefined : Math.round((sent + received) / 2 - serverTime)
    return {
      clock:
        skewMs === undefined
          ? null
          : {
              skewMs,
              uncertaintyMs: Math.ceil(serverTimeResolutionMs + (received - sent) / 2),
              ok: Math.abs(skewMs) < CLOCK_SKEW_WARN_MS,
              warnAboveMs: CLOCK_SKEW_WARN_MS,
            },
      standingChecked,
      ...(standing ? { standing } : {}),
    }
  } catch (error) {
    const standing = standingOf(error)
    return { clock: null, standingChecked: false, healthError: codeOf(error), ...(standing ? { standing } : {}) }
  }
}

/**
 * Never throws: each step fails into a field. The clock is read before the login, so a refused login
 * still says whether this machine's time is right.
 */
const onlineCheck = async (command: Command, messenger: Messenger, remembered: string | undefined) => {
  const started = Date.now()
  const read: { health: Health } = { health: { clock: null, standingChecked: false } }
  try {
    const me = await messengerContext(command, messenger).withMessenger(async (connection) => {
      read.health = await healthOf(connection)
      return connection.me()
    })
    const { health } = read
    const standing = health.standing
    return {
      ok: true,
      account: me.id,
      ...(remembered === undefined ? {} : { matches_remembered: me.id === remembered }),
      duration_ms: Date.now() - started,
      standing: snakeKeys(standing ?? { state: health.standingChecked ? "active" : "unknown" }) as {
        state: string
        until?: string
        hint?: string
      },
      clock: snakeKeys(health.clock),
      ...(health.healthError ? { health_error: health.healthError } : {}),
    }
  } catch (error) {
    const { health } = read
    const standing = standingOf(error) ?? health.standing
    const providerError = providerErrorKey(
      (error as { details?: { provider_error?: unknown } })?.details?.provider_error,
    )
    return {
      ok: false,
      error_code: codeOf(error),
      ...(providerError ? { provider_error: providerError } : {}),
      duration_ms: Date.now() - started,
      standing: snakeKeys(standing ?? { state: "unknown" }) as { state: string; until?: string; hint?: string },
      clock: snakeKeys(health.clock),
      error: messageOf(error),
    }
  }
}

const codeOf = (error: unknown): string => {
  const code = (error as { code?: unknown })?.code
  return typeof code === "string" ? code : "generic_failure"
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))
