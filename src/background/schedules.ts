import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { basename, join } from "node:path"
import { CliError, errorCodes, writeSecurely } from "@wirecat/cli-base"
import { linkConfigOf, linkFor } from "../domain/links.js"
import { type AppIdentity, mailHolderVariable, readOnlyLockOf } from "../ports/app.js"
import { recordLogFor } from "../runs/record-log.js"
import { childTrace } from "../runs/scope.js"
import { storePath } from "../store/path.js"
import { readSharedSection, sharedConfigPath } from "../store/shared-config.js"
import { type Delivery, deliver, type Parcel } from "./deliver.js"
import { causeOf, gapsView, noticeView, weeklyGapsOf } from "./report/messages.js"
import {
  type PreparedMessage,
  prepareMessage,
  prepareReport,
  type ReportRun,
  type StoredTemplates,
} from "./report/render.js"
import type { ServerSystem } from "./system.js"
import type { Timer } from "./timers.js"
import type { When } from "./when.js"

export { launchdTimer, systemdTimer, type Timer, timerFor, windowsTimer } from "./timers.js"
export {
  type CalendarWhen,
  calendarOf,
  describeWhen,
  isCalendar,
  nextRun,
  previousRun,
  runsBetween,
  type Slot,
  slotsOf,
  WEEKDAYS,
  type Weekday,
  type When,
} from "./when.js"

export interface Schedule {
  name: string
  kind: "command" | "agent"
  /** What runs: for a command the CLI's own words after its name, for an agent the harness and its arguments. */
  argv: string[]
  when: When
  /** The variables the run gets on top of the timer's: the profile, where the files are, PATH. Never a credential. */
  environment: Record<string, string>
  createdAt: string
  /** A holder whose mark gates the run: it starts only when mail is stored past that mark. */
  onNewMail?: string
  /** Gated on mail: start once the oldest waiting email has waited this many minutes, or `mailBatch` emails wait. */
  mailWaitMinutes?: number
  mailBatch?: number
  /** An agent's: no run starts for the rest of the local day once its runs cost this much, in US dollars. */
  maxCostPerDay?: number
  /** When a finished run shows a desktop notice and goes along `to`; absent means `notifyOf`'s default. */
  notify?: Notify
  /** `--deliver-to`'s routes (`telegram-bot:<profile>/<chat>`, `email:<profile>/<address>`), answered as `deliver_to`. */
  to?: string[]
  /** Kept with no timer: `schedule run` still runs it, and `schedule resume` puts the timer back. */
  paused?: true
}

export const NOTIFY_WHEN = ["always", "failures", "never"] as const
export type Notify = (typeof NOTIFY_WHEN)[number]

/** A repeating agent would otherwise notify on every tick; any other schedule runs rarely enough to say each result. */
export const notifyOf = (schedule: Pick<Schedule, "kind" | "when" | "notify">): Notify =>
  schedule.notify ?? (schedule.kind === "agent" && "every" in schedule.when ? "failures" : "always")

/** What a gated agent waits for, and what a day of its runs may cost, when neither its flags nor the config say. */
export const SCHEDULE_DEFAULTS = { mailWaitMinutes: 30, mailBatch: 10, maxCostPerDay: 5 } as const

/** One local day's cost of a schedule's runs, as the harness reported it (`spend.json` beside the schedule). */
export interface DaySpend {
  /** The local date, YYYY-MM-DD. */
  day: string
  usd: number
}

export const localDay = (at: Date): string =>
  `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`

const spendFile = (file: string) => join(file, "..", "spend.json")

/** What the schedule's runs cost today; nothing before its first priced run of the day. */
export const spentToday = (file: string, now = new Date()): number => {
  try {
    const spend = JSON.parse(readFileSync(spendFile(file), "utf8")) as DaySpend
    return spend.day === localDay(now) && typeof spend.usd === "number" ? spend.usd : 0
  } catch {
    return 0
  }
}

const addSpend = (folder: string, usd: number, at: Date) => {
  const file = join(folder, "schedule.json")
  const spend: DaySpend = { day: localDay(at), usd: spentToday(file, at) + usd }
  writeFileSync(spendFile(file), `${JSON.stringify(spend)}\n`, { mode: 0o600 })
}

/**
 * Claude reports a run's cost only in its JSON answer, so a scheduled claude run asks for it; the report kept is the
 * answer's text. Codex reports none.
 */
const priced = (argv: string[]): string[] => {
  const [program = ""] = argv
  const claude = /^claude(\.exe|\.cmd)?$/i.test(basename(program))
  return claude && argv.includes("-p") && !argv.includes("--output-format")
    ? [...argv, "--output-format", "json"]
    : argv
}

