import { dirname, resolve } from "node:path"
import { writeSecurely } from "@wirecat/cli-base"
import { Command } from "commander"
import { engineStates } from "../../attachments/extract.js"
import { FloodMemory, floodPathFor } from "../../sends/flood.js"
import { SendJournal, sendsPathFor } from "../../sends/journal.js"
import { storePath } from "../../store/path.js"
import { type BaseContext, baseContext, environmentOf, outputFor } from "../context.js"
import { providerErrorKey } from "../runs/events.js"
import { listRuns, runsDirFor, runtime } from "../runs/run.js"
import { recalledAccount } from "./accounts.js"
import { type Messenger, messengerContext } from "./context.js"
import type { AccountStanding, MessengerAdapter } from "./port.js"
import { privateFiles, withSqliteSidecars } from "./private-files.js"
import { buildReport, reportFileName } from "./report.js"
import { storeSummary } from "./store-maintenance-command.js"

/**
 * The state this installation is in, read from disk and **never from the messenger unless
 * `--online`**. ⚠ It must answer when everything is broken, because that is when anybody runs it:
 * a configuration that will not load, a store written by a newer version, a keyring that will not
 * open — each is a field in the answer, never an exception.
 */
export const doctorCommand = (messenger: Messenger): Command => {
  const command = new Command("doctor")
    .description("the state this installation is in, without connecting unless --online")
    .option("--online", "also connect once and read the account; sends nothing")
    .action(async function (this: Command) {
      const { online } = this.opts<{ online?: boolean }>()
      const { report, renderer } = await diagnose(this, messenger)
      if (online && renderer) {
        const checked = await onlineCheck(this, messenger, rememberedOf(report))
        report.online = checked
        report.login = { state: checked.ok ? "ok" : "failed", ...(checked.hint ? { hint: checked.hint } : {}) }
        const flood = report.flood as { path: string } | undefined
        if (flood) report.flood = floodState(followStanding(new FloodMemory(flood.path), checked.standing))
      }
      ;(renderer ?? outputFor(this).renderer).result(report)
    })
  command.addCommand(reportCommand(messenger))
  return command
}

const INCLUDES = [
  "the version, the runtime and the operating system",
  "what `doctor` answers: paths with the home folder shown as ~, the store's schema and counts, the messenger's own checks",
  "the failed run — the newest, or the one named: each request's operation, duration and error code",
  "the last 20 send attempts: outcome and length",
  "every chat, message and account id replaced by a label that means nothing outside the file",
]
const EXCLUDES = ["message text", "chat titles", "names", "phone numbers", "the session", "the app credentials"]

const reportCommand = (messenger: Messenger): Command => {
  const { app } = messenger
  const report = new Command("report").description("what a problem report holds; writes nothing").action(function (
    this: Command,
  ) {
    const { renderer, format, streams } = outputFor(this)
    const create = `${app.command} doctor report create`
    if (format !== "pretty") {
      renderer.result({ includes: INCLUDES, excludes: EXCLUDES, create, ...(app.issues ? { sendTo: app.issues } : {}) })
      return
    }
    streams.data(
      [
        `A problem report is one file for the author of ${app.command}.`,
        "",
        "It holds:",
        ...INCLUDES.map((line) => `- ${line}`),
        "",
        `It never holds: ${EXCLUDES.join(", ")}.`,
        "",
        `Create one:          ${create}`,
        `About a given run:   ${create} --run <id>   (ids: ${app.command} runs list)`,
      ].join("\n"),
    )
  })

  report
    .command("create")
    .description("write a problem report to a file, and say where to send it")
    .option("--run <id>", "the run the report is about; the newest failed one if not given")
    .option("--output <file>", "where to write it; a new file in this directory if not given")
    .action(async function (this: Command) {
      const options = this.opts<{ run?: string; output?: string }>()
      const env = environmentOf(this).env ?? process.env
      const { report: doctor, renderer, profile } = await diagnose(this, messenger)
      const now = new Date()
      const built = buildReport({
        doctor,
        runsDir: runsDirFor(app, env),
        command: app.command,
        sends: profile ? new SendJournal(sendsPathFor(app, profile, env)).entries() : [],
        now,
        home: env.HOME ?? env.USERPROFILE,
        ...(options.run === undefined ? {} : { runId: options.run }),
      })
      const path = resolve(options.output ?? reportFileName(app.command, now))
      writeSecurely(path, `${JSON.stringify(built, null, 2)}\n`, 0o600)
      const out = renderer ?? outputFor(this).renderer
      out.result({ path, run: built.run?.metadata.runId ?? null, ...(app.issues ? { sendTo: app.issues } : {}) })
      if (!built.run) {
        out.note("no failed run is recorded — run the failing command again, and the failure is kept by itself")
      }
      out.note(
        `read it before sending: no message text, and ids are labels${app.issues ? ` — attach it to a new issue at ${app.issues}` : ""}`,
      )
    })

  return report
}