const reportOf = (stdout: Buffer): { text: Buffer; costUsd?: number } => {
  try {
    const answer = JSON.parse(stdout.toString("utf8")) as { type?: unknown; result?: unknown; total_cost_usd?: unknown }
    if (answer?.type !== "result") return { text: stdout }
    return {
      text: typeof answer.result === "string" ? Buffer.from(answer.result) : stdout,
      ...(typeof answer.total_cost_usd === "number" ? { costUsd: answer.total_cost_usd } : {}),
    }
  } catch {
    return { text: stdout }
  }
}

/**
 * What an agent is given on its stdin before its first turn: the host's own reads of what the run is about, so
 * the agent spends no model turns fetching them. Returns `undefined` when the schedule has none. `run` runs one
 * command of this CLI under the run's variables and answers its stdout.
 */
export type AgentInput = (schedule: Schedule, run: (argv: string[]) => Promise<string>) => Promise<string | undefined>

/** The most an agent's input may hold; a longer one is cut, so a mailbox in flood cannot grow every turn's context. */
export const AGENT_INPUT_MAX_CHARS = 60_000

const capped = (input: string): string =>
  input.length <= AGENT_INPUT_MAX_CHARS
    ? input
    : `${input.slice(0, AGENT_INPUT_MAX_CHARS)}\n\n[input cut at ${AGENT_INPUT_MAX_CHARS} characters; the rest waits for the next run]\n`

/** Another CLI a scheduled agent may run by name, as the host declares it: `memo`'s agent runs `mail`. */
export type AgentCli = Pick<AppIdentity, "command" | "appName" | "envPrefix">

export interface LastRun {
  at: string
  exitCode: number
  /** The run's output file: an agent's report, a command's log. */
  output: string
  /** Shared by every command the run started (`TRACEPARENT`), so `runs list` names them. */
  traceId?: string
  /** Why a failed run failed, in one line: the error's code and reason id, never its message. */
  reason?: string
  /** The `code` of the error the run printed, as run records keep it. */
  errorCode?: string
  /** How long the CLI asked to wait before it is tried again (`retry.after_ms` of a `rate_limited` error). */
  retryAfterMs?: number
  /** The first failure of the failures in a row, so "failing since" survives every retry. */
  failingSince?: string
  /** Failed runs in a row; absent once a run succeeds. */
  failures?: number
  /** What the run cost, as the harness reported it; absent when it reports none. */
  costUsd?: number
  /** The SHA-256 of a mail-gated agent's input, so a timer can tell the next input is the same one. */
  inputHash?: string
  /** The last time the timer did not start it, and why; a run after it clears this. */
  skipped?: { at: string; why: string; reason?: SkipReason }
  /** How the result went along each of the schedule's routes; a failed delivery never fails the run. */
  deliveries?: Delivery[]
  /** An agent's answer that was a `wirecat.report/1` document: its language, leaks, and what went wrong. */
  report?: ReportRun
}

/** Why a timer left a run out, as an id a translation can key on; `why` stays the English sentence. */
export const SKIP_REASONS = {
  costDayCap: "cost.day-cap",
  mailNone: "mail.none-new",
  mailBelowThreshold: "mail.below-threshold",
  mailSameInput: "mail.same-input",
} as const
export type SkipReason = (typeof SKIP_REASONS)[keyof typeof SKIP_REASONS]

const REASON_ID = /^[a-z0-9][a-z0-9.-]{0,79}$/

/**
 * Why a failed run failed, from the error object the CLI printed last: its code and reason id. Never the
 * message, which can name a chat or a person; the run's log keeps that. Any other line is another program's
 * text and is not kept either.
 */
export const failureOf = (
  stderr: string,
  exitCode: number,
): { reason: string; errorCode?: string; retryAfterMs?: number } => {
  for (const line of stderr.split("\n").reverse()) {
    try {
      const { code, reason, retry } =
        (JSON.parse(line) as { error?: { code?: unknown; reason?: unknown; retry?: { after_ms?: unknown } } }).error ??
        {}
      if ((errorCodes as readonly unknown[]).includes(code) && typeof reason === "string" && REASON_ID.test(reason)) {
        const after = retry?.after_ms
        return {
          reason: `${code} (${reason})`,
          errorCode: code as string,
          ...(code === "rate_limited" && typeof after === "number" && after > 0 ? { retryAfterMs: after } : {}),
        }
      }
    } catch {}
  }
  return { reason: `exit ${exitCode}` }
}

/** The one-line reason `failureOf` keeps, for a timer that reads a run's stderr itself. */
export const reasonOf = (stderr: string, exitCode = 1): string => failureOf(stderr, exitCode).reason

const readRun = (path: string): LastRun | undefined => {
  try {
    return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as LastRun) : undefined
  } catch {
    return undefined
  }
}

/**
 * Writes one run's result to `path`, carrying the failure streak over from the run before. Any CLI's own
 * timer can call this, so `failingNotice` reads every tool's background runs the same way.
 */
export const recordRun = (
  path: string,
  run: {
    at: string
    exitCode: number
    output: string
    traceId?: string
    reason?: string
    errorCode?: string
    costUsd?: number
    inputHash?: string
  },
): LastRun => {
  const before = readRun(path)
  const { reason, errorCode, ...rest } = run
  const last: LastRun =
    run.exitCode === 0
      ? rest
      : {
          ...rest,
          ...(reason === undefined ? {} : { reason }),
          ...(errorCode === undefined ? {} : { errorCode }),
          failingSince: before?.exitCode ? (before.failingSince ?? before.at) : run.at,
          failures: before?.exitCode ? (before.failures ?? 1) + 1 : 1,
        }
  writeSecurely(path, `${JSON.stringify(last, null, 2)}\n`, 0o600)
  return last
}

const rewriteRun = (path: string, last: LastRun): LastRun => {
  writeSecurely(path, `${JSON.stringify(last, null, 2)}\n`, 0o600)
  return last
}

/** Notes on the last run that the timer left this one out, keeping that run's result. */
export const recordSkip = (file: string, why: string, reason: SkipReason, at = new Date()): void => {
  const path = join(file, "..", "last.json")
  const before = readRun(path)
  // A timer ticking every few minutes would rewrite the file for the same cause each time.
  if (!before || before.skipped?.reason === reason) return
  writeSecurely(
    path,
    `${JSON.stringify({ ...before, skipped: { at: at.toISOString(), why, reason } }, null, 2)}\n`,
    0o600,
  )
}

const shortTime = (iso: string) => {
  const at = new Date(iso)
  const two = (n: number) => String(n).padStart(2, "0")
  return `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())} ${two(at.getHours())}:${two(at.getMinutes())}`
}

/**
 * One stderr line per failing background job, or nothing: `tg: scheduled digest failing since … (3 runs):
 * <reason> — tg schedule list`. A status the owner has to ask for is how a broken timer goes unnoticed.
 */
export const failingNotice = (
  command: string,
  runs: readonly { job: string; last: LastRun | undefined }[],
  statusCommand: string,
): string | undefined => {
  const lines = runs.flatMap(({ job, last }) =>
    last && last.exitCode !== 0
      ? [
          `${command}: scheduled ${job} failing since ${shortTime(last.failingSince ?? last.at)} ` +
            `(${last.failures ?? 1} run${(last.failures ?? 1) === 1 ? "" : "s"})` +
            `${last.reason ? `: ${last.reason}` : ""} — ${statusCommand}`,
        ]
      : [],
  )
  return lines.length ? lines.join("\n") : undefined
}

const NAME = /^[a-z0-9][a-z0-9-]{0,39}$/

export const scheduleName = (name: string): string => {
  if (!NAME.test(name)) {
    throw new CliError("validation_error", `a schedule name is lowercase letters, digits and dashes — not "${name}"`)
  }
  return name
}

export const schedulesDir = (state: string) => join(state, "schedules")
export const scheduleFile = (state: string, name: string) => join(schedulesDir(state), name, "schedule.json")

export const readSchedule = (file: string): Schedule => {
  if (!existsSync(file)) throw new CliError("not_found", `no schedule at ${file}`)
  return JSON.parse(readFileSync(file, "utf8")) as Schedule
}

export const lastRun = (file: string): LastRun | undefined => readRun(join(file, "..", "last.json"))

/** The CLI's own schedules with their last runs, for `failingNotice`; a broken file is skipped, not thrown. */
export const scheduledRuns = (state: string): { job: string; last: LastRun | undefined }[] => {
  try {
    return listSchedules(state).map((schedule) => ({
      job: schedule.name,
      last: lastRun(scheduleFile(state, schedule.name)),
    }))
  } catch {
    return []
  }
}