const rememberedOf = (report: Record<string, unknown>) =>
  (report.account as { remembered?: string | null } | undefined)?.remembered ?? undefined

/**
 * What `doctor` answers, as data. A configuration that will not load is a field, not an exception:
 * then there is no renderer from the settings, and the caller renders with the defaults.
 */
const diagnose = async (
  command: Command,
  messenger: Messenger,
): Promise<{ report: Record<string, unknown>; renderer?: BaseContext["renderer"]; profile?: string }> => {
  const { app, provider } = messenger
  const env = environmentOf(command).env ?? process.env
  const cli = {
    command: app.command,
    version: app.version,
    runtime: runtime(),
    platform: process.platform,
    arch: process.arch,
  }

  let context: BaseContext
  try {
    context = baseContext(command, messenger.resolveSettings)
  } catch (error) {
    return { report: { cli, config: { error: messageOf(error) } } }
  }
  const { settings, renderer } = context
  const { profile } = settings
  const account = recalledAccount(app, provider, profile, env)
  const store = storePath(env)
  const sends = sendsPathFor(app, profile, env)
  const flood = floodPathFor(app, profile, env)

  return {
    renderer,
    profile,
    report: {
      cli,
      profile,
      config: { path: settings.configPath, found: settings.configFound },
      account: { remembered: account?.account ?? null },
      // A session file on disk says nothing about whether the messenger still accepts it.
      login: {
        state: "not checked",
        hint: `\`${app.command} doctor --online\` logs in once and checks it; it sends nothing`,
      },
      store: await storeSummary(env),
      readers: engineStates(),
      sends: sendsState(new SendJournal(sendsPathFor(app, profile, env))),
      flood: floodState(new FloodMemory(flood)),
      runs: { directory: runsDirFor(app, env), kept: listRuns(runsDirFor(app, env)).length },
      files: privateFiles({
        files: [...withSqliteSidecars(store), sends, flood],
        // A folder the owner chose with MESSAGING_STORE may rightly be shared, like the home folder itself.
        dirs: [...(env.MESSAGING_STORE ? [] : [dirname(store)]), dirname(sends), dirname(flood), runsDirFor(app, env)],
      }),
      [provider]: await (messenger.diagnose?.(command, context) ?? Promise.resolve({})).catch((error) => ({
        error: messageOf(error),
      })),
    },
  }
}

/** What the messenger asked this profile to wait for, still in force — what the next command would be refused. */
export const floodState = (memory: FloodMemory) => {
  const { deadlines, sendBlock } = memory.read()
  return { path: memory.path, deadlines, sendBlock: sendBlock ?? null }
}

/**
 * A frozen account seen here holds writes as a refused one would; one seen active lifts a frozen
 * hold. A spam limit is never lifted here: the messenger does not say when one ends.
 */
const followStanding = (memory: FloodMemory, standing: { state: string; until?: string; hint?: string }) => {
  try {
    if (standing.state === "frozen") {
      memory.block({
        state: "frozen",
        hint: standing.hint ?? "the account is frozen",
        ...(standing.until ? { until: standing.until } : {}),
      })
    } else if (standing.state === "active") memory.unblock("frozen")
  } catch {}
  return memory
}

const sendsState = (journal: SendJournal) => {
  const entries = journal.entries()
  const hourAgo = Date.now() - 60 * 60 * 1000
  return {
    attempts: entries.length,
    lastHour: entries.filter((entry) => Date.parse(entry.at) > hourAgo).length,
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
      ...(remembered === undefined ? {} : { matchesRemembered: me.id === remembered }),
      durationMs: Date.now() - started,
      standing: standing ?? { state: health.standingChecked ? "active" : "unknown" },
      clock: health.clock,
      ...(health.healthError ? { healthError: health.healthError } : {}),
      ...(standing?.hint ? { hint: standing.hint } : {}),
    }
  } catch (error) {
    const { health } = read
    const standing = standingOf(error) ?? health.standing
    const providerError = providerErrorKey((error as { details?: { providerError?: unknown } })?.details?.providerError)
    return {
      ok: false,
      errorCode: codeOf(error),
      ...(providerError ? { providerError } : {}),
      durationMs: Date.now() - started,
      standing: standing ?? { state: "unknown" },
      clock: health.clock,
      hint: standing?.hint ?? messageOf(error),
    }
  }
}

const codeOf = (error: unknown): string => {
  const code = (error as { code?: unknown })?.code
  return typeof code === "string" ? code : "generic_failure"
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))