export const listSchedules = (state: string, filter: Partial<Pick<Schedule, "name" | "kind">> = {}): Schedule[] =>
  existsSync(schedulesDir(state))
    ? readdirSync(schedulesDir(state))
        .map((name) => scheduleFile(state, name))
        .filter((file) => existsSync(file))
        .map(readSchedule)
        .filter(
          (schedule) =>
            (filter.name === undefined || schedule.name === filter.name) &&
            (filter.kind === undefined || schedule.kind === filter.kind),
        )
        .sort((a, b) => a.name.localeCompare(b.name))
    : []

/** The shared `links` settings; a config file that cannot be read keeps the default rather than stop a digest. */
export const sharedLinks = (env: NodeJS.ProcessEnv) => {
  try {
    return linkConfigOf(readSharedSection(sharedConfigPath(storePath(env), env), "links"))
  } catch {
    return linkConfigOf(undefined)
  }
}

/**
 * WireCat Desktop, while it runs, writes `<state>/schedules/desktop.json` with its pid and the schedules whose new
 * runs it announces itself; a marker whose pid is gone (a crash) announces nothing.
 */
const announcedByDesktop = (schedulesFolder: string, name: string): boolean => {
  try {
    const { pid, announces } = JSON.parse(readFileSync(join(schedulesFolder, "desktop.json"), "utf8")) as {
      pid?: unknown
      announces?: unknown
    }
    if (!Number.isInteger(pid) || !Array.isArray(announces) || !announces.includes(name)) return false
    process.kill(pid as number, 0)
    return true
  } catch (error) {
    // EPERM: the process is there, under another user.
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

/** A desktop notification; a machine without one loses only the notice, never the run. */
export const notify = async (system: ServerSystem, env: NodeJS.ProcessEnv, title: string, body: string) => {
  const argv =
    system.platform === "linux"
      ? ["notify-send", "--app-name", title, title, body]
      : system.platform === "darwin"
        ? [
            "osascript",
            "-e",
            "on run argv",
            "-e",
            "display notification (item 2 of argv) with title (item 1 of argv)",
            "-e",
            "end run",
            title,
            body,
          ]
        : system.platform === "win32"
          ? [
              "powershell.exe",
              "-NoProfile",
              "-NonInteractive",
              "-Command",
              [
                "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null",
                "$xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)",
                "$text = $xml.GetElementsByTagName('text')",
                "$text.Item(0).AppendChild($xml.CreateTextNode($env:WIRECAT_TITLE)) | Out-Null",
                "$text.Item(1).AppendChild($xml.CreateTextNode($env:WIRECAT_BODY)) | Out-Null",
                // Windows shows a toast only for a registered app; PowerShell's own id is always there.
                "$app = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'",
                "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($app).Show([Windows.UI.Notifications.ToastNotification]::new($xml))",
              ].join("\n"),
            ]
          : undefined
  if (!argv) return false
  try {
    return (await system.run(argv, { ...env, WIRECAT_TITLE: title, WIRECAT_BODY: body })).code === 0
  } catch {
    return false
  }
}

/** Finds a program on PATH, as the timer will not have the shell's PATH to find it by. */
export const findProgram = (name: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string | undefined => {
  const separator = platform === "win32" ? ";" : ":"
  const extensions = platform === "win32" ? ["", ".exe"] : [""]
  for (const folder of (env.PATH ?? env.Path ?? "").split(separator).filter(Boolean)) {
    for (const extension of extensions) {
      const path = join(folder, `${name}${extension}`)
      if (existsSync(path)) return path
    }
  }
  return undefined
}

const KEEP_RUNS = 30
/** How long a stopped child has to save and answer after SIGTERM before it is killed. */
export const KILL_AFTER_MS = 10_000
/**
 * The reason tg and max give when a profile that has logged in here cannot read its sign-in: the keyring is
 * locked or out of reach, which a later try fixes and a new login does not.
 */
export const CREDENTIALS_UNREACHABLE = "credentials.unreachable"
const LOCKED_FIRST_WAIT_MS = 60_000
const LOCKED_LONGEST_WAIT_MS = 15 * 60_000
/** A night's catch-up waits for the morning's login; past that the run fails as it is. */
const LOCKED_GIVE_UP_MS = 12 * 60 * 60_000

/** A wait the provider asked for that a daily run sits out and then runs once more; a longer one fails for the day. */
const RATE_LIMITED_WAIT_AT_MOST_MS = 6 * 60 * 60_000
const RATE_LIMITED_MARGIN_MS = 30_000

const lockedOut = (last: LastRun) => last.reason?.endsWith(`(${CREDENTIALS_UNREACHABLE})`) === true

const pause = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve()
    const done = () => {
      clearTimeout(timer)
      signal?.removeEventListener("abort", done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal?.addEventListener("abort", done, { once: true })
  })

/**
 * One run: the command or the agent with the schedule's variables, its output kept beside the schedule,
 * the last result in `last.json`. An agent runs under `<PREFIX>_READ_ONLY`, so nothing it is talked
 * into can send. A one-off removes itself afterwards.
 *
 * `untilUnlocked` is for the timer's run: a timer that catches up at boot runs before the login unlocks the
 * keyring, so a run that fails for that reason is tried again, a minute then up to 15 minutes apart, for up to
 * 12 hours. A run the provider asked to wait (`rate_limited` with `retry.after_ms`, up to 6 hours) waits that long
 * and runs once more. A schedule that repeats every few minutes is left to its next tick; a run by hand fails at once.
 */
export const runSchedule = async (
  app: AppIdentity,
  system: ServerSystem,
  env: NodeJS.ProcessEnv,
  file: string,
  {
    now = () => new Date(),
    timer,
    signal,
    killAfterMs = KILL_AFTER_MS,
    untilUnlocked = false,
    wait = pause,
    agentRuns = [],
    agentInput,
    ownerLanguage = async () => "ru",
    reportTemplates,
    skipRepeatedInput = false,
    routes: chosen,
  }: {
    now?: () => Date
    timer?: Timer
    signal?: AbortSignal
    killAfterMs?: number
    untilUnlocked?: boolean
    wait?: (ms: number, signal?: AbortSignal) => Promise<void>
    /** The other CLIs an agent may run; each runs under its own read-only lock and knows it runs from a schedule. */
    agentRuns?: readonly AgentCli[]
    agentInput?: AgentInput
    /** The owner's first language, read only when the answer is a report; Russian when the host cannot say. */
    ownerLanguage?: (env: NodeJS.ProcessEnv) => Promise<string>
    /** The owner's stored report templates; the shipped ones when the host gives none. */
    reportTemplates?: (env: NodeJS.ProcessEnv, schedule: string) => StoredTemplates
    /**
     * Leave out a mail-gated agent whose input is the one its last run ended well on. The mark did not move, so the
     * run would only meet the same input again and pay for it; new mail changes the input.
     */
    skipRepeatedInput?: boolean
    /** Where this run goes instead of the schedule's own routes; `[]` keeps it here. */
    routes?: readonly string[]
  } = {},
): Promise<LastRun> => {
  const schedule = readSchedule(file)
  const folder = join(file, "..")
  const runs = join(folder, "runs")
  mkdirSync(runs, { recursive: true, mode: 0o700 })
  const agent = schedule.kind === "agent"
  const retries = untilUnlocked && !("every" in schedule.when)
  const firstAt = now().getTime()
  const first = await attemptSchedule(app, system, env, schedule, folder, {
    now,
    signal,
    killAfterMs,
    agentRuns,
    agentInput,
    skipRepeatedInput,
  })
  if ("repeated" in first) {
    recordSkip(
      file,
      "the input is the same as the last run's, which moved no mark; it runs again once new mail comes",
      SKIP_REASONS.mailSameInput,
      now(),
    )
    return lastRun(file) ?? first.repeated
  }
  let last = first
  for (
    let delay = LOCKED_FIRST_WAIT_MS;
    retries && lockedOut(last) && !signal?.aborted && now().getTime() - firstAt + delay <= LOCKED_GIVE_UP_MS;
    delay = Math.min(delay * 2, LOCKED_LONGEST_WAIT_MS)
  ) {
    await wait(delay, signal)
    if (signal?.aborted) break
    const again = await attemptSchedule(app, system, env, schedule, folder, {
      now,
      signal,
      killAfterMs,
      agentRuns,
      agentInput,
    })
    if ("repeated" in again) break
    last = again
  }
  const asked = last.errorCode === "rate_limited" ? last.retryAfterMs : undefined
  if (retries && asked !== undefined && asked <= RATE_LIMITED_WAIT_AT_MOST_MS && !signal?.aborted) {
    await wait(asked + RATE_LIMITED_MARGIN_MS, signal)
    if (!signal?.aborted) {
      const again = await attemptSchedule(app, system, env, schedule, folder, {
        now,
        signal,
        killAfterMs,
        agentRuns,
        agentInput,
      })
      if (!("repeated" in again)) last = again
    }
  }
  const { exitCode, output } = last
  const errors = agent ? output.replace(/\.md$/, ".log") : output
  if (agent && exitCode === 0) copyFileSync(output, join(folder, "latest.md"))
  const runEnv = { ...env, ...schedule.environment }
  const prepared =
    agent && exitCode === 0
      ? await prepareReport(readFileSync(output, "utf8"), {
          language: await ownerLanguage(runEnv).catch(() => "ru"),
          now: now().getTime(),
          links: sharedLinks(runEnv),
          env: runEnv,
          ...(reportTemplates ? { templates: reportTemplates(runEnv, schedule.name) } : {}),
        })
      : undefined
  const latestText = join(folder, "latest.txt")
  if (prepared) {
    writeFileSync(latestText, `${prepared.terminal}\n`, { mode: 0o600 })
    if (prepared.document) writeFileSync(output.replace(/\.md$/, ".report.json"), prepared.document, { mode: 0o600 })
    last = rewriteRun(join(folder, "last.json"), { ...last, report: prepared.run })
  } else if (agent && exitCode === 0) rmSync(latestText, { force: true })

  const stampOf = (file: string) => file.split(".")[0] ?? file
  const stamps = [...new Set(readdirSync(runs).map(stampOf))].sort()
  const old = new Set(stamps.filter((stamp) => backfilled(runs, stamp)))
  const kept = new Set([...stamps.filter((stamp) => !old.has(stamp)).slice(-KEEP_RUNS), ...old])
  for (const file of readdirSync(runs)) if (!kept.has(stampOf(file))) rmSync(join(runs, file), { force: true })

  const title = `${app.command} ${schedule.name}`
  // Routes the owner named for this run go whatever the schedule's notify says; none named, nobody is told.
  const mode = chosen === undefined ? notifyOf(schedule) : chosen.length ? "always" : "never"
  if (agent && exitCode === 0) {
    if (mode === "always" && !announcedByDesktop(join(folder, ".."), schedule.name)) {
      const first =
        readFileSync(output, "utf8")
          .split("\n")
          .find((line) => line.trim()) ?? "report ready"
      await notify(
        system,
        env,
        title,
        prepared
          ? `${prepared.notice.slice(0, 180)}\n${latestText}`
          : `${first.trim().slice(0, 180)}\n${join(folder, "latest.md")}`,
      )
    }
  } else if (exitCode !== 0 && mode !== "never") {
    await notify(system, env, title, `failed (exit ${exitCode}) — ${errors}`)
  }

  const routes = chosen ?? schedule.to ?? []
  const locked = readOnlyLockOf(app, runEnv)
  const sendAlong = async (parcel: Parcel) => {
    const deliveries = await deliver(system, runEnv, routes, parcel, {
      find: (name, on) => findProgram(name, on, system.platform),
      errorOf: reasonOf,
      ...(locked ? { locked } : {}),
    })
    const lost = deliveries.filter((one) => !one.ok)
    if (lost.length > 0 && mode !== "never") {
      await notify(system, env, title, lost.map((one) => `not delivered to ${one.to}: ${one.reason}`).join("\n"))
    }
    return deliveries
  }
  const messageOptions = async () => ({
    language: await ownerLanguage(runEnv).catch(() => "ru"),
    linkOf: (ref: string) => linkFor(ref, { form: "web", config: sharedLinks(runEnv), env: runEnv }),
    ...(reportTemplates ? { templates: reportTemplates(runEnv, schedule.name) } : {}),
  })
  if (routes.length > 0 && (exitCode === 0 ? mode === "always" : mode !== "never")) {
    const at = shortTime(last.at)
    const notice = exitCode === 0 ? undefined : await failureNotice(app, schedule, last, now(), await messageOptions())
    const deliveries = await sendAlong(
      exitCode === 0
        ? {
            title: `${title} · ${at}`,
            file: { path: output, name: `${schedule.name}-${at.replace(/[ :]/g, "-")}.${agent ? "md" : "txt"}` },
            ...(prepared ? { rendered: prepared } : {}),
          }
        : notice
          ? { title: notice.subject, rendered: notice }
          : {
              title: `${title} failed · ${at}`,
              line:
                `${title} failed at ${at} (exit ${exitCode}` +
                `${last.failures && last.failures > 1 ? `, ${last.failures} runs in a row` : ""})` +
                `${last.reason ? `: ${last.reason}` : ""} — ${errors}`,
            },
    )
    last = rewriteRun(join(folder, "last.json"), { ...last, deliveries })
  }
  if (routes.length > 0 && mode === "always" && prepared && !prepared.invalid && gapsDue(folder, now())) {
    const gaps = weeklyGapsOf(runs, now().getTime())
    const options = await messageOptions()
    const message =
      gaps.gaps.length === 0
        ? undefined
        : await prepareMessage(
            "weekly-gaps",
            (language) => gapsView(gaps, { language, now: now().getTime(), linkOf: options.linkOf }),
            options,
          ).catch(() => undefined)
    const deliveries = message ? await sendAlong({ title: message.subject, rendered: message }) : []
    writeSecurely(
      join(folder, WEEKLY_GAPS_FILE),
      `${JSON.stringify({ at: now().toISOString(), gaps: gaps.gaps.length, runs: gaps.runs, deliveries }, null, 2)}\n`,
      0o600,
    )
  }

  if ("once" in schedule.when) {
    await timer?.remove(schedule.name)
    rmSync(file, { force: true })
  }
  return last
}

/**
 * The rendered notice of a failed run: which schedule, since when, the cause, and one link to the tool's sync
 * screen; undefined when even the shipped template fails, and the run's one line goes instead.
 */
const failureNotice = async (
  app: AppIdentity,
  schedule: Schedule,
  last: LastRun,
  at: Date,
  options: { language: string; linkOf: (ref: string) => string | null; templates?: StoredTemplates },
): Promise<PreparedMessage | undefined> => {
  const failure = {
    kind: "schedule-failed" as const,
    tool: app.command,
    schedule: schedule.name,
    at: last.at,
    since: last.failingSince ?? last.at,
    failures: last.failures ?? 1,
    cause: lockedOut(last) ? ("locked" as const) : causeOf(last.errorCode, last.exitCode),
    refs: [`sync:${app.command}`],
  }
  return prepareMessage(
    "schedule-failed",
    (language) => noticeView(failure, { language, now: at.getTime(), linkOf: options.linkOf }),
    options,
  ).catch(() => undefined)
}

/** When the weekly gaps went last, how many, and along which routes. */
const WEEKLY_GAPS_FILE = "weekly-gaps.json"

/** Monday 00:00, local time, of the week `at` falls in. */
const weekStart = (at: Date): number => {
  const day = new Date(at)
  day.setHours(0, 0, 0, 0)
  day.setDate(day.getDate() - ((day.getDay() + 6) % 7))
  return day.getTime()
}

/**
 * Whether this digest run also sends the week's gaps: on a Monday, or on the first run of a week whose Monday run
 * did not send them. A schedule that never sent any waits for its first Monday, so it never sends one day's gaps.
 */
const gapsDue = (folder: string, now: Date): boolean => {
  let sent: number | undefined
  try {
    sent = Date.parse((JSON.parse(readFileSync(join(folder, WEEKLY_GAPS_FILE), "utf8")) as { at: string }).at)
  } catch {}
  return sent === undefined || Number.isNaN(sent) ? now.getDay() === 1 : sent < weekStart(now)
}

/** The agent's input, or none: a host read that fails leaves the agent to fetch what it needs itself. */
const inputOf = async (
  agentInput: AgentInput,
  system: ServerSystem,
  env: NodeJS.ProcessEnv,
  schedule: Schedule,
  log: ReturnType<typeof recordLogFor>,
): Promise<string | undefined> => {
  try {
    const input = await agentInput(schedule, async (argv) => {
      const ran = await system.run([...system.entry, ...argv], env)
      if (ran.code !== 0) throw new Error(`${argv.slice(0, 3).join(" ")} exited ${ran.code}`)
      return ran.stdout
    })
    return input === undefined ? undefined : capped(input)
  } catch (error) {
    log.warn({ event: "schedule.input-failed", schedule: schedule.name, reason: String(error) })
    return undefined
  }
}

/** One run of the schedule's command or agent: its output in `runs/`, its result in `last.json`. */
export const attemptSchedule = async (
  app: AppIdentity,
  system: ServerSystem,
  env: NodeJS.ProcessEnv,
  schedule: Schedule,
  folder: string,
  {
    now,
    signal,
    killAfterMs,
    agentRuns,
    agentInput,
    skipRepeatedInput = false,
    at,
  }: {
    now: () => Date
    signal: AbortSignal | undefined
    killAfterMs: number
    agentRuns: readonly AgentCli[]
    agentInput: AgentInput | undefined
    skipRepeatedInput?: boolean
    /** A backfill's run time: the files are named for it, and `last.json` is left as it is. */
    at?: Date
  },
): Promise<LastRun | { repeated: LastRun }> => {
  const runs = join(folder, "runs")
  const stamp = (at ?? now())
    .toISOString()
    .replaceAll(":", "-")
    .replace(/\.\d+Z$/, "Z")
  const agent = schedule.kind === "agent"
  const output = join(runs, `${stamp}.${agent ? "md" : "log"}`)
  const errors = agent ? join(runs, `${stamp}.log`) : output
  const [program = "", ...args] = agent ? priced(schedule.argv) : [...system.entry, ...schedule.argv]
  const trace = childTrace()
  const childEnv = {
    ...env,
    ...schedule.environment,
    TRACEPARENT: trace.traceparent,
    [`${app.envPrefix}_SCHEDULED`]: schedule.name,
    ...(schedule.onNewMail ? { [mailHolderVariable(app)]: schedule.onNewMail } : {}),
    // A run started under the lock stays under it, whatever the schedule file says.
    ...(agent || readOnlyLockOf(app, env) ? { [`${app.envPrefix}_READ_ONLY`]: "1" } : {}),
    ...(agent
      ? Object.fromEntries(
          agentRuns.flatMap((other) => [
            [`${other.envPrefix}_READ_ONLY`, "1"],
            [`${other.envPrefix}_SCHEDULED`, schedule.name],
          ]),
        )
      : {}),
  }
  // The child's output is data, and an agent's is another program's: it is kept as it came. These lines say
  // only when it ran and how it ended.
  const log = recordLogFor(join(runs, `${stamp}.jsonl`), app, { traceId: trace.traceId })
  const facts = { schedule: schedule.name, kind: schedule.kind }
  const began = now().getTime()
  log.info({ event: "schedule.start", ...facts })
  const input = agent && agentInput ? await inputOf(agentInput, system, childEnv, schedule, log) : undefined
  const inputHash =
    input === undefined || !schedule.onNewMail ? undefined : createHash("sha256").update(input).digest("hex")
  const before = skipRepeatedInput && inputHash !== undefined ? readRun(join(folder, "last.json")) : undefined
  if (before?.exitCode === 0 && before.inputHash === inputHash) {
    // A skip every few minutes would otherwise push the kept runs' files out of runs/.
    rmSync(join(runs, `${stamp}.jsonl`), { force: true })
    return { repeated: before }
  }
  let costUsd: number | undefined
  const exitCode = await new Promise<number>((resolve) => {
    const child = spawn(program, args, { env: childEnv, cwd: folder, stdio: ["pipe", "pipe", "pipe"] })
    // An agent that stops reading its stdin may close it first; that is no failure of the run.
    child.stdin?.on("error", () => {})
    child.stdin?.end(input)
    const out: Buffer[] = []
    const err: Buffer[] = []
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk))
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk))
    child.on("error", (error) => {
      err.push(Buffer.from(String(error)))
      resolve(127)
    })
    // The child keeps its own deadline; a stop of this run stops the child too, so nothing it does outlives the run.
    let kill: NodeJS.Timeout | undefined
    const stop = () => {
      child.kill("SIGTERM")
      kill = setTimeout(() => child.kill("SIGKILL"), killAfterMs)
    }
    if (signal?.aborted) stop()
    else signal?.addEventListener("abort", stop, { once: true })
    child.on("close", (code, killedBy) => {
      signal?.removeEventListener("abort", stop)
      if (kill) clearTimeout(kill)
      const report = agent ? reportOf(Buffer.concat(out)) : { text: Buffer.concat([...out, ...err]) }
      costUsd = report.costUsd
      writeFileSync(output, report.text, { mode: 0o600 })
      if (agent) writeFileSync(errors, Buffer.concat(err), { mode: 0o600 })
      resolve(code ?? (killedBy === "SIGKILL" ? 137 : killedBy === "SIGTERM" ? 143 : 1))
    })
  })
  const ended = now()
  if (costUsd !== undefined) addSpend(folder, costUsd, ended)
  log[exitCode === 0 ? "info" : "error"]({
    event: "schedule.exit",
    ...facts,
    exitCode,
    durationMs: ended.getTime() - began,
    ...(costUsd === undefined ? {} : { costUsd }),
  })
  const run = {
    at: (at ?? ended).toISOString(),
    exitCode,
    output,
    traceId: trace.traceId,
    ...(costUsd === undefined ? {} : { costUsd }),
    ...(inputHash === undefined ? {} : { inputHash }),
    ...(exitCode === 0 ? {} : failureOf(readFileSync(errors, "utf8"), exitCode)),
  }
  return at ? run : recordRun(join(folder, "last.json"), run)
}

/** A backfilled run is older than the runs it joins, so the count that keeps the newest runs would remove it first. */
const backfilled = (runs: string, stamp: string): boolean => {
  const document = join(runs, `${stamp}.report.json`)
  try {
    return (
      existsSync(document) && (JSON.parse(readFileSync(document, "utf8")) as { backfill?: unknown }).backfill === true
    )
  } catch {
    return false
  }
}
