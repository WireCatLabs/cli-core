import { existsSync, rmSync } from "node:fs"
import { dirname, join } from "node:path"
import { CliError, resolvePaths, writeSecurely } from "@wirecat/cli-base"
import { annotate } from "@wirecat/cli-base/commands"
import { Argument, Command, Option } from "commander"
import { backfillSchedule } from "../../background/backfill.js"
import { parseRoute, ROUTE_HELP, routeText } from "../../background/deliver.js"
import { REPORT_CHANNELS, type StoredTemplates } from "../../background/report/render.js"
import { reportKeysOf } from "../../background/report/stored-templates.js"
import {
  type AgentCli,
  type AgentInput,
  calendarOf,
  describeWhen,
  isCalendar,
  type LastRun,
  lastRun,
  listSchedules,
  NOTIFY_WHEN,
  type Notify,
  notifyOf,
  readSchedule,
  recordSkip,
  runSchedule,
  SCHEDULE_DEFAULTS,
  type Schedule,
  SKIP_REASONS,
  type SkipReason,
  type Slot,
  scheduleFile,
  scheduleName,
  slotsOf,
  spentToday,
  timerFor,
  WEEKDAYS,
  type Weekday,
  type When,
} from "../../background/schedules.js"
import { type ServerSystem, thisMachine } from "../../background/system.js"
import { locationVariables } from "../../background/units.js"
import { parseDuration } from "../../domain/duration.js"
import { HOLDER, type MailWaiting } from "../../mail/marks.js"
import { type AppIdentity, readOnlyLockOf } from "../../ports/app.js"
import { aheadOf } from "../../services/moment.js"
import { openCache } from "../../store/open.js"
import { storePath } from "../../store/path.js"
import { ownerLanguages, storedTemplateBodies } from "../../store/store.js"
import { type BaseEnvironment, environmentOf, setExitCode } from "../context.js"
import { grantsAuthority, LOCAL_READ, LOCAL_WRITE, REMOTE_WRITE } from "../effects.js"
import { type AnswerOutput, itemOf, listOf, renderAnswer, snakeKeys } from "../envelope.js"
import { listQuery, typedQuery, withQuery } from "../list-query.js"
import { SCHEDULE_HARNESSES_QUERY, SCHEDULES_QUERY, scheduleFilter } from "../messenger/list-result-queries.js"
import type { DeclaredSetting } from "../setting-defaults.js"
import { lineOf } from "../steps.js"
import {
  AGENT_MODELS,
  COSTED,
  HARNESSES,
  type Harness,
  harnessesOn,
  harnessOf,
  harnessOfArgv,
  isHarness,
  programOf,
  reportsCost,
} from "./harnesses.js"

/** Each run of an agent is a paid model call that reads chats; keeping the store current is `serve`'s job. */
const AGENT_MINIMUM_MINUTES = 60
/** A run gated on new mail costs a store read when nothing came, so it may check as often as mail syncs. */
const GATED_AGENT_MINIMUM_MINUTES = 5
const COMMAND_MINIMUM_MINUTES = 1
/** An alias or a model id; a leading dash would read as the harness's next flag. */
const isModel = (model: string) => /^([A-Za-z0-9][\w.:/@[\]-]*)?$/.test(model)
interface WhenOptions {
  every?: string
  at?: string[]
  atTime?: string
  notifyOn?: Notify
  deliverTo?: string[]
}

const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/

/** One `--at`: `HH:MM` every day, or weekdays and a time, `mon 09:00` or `mon,fri 09:00`. */
export const slotsOfAt = (at: string): Slot[] => {
  const [, words, clock = ""] = /^\s*(?:([a-z,]+)\s+)?(\S+)\s*$/i.exec(at) ?? []
  if (!CLOCK.test(clock))
    throw new CliError(
      "validation_error",
      `--at takes HH:MM, or a weekday and HH:MM such as 'mon 09:00' or 'mon,fri 09:00'; not "${at}"`,
    )
  if (words === undefined) return [{ at: clock }]
  return words.split(",").map((word) => {
    const day = word.toLowerCase().slice(0, 3)
    if (!(WEEKDAYS as readonly string[]).includes(day))
      throw new CliError("validation_error", `--at takes a weekday, ${WEEKDAYS.join(", ")}; not "${word}"`)
    return { at: clock, on: day as Weekday }
  })
}

const whenOf = ({ every, at = [], atTime }: WhenOptions, minimum: number): When => {
  if ([every ?? at[0], atTime].filter(Boolean).length !== 1 || (atTime && at.length > 0)) {
    throw new CliError(
      "validation_error",
      "say when: --every <30m|2h|1d>, --at HH:MM (daily) or --at 'mon HH:MM' (weekly), repeated for more times, or --at-time <30m|2d|ISO time>",
    )
  }
  if (atTime) {
    const time = aheadOf(atTime, "--at-time")
    if (time <= Date.now()) throw new CliError("validation_error", "--at-time is in the past")
    return { once: new Date(time).toISOString() }
  }
  if (at.length > 0) {
    const when = calendarOf(at.flatMap(slotsOfAt))
    if (every && ("calendar" in when || "weekly" in when || parseDuration(every, "--every") !== 86_400_000)) {
      throw new CliError(
        "validation_error",
        "daily" in when
          ? "--at runs once a day; leave out --every, or use --every 1d"
          : "weekly" in when
            ? "a weekday in --at runs once a week; leave out --every"
            : "--at sets the times; leave out --every",
      )
    }
    return when
  }
  const minutes = parseDuration(every ?? "", "--every") / 60_000
  if (!Number.isInteger(minutes) || minutes < minimum) {
    throw new CliError(
      "validation_error",
      `--every is at least ${minimum} minute${minimum === 1 ? "" : "s"} here, in whole minutes`,
    )
  }
  return { every: minutes }
}

/** A schedule as answered: snake_case, but its environment keeps the variables' own names. */
/**
 * A run waits for its child, which keeps its own deadline (a sync's is 15 minutes): the wait has none of its own, or the
 * run answered `timeout` at 30 s while the child went on. A signal or an explicit --timeout stops the child.
 */
const untilChildEnds = async <T>(command: Command, wait: (signal: AbortSignal | undefined) => Promise<T>) => {
  const environment = environmentOf(command)
  try {
    return await wait(environment.untilStopped?.())
  } finally {
    environment.endUntilStopped?.()
  }
}

// The file keeps `to`, as schedules saved before the flag was renamed have it; the answer names it as the flag does.
const scheduleAnswer = ({ environment, createdAt, to, ...schedule }: Schedule, extra: object) => ({
  ...(snakeKeys(schedule) as object),
  ...(to?.length ? { deliver_to: to } : {}),
  environment,
  created_at: createdAt,
  ...(snakeKeys(extra) as object),
})

const withWhen = (command: Command) =>
  command
    .option("--every <duration>", "repeat: 30m, 2h, 1d")
    .option(
      "--at <HH:MM>",
      `every day at this local time; 'mon 09:00' once a week, 'mon,fri 09:00' on several days (${WEEKDAYS.join(", ")}); repeat it for more times`,
      (at: string, all: string[] = []) => [...all, at],
    )
    .option("--at-time <time>", "one run: 30m, 2d from now, or an ISO time; the schedule removes itself after it")
    .addOption(
      new Option(
        "--notify-on <when>",
        "desktop notice after a run (default failures for an agent that repeats with --every, else always)",
      ).choices(NOTIFY_WHEN),
    )
    .option(
      "--deliver-to <route>",
      `also send the result, when --notify-on says so, by the owner's own tg or mail: ${ROUTE_HELP}; repeat it for more`,
      (route: string, routes: string[] = []) => [...routes, routeText(parseRoute(route))],
    )

/** What a schedule keeps of `--notify-on` and `--deliver-to`. */
const deliveryOf = ({ notifyOn, deliverTo }: WhenOptions): Pick<Schedule, "notify" | "to"> => ({
  ...(notifyOn ? { notify: notifyOn } : {}),
  ...(deliverTo?.length ? { to: deliverTo } : {}),
})

/** What the schedule command needs of a CLI: who it is and, per command, where it prints and which profile runs. */
/** `skill show follow-ups` exists only for messenger CLIs; any other CLI gets a read-only summary it can run. */
const promptExample = (app: AppIdentity) =>
  app.messenger === false
    ? `summarize what came in during the last day: ${app.command} personal search messages 'date>1d' --newest --limit 20`
    : `run the daily follow-up review: ${app.command} skill show follow-ups`

export interface ScheduleHost {
  app: AppIdentity
  context(
    command: Command,
    resolving?: { needsProfile?: boolean },
  ): AnswerOutput & { env: NodeJS.ProcessEnv; profile: string }
  /**
   * What mail waits past the holder's mark (`mailWaiting`). Given, `schedule agent` takes `--on-new-mail`: the agent
   * then runs only once enough of it waits, or the oldest has waited long enough.
   */
  newMail?: (command: Command, holder: string) => Promise<MailWaiting>
  /** What an agent is given on its stdin before its first turn; see `AgentInput`. */
  agentInput?: AgentInput
  /** The config file's settings for agent schedules; a schedule's own flags win, the defaults fill the rest. */
  limits?: (command: Command) => ScheduleLimits
  /**
   * Other CLIs the scheduled agent may run besides this one, each under its own `<PREFIX>_READ_ONLY`: memo's mail
   * triage runs `mail`. Claude may run them; codex may write their state, config and cache folders.
   */
  agentRuns?: readonly AgentCli[]
}

export type ScheduleLimits = Partial<
  Pick<Schedule, "mailWaitMinutes" | "mailBatch" | "maxCostPerDay"> & {
    models: Partial<Record<Harness, string>>
    leanStart: boolean
  }
>

/** The agent-schedule settings a host with `newMail` writes into its config file's top level (WC-CMD-30). */
export const SCHEDULE_SETTINGS: readonly DeclaredSetting[] = [
  {
    key: "schedule_mail_wait",
    default: `${SCHEDULE_DEFAULTS.mailWaitMinutes}m`,
    description: "an agent gated on new mail starts once the oldest waiting email has waited this long",
  },
  {
    key: "schedule_mail_batch",
    default: SCHEDULE_DEFAULTS.mailBatch,
    description: "or once this many emails wait for it",
  },
  {
    key: "schedule_max_cost_per_day",
    default: SCHEDULE_DEFAULTS.maxCostPerDay,
    description: "US dollars an agent schedule's runs may cost in a day before it waits for the next; 0 for no cap",
  },
  {
    key: "schedule_model_claude",
    default: AGENT_MODELS.claude,
    description:
      "the model a new claude agent schedule runs on, unless --model names one; empty for claude's own default",
  },
  {
    key: "schedule_model_codex",
    default: AGENT_MODELS.codex,
    description:
      "the model a new codex agent schedule runs on, unless --model names one; empty for codex's own default",
  },
  {
    key: "schedule_lean_start",
    default: true,
    description:
      "a new claude agent schedule starts without your MCP servers, skills, settings and CLAUDE.md; false loads them",
  },
]

/** `SCHEDULE_SETTINGS` as the config file gives them; a missing or unusable value is left to the default. */
export const scheduleLimitsOf = (config: {
  schedule_mail_wait?: unknown
  schedule_mail_batch?: unknown
  schedule_max_cost_per_day?: unknown
  schedule_model_claude?: unknown
  schedule_model_codex?: unknown
  schedule_lean_start?: unknown
}): ScheduleLimits => {
  const { schedule_mail_wait: wait, schedule_mail_batch: batch, schedule_max_cost_per_day: cap } = config
  const models = Object.fromEntries(
    HARNESSES.flatMap((harness) => {
      const model = (config as Record<string, unknown>)[`schedule_model_${harness}`]
      return typeof model === "string" && isModel(model.trim()) ? [[harness, model.trim()]] : []
    }),
  )
  return {
    ...(Object.keys(models).length ? { models } : {}),
    ...(typeof config.schedule_lean_start === "boolean" ? { leanStart: config.schedule_lean_start } : {}),
    ...(typeof wait === "string"
      ? { mailWaitMinutes: Math.ceil(parseDuration(wait, "schedule_mail_wait") / 60_000) }
      : {}),
    ...(typeof batch === "number" && Number.isSafeInteger(batch) && batch >= 1 ? { mailBatch: batch } : {}),
    ...(typeof cap === "number" && Number.isFinite(cap) && cap >= 0 ? { maxCostPerDay: cap } : {}),
  }
}

const given = (limits: ScheduleLimits): ScheduleLimits =>
  Object.fromEntries(Object.entries(limits).filter(([, value]) => value !== undefined))

const shown = (argv: string[]) => argv.map((arg) => (arg === "" ? '""' : arg)).join(" ")

const usd = (value: number) => `$${value.toFixed(2)}`

/** The per-run cap an agent schedule was made with (`--max-cost`, passed to claude as --max-budget-usd), or null. */
const runCapOf = (argv: readonly string[]): number | null => {
  const at = argv.indexOf("--max-budget-usd")
  const cap = at < 0 ? Number.NaN : Number(argv[at + 1])
  return Number.isFinite(cap) ? cap : null
}

/** The language a report is rendered in: the store's `owner_languages`, first one; Russian when it cannot be read. */
export const ownerLanguageOf = async (env: NodeJS.ProcessEnv): Promise<string> => {
  const path = storePath(env)
  if (!existsSync(path)) return "ru"
  const database = await openCache(path)
  try {
    const table = database.prepare("SELECT 1 FROM sqlite_master WHERE name = 'store_settings'").get()
    return (table ? ownerLanguages(database)[0] : undefined) ?? "ru"
  } finally {
    database.close()
  }
}

/** The templates the owner saved for a report, read without migrating the store; none when there is no store. */
const reportTemplatesOf =
  (env: NodeJS.ProcessEnv, schedule?: string): StoredTemplates =>
  async (kind, language) => {
    const path = storePath(env)
    if (!existsSync(path)) return {}
    const database = await openCache(path)
    try {
      const bodies = Object.assign(
        {},
        ...reportKeysOf(kind, schedule)
          .reverse()
          .map((key) => storedTemplateBodies(database, key, language)),
      ) as Record<string, string>
      return Object.fromEntries(
        REPORT_CHANNELS.flatMap((channel) => (channel in bodies ? [[channel, bodies[channel]]] : [])),
      )
    } finally {
      database.close()
    }
  }

/**
 * One past day's run of the agent schedule in `file`, as `backfillSchedule` makes it, with the owner's language and
 * templates as `schedule run` renders them; a stop of the command stops the agent.
 */
export const backfillScheduleRun = (
  command: Command,
  app: AppIdentity,
  env: NodeJS.ProcessEnv,
  file: string,
  { at, input, agentRuns = [] }: { at: Date; input?: string; agentRuns?: readonly AgentCli[] },
) =>
  untilChildEnds(command, (signal) =>
    backfillSchedule(
      app,
      environmentOf<BaseEnvironment & { system?: ServerSystem }>(command).system ?? thisMachine(),
      env,
      file,
      {
        at,
        agentRuns,
        ownerLanguage: ownerLanguageOf,
        reportTemplates: reportTemplatesOf,
        ...(input === undefined ? {} : { input }),
        ...(signal ? { signal } : {}),
      },
    ),
  )

/** Where a schedule is written and for whom: the CLI, the machine, the run's variables and its profile. */
export interface ScheduleSite {
  app: AppIdentity
  system: ServerSystem
  env: NodeJS.ProcessEnv
  profile: string
  /** Other CLIs an agent may run besides this one, each under its own read-only lock. */
  agentRuns?: readonly AgentCli[]
  /** The config file's agent-schedule settings. */
  limits?: ScheduleLimits
}

/** The tool's state folder, which holds its schedules. */
export const scheduleState = ({ app, env }: Pick<ScheduleSite, "app" | "env">) =>
  resolvePaths({ appName: app.appName, prefix: app.envPrefix, env }).state

/** The variables a run gets on top of the timer's: the profile, where the files are, PATH. Never a credential. */
const scheduleEnvironment = ({ app, env, profile }: ScheduleSite): Record<string, string> => {
  // The command line refuses a schedule under the lock; a caller that gets here still passes the lock on.
  const readOnly = readOnlyLockOf(app, env)
  return {
    [`${app.envPrefix}_PROFILE`]: profile,
    ...locationVariables(app, env),
    // The timer starts with almost no PATH; an agent runs the CLI and its own tools by name.
    ...(env.PATH ? { PATH: env.PATH } : {}),
    ...(readOnly ? { [readOnly]: "1" } : {}),
  }
}

/** An agent schedule as `schedule agent` makes it; the caller has checked the flags it was given. */
export interface AgentScheduleSpec {
  name: string
  harness: Harness
  prompt: string
  when: When
  /** An alias or a model id; "" for the harness's own default; absent for the config file's, else ours. */
  model?: string
  /** Claude only: a run that costs more is stopped, in US dollars. */
  maxCost?: number
  maxCostPerDay?: number
  onNewMail?: string
  mailWaitMinutes?: number
  mailBatch?: number
  notify?: Notify
  to?: string[]
  paused?: boolean
}

/** The schedule `spec` describes, with the harness's argv built here, never by the caller: its limits live in it. */
export const agentSchedule = (site: ScheduleSite, spec: AgentScheduleSpec): Schedule => {
  const { app, system, env, agentRuns = [], limits = {} } = site
  const { harness, prompt, when } = spec
  const minimum = spec.onNewMail ? GATED_AGENT_MINIMUM_MINUTES : AGENT_MINIMUM_MINUTES
  if ("every" in when && !(Number.isInteger(when.every) && when.every >= minimum))
    throw new CliError("validation_error", `an agent repeats at least every ${minimum} minutes, in whole minutes`)
  if (isCalendar(when)) {
    const slots = slotsOf(when)
    if (slots.length === 0 || slots.some((slot) => !CLOCK.test(slot.at) || (slot.on && !WEEKDAYS.includes(slot.on))))
      throw new CliError("validation_error", "an agent's times are HH:MM, each on any day or one weekday")
  }
  if (spec.model !== undefined && !isModel(spec.model))
    throw new CliError("validation_error", `--model takes an alias such as sonnet or a model id, not "${spec.model}"`)
  if (!isHarness(harness))
    throw new CliError("validation_error", `the agent is one of ${HARNESSES.join(", ")}; not "${harness}"`, {
      agents: HARNESSES,
    })
  const kind = harnessOf(harness)
  // The owner's ruling: a background agent that may run any command is never started.
  if (!kind.restricted)
    throw new CliError(
      "permission_error",
      `${kind.name} cannot run on a schedule: ${kind.restrictedReason ?? "nothing holds it to this tool's commands"}`,
      { reason: "agent.unrestricted" },
    )
  const model = spec.model ?? limits.models?.[harness] ?? AGENT_MODELS[harness]
  const program = programOf(harness, env, system.platform)
  if (!program) throw new CliError("not_found", `${kind.programs.join(" or ")} is not on PATH`)
  const clis = [app, ...agentRuns]
  const folders = clis.flatMap((one) => {
    const paths = resolvePaths({ appName: one.appName, prefix: one.envPrefix, env })
    return [paths.state, paths.config, paths.cache]
  })
  const name = scheduleName(spec.name)
  const start = kind.start({
    program,
    prompt,
    model,
    clis,
    folders: [dirname(storePath(env)), ...folders],
    leanStart: limits.leanStart ?? true,
    folder: dirname(scheduleFile(scheduleState(site), name)),
    ...(spec.maxCost && kind.reportsCost ? { maxCost: spec.maxCost } : {}),
  })
  return {
    name,
    kind: "agent",
    argv: start.argv,
    when: spec.when,
    environment: { ...scheduleEnvironment(site), ...start.environment },
    ...(start.files ? { files: start.files } : {}),
    createdAt: new Date().toISOString(),
    ...(spec.onNewMail ? { onNewMail: spec.onNewMail } : {}),
    ...(spec.mailWaitMinutes === undefined ? {} : { mailWaitMinutes: spec.mailWaitMinutes }),
    ...(spec.mailBatch === undefined ? {} : { mailBatch: spec.mailBatch }),
    ...(spec.maxCostPerDay === undefined || !kind.reportsCost ? {} : { maxCostPerDay: spec.maxCostPerDay }),
    ...(spec.notify ? { notify: spec.notify } : {}),
    ...(spec.to?.length ? { to: spec.to } : {}),
    ...(spec.paused ? { paused: true } : {}),
  }
}

/**
 * Writes the schedule's file and puts it on its timer, or takes it off when it is paused. A name another profile's
 * schedule holds is refused.
 */
export const writeSchedule = async (
  site: ScheduleSite,
  schedule: Schedule,
): Promise<{ file: string; timer: string; replaced: boolean }> => {
  const { app, system, env, profile } = site
  const file = scheduleFile(scheduleState(site), schedule.name)
  const replaced = existsSync(file)
  if (replaced) {
    const owner = readSchedule(file).environment[`${app.envPrefix}_PROFILE`]
    if (owner && owner !== profile) {
      throw new CliError(
        "validation_error",
        `schedule ${schedule.name} already runs for profile ${owner}; name this one for ${profile}, e.g. ${schedule.name}-${profile}`,
      )
    }
  }
  writeSecurely(file, `${JSON.stringify(schedule, null, 2)}\n`, 0o600)
  const timer = timerFor(app, system, env)
  if (schedule.paused) await timer.remove(schedule.name)
  else await timer.install(schedule, [...system.entry, "schedule", "exec", file])
  return { file, timer: timer.where(schedule.name), replaced }
}

/** Why an agent schedule may not start today: its runs cost the day's cap. Recorded as the run's skip. */
const dayCapReached = (file: string, schedule: Schedule, maxCostPerDay: number) => {
  if (schedule.kind !== "agent" || maxCostPerDay <= 0) return undefined
  const spent = spentToday(file)
  if (spent < maxCostPerDay) return undefined
  const why = `today's runs cost ${usd(spent)}, the ${usd(maxCostPerDay)} a day allowed; it runs again tomorrow`
  recordSkip(file, why, SKIP_REASONS.costDayCap)
  return { why, reason: SKIP_REASONS.costDayCap }
}

/** Refuses a route the schedule was not given: it would send the owner's report somewhere he never said. */
const ownRoutes = (schedule: Schedule, routes: readonly string[] | undefined) => {
  const own = schedule.to ?? []
  const other = (routes ?? []).filter((route) => !own.includes(route))
  if (other.length)
    throw new CliError(
      "validation_error",
      `--deliver-to takes only ${schedule.name}'s own routes (${own.join(", ") || "it has none"}); not ${other.join(", ")}`,
    )
}

/**
 * Takes a schedule off its timer and keeps its file, or puts it back. It keeps the profile it was made for, as pausing
 * names no new one.
 */
export const pauseSchedule = async (site: ScheduleSite, name: string, paused: boolean) => {
  const file = scheduleFile(scheduleState(site), scheduleName(name))
  if (!existsSync(file)) throw new CliError("not_found", `no schedule ${name}`)
  const { paused: _, ...schedule } = readSchedule(file)
  const owner = schedule.environment[`${site.app.envPrefix}_PROFILE`] ?? site.profile
  const kept = paused ? { ...schedule, paused: true as const } : schedule
  return { schedule: kept, ...(await writeSchedule({ ...site, profile: owner }, kept)) }
}

/** Takes the schedule off its timer and removes its file; its past runs stay. */
export const removeSchedule = async (site: ScheduleSite, name: string): Promise<void> => {
  const file = scheduleFile(scheduleState(site), scheduleName(name))
  if (!existsSync(file)) throw new CliError("not_found", `no schedule ${name}`)
  await timerFor(site.app, site.system, site.env).remove(name)
  rmSync(file, { force: true })
}

/**
 * Runs the schedule in `file` now, as `schedule run` does: its report rendered with the owner's language and templates
 * and sent along `routes` (its own when absent, none when empty). A stop of the command stops the agent.
 */
export const runScheduleNow = async (
  command: Command,
  site: ScheduleSite,
  file: string,
  { routes, agentInput }: { routes?: readonly string[]; agentInput?: AgentInput } = {},
): Promise<LastRun | { skipped: { why: string; reason: SkipReason } }> => {
  const schedule = readSchedule(file)
  ownRoutes(schedule, routes)
  const maxCostPerDay = schedule.maxCostPerDay ?? site.limits?.maxCostPerDay ?? SCHEDULE_DEFAULTS.maxCostPerDay
  const capped = dayCapReached(file, schedule, maxCostPerDay)
  if (capped) return { skipped: capped }
  return untilChildEnds(command, (signal) =>
    runSchedule(site.app, site.system, site.env, file, {
      timer: timerFor(site.app, site.system, site.env),
      agentRuns: site.agentRuns ?? [],
      ownerLanguage: ownerLanguageOf,
      reportTemplates: reportTemplatesOf,
      ...(agentInput ? { agentInput } : {}),
      ...(routes ? { routes } : {}),
      ...(signal ? { signal } : {}),
    }),
  )
}

/**
 * Runs the CLI's own commands, or an agent, later or on a timer — through systemd (Linux), launchd
 * (macOS) or Task Scheduler (Windows). Every timer runs `schedule exec <file>`; the schedule file holds
 * the rest, so what runs and with which variables is the same on all three.
 */
export const scheduleCommandFor = ({
  app,
  context: contextOf,
  newMail,
  agentInput,
  limits: configured,
  agentRuns = [],
}: ScheduleHost): Command => {
  const agentClis = [app, ...agentRuns]
  const command = new Command("schedule").description(
    `run a ${app.command} command or an agent later or on a timer (systemd, launchd, Task Scheduler); an agent cannot send`,
  )

  const prepare = (self: Command, resolving: { needsProfile?: boolean } = {}) => {
    const context = contextOf(self, resolving)
    const system = environmentOf<BaseEnvironment & { system?: ServerSystem }>(self).system ?? thisMachine()
    const site: ScheduleSite = {
      app,
      system,
      env: context.env,
      profile: context.profile,
      agentRuns,
      limits: configured?.(self) ?? {},
    }
    const state = scheduleState(site)
    const say = (value: object, lines: string[]) => renderAnswer(self, context, itemOf(value), () => lines.join("\n"))
    const timer = () => timerFor(app, system, context.env)
    const environment = () => scheduleEnvironment(site)
    const save = async (schedule: Schedule) => {
      const { file, timer: where, replaced } = await writeSchedule(site, schedule)
      say(scheduleAnswer(schedule, { file, timer: where, replaced }), [
        `${replaced ? "Replaced" : "Added"} ${schedule.name}: ${describeWhen(schedule.when)}${schedule.paused ? ", paused" : ""}.`,
        `It runs: ${schedule.kind === "agent" ? shown(schedule.argv) : `${app.command} ${shown(schedule.argv)}`}`,
        `Output: ${join(dirname(file), "runs")} · now: ${lineOf(self, `schedule run ${schedule.name}`)} · stop: ${lineOf(self, `schedule remove ${schedule.name}`)}`,
      ])
    }
    return { context, system, state, say, timer, environment, save, site }
  }
  /**
   * Why a run does not start now, or nothing: an agent whose runs reached the day's cost cap waits for tomorrow, and
   * one gated on mail waits for mail past its holder's mark — on its timer, until enough of it waits.
   */
  /** A schedule's own limits, else the config file's, else the defaults. */
  const limitsOf = (self: Command, schedule: Schedule) => ({
    ...SCHEDULE_DEFAULTS,
    ...given(configured?.(self) ?? {}),
    ...given({
      mailWaitMinutes: schedule.mailWaitMinutes,
      mailBatch: schedule.mailBatch,
      maxCostPerDay: schedule.maxCostPerDay,
    }),
  })
  /** An agent that reports no cost answers null for what it spent and for its caps: unknown, not $0 and not capped. */
  const agentCostsOf = (self: Command, state: string, schedule: Schedule) => {
    const harness = harnessOfArgv(schedule.argv)
    const costed = harness !== null && reportsCost(harness)
    return {
      harness,
      reportsCost: costed,
      spentTodayUsd: costed ? spentToday(scheduleFile(state, schedule.name)) : null,
      maxCostUsd: costed ? runCapOf(schedule.argv) : null,
      maxCostPerDayUsd: costed ? limitsOf(self, schedule).maxCostPerDay : null,
    }
  }
  const waits = async (
    self: Command,
    file: string,
    { timed }: { timed: boolean },
  ): Promise<{ why: string; reason: SkipReason } | undefined> => {
    if (!existsSync(file)) return undefined
    const schedule = readSchedule(file)
    const { mailWaitMinutes, mailBatch, maxCostPerDay } = limitsOf(self, schedule)
    const capped = dayCapReached(file, schedule, maxCostPerDay)
    if (capped) return capped
    const holder = schedule.onNewMail
    if (holder === undefined || !newMail) return undefined
    const waiting = await newMail(self, holder)
    if (waiting.unmarked) return undefined
    if (waiting.emails === 0) {
      const why = `no mail stored past ${holder}'s mark`
      recordSkip(file, why, SKIP_REASONS.mailNone)
      return { why, reason: SKIP_REASONS.mailNone }
    }
    const waited = waiting.oldestStoredAt === null ? 0 : Date.now() - waiting.oldestStoredAt
    if (!timed || waiting.emails >= mailBatch || waited >= mailWaitMinutes * 60_000) return undefined
    const why =
      `${waiting.emails} email(s) wait past ${holder}'s mark; it starts at ${mailBatch}, ` +
      `or once the oldest has waited ${mailWaitMinutes}m`
    recordSkip(file, why, SKIP_REASONS.mailBelowThreshold)
    return { why, reason: SKIP_REASONS.mailBelowThreshold }
  }

  withWhen(
    grantsAuthority(
      annotate(command.command("command"), {
        literal_after_dashes: true,
        effects: LOCAL_WRITE,
        examples: [
          `${app.command} personal schedule command health --every 1h -- doctor`,
          `${app.command} personal schedule command morning-check --at 08:00 -- doctor`,
        ],
      }),
    )
      .description(
        `run ${app.command} <args…> on a timer — reads save what they read, so this is how a chat's history fills the store`,
      )
      .argument("<name>", "lowercase letters, digits and dashes")
      .argument("<args...>", `the ${app.command} command after its name, e.g. -- messages list <chat> --limit 50`),
  ).action(async function (this: Command, name: string, args: string[]) {
    const { environment, save } = prepare(this)
    if (args[0] === "schedule") throw new CliError("validation_error", "a schedule cannot run schedule")
    await save({
      name: scheduleName(name),
      kind: "command",
      argv: args,
      when: whenOf(this.opts<WhenOptions>(), COMMAND_MINIMUM_MINUTES),
      environment: environment(),
      createdAt: new Date().toISOString(),
      ...deliveryOf(this.opts<WhenOptions>()),
    })
  })

  withWhen(
    grantsAuthority(
      annotate(command.command("agent"), {
        effects: LOCAL_WRITE,
        examples: [
          `${app.command} personal schedule agent review claude "review what came in overnight and draft replies" --at 08:30`,
          `${app.command} personal schedule agent triage codex "list what needs an answer today" --every 2h --max-cost 1`,
          `${app.command} personal schedule agent weekly claude "review the week's open threads" --at 09:00 --model opus`,
        ],
      }),
    )
      .description(
        `start an agent (${HARNESSES.join(", ")}) with a prompt on a timer; it runs with ${agentClis.map((one) => `${one.envPrefix}_READ_ONLY=1`).join(" and ")}, so it reads and drafts and cannot send, and its own limits hold it to these CLIs' commands; an agent with no such limit is refused (\`schedule agents list\` says which) — its answer is kept and you are notified`,
      )
      .argument("<name>", "lowercase letters, digits and dashes")
      .addArgument(new Argument("<harness>", "the agent to start").choices(HARNESSES))
      .argument("<prompt>", `what to do, e.g. "${promptExample(app)}"`)
      .option(
        "--model <model>",
        `the model it runs on: an alias such as sonnet, or a model id; "" for the agent's own default (default sonnet for claude, the agent's own for the others, or the config file's)`,
      )
      .addOption(
        new Option("--max-cost <usd>", "claude only: stop a run that costs more than this, in US dollars").argParser(
          Number,
        ),
      )
      .addOption(
        new Option(
          "--max-cost-per-day <usd>",
          `${COSTED} only, as the others report no cost: start no run for the rest of the day once its runs cost this much, in US dollars; 0 for no cap (default ${SCHEDULE_DEFAULTS.maxCostPerDay}, or the config file's)`,
        ).argParser(Number),
      ),
  ).action(async function (this: Command, name: string, harness: Harness, prompt: string) {
    const { site, save } = prepare(this)
    const options = this.opts<
      WhenOptions & {
        model?: string
        maxCost?: number
        maxCostPerDay?: number
        onNewMail?: string
        mailWait?: string
        mailBatch?: string
      }
    >()
    if (options.onNewMail !== undefined && !HOLDER.test(options.onNewMail))
      throw new CliError("validation_error", `--on-new-mail takes a holder: lower-case letters, digits and dashes`)
    if ((options.mailWait !== undefined || options.mailBatch !== undefined) && options.onNewMail === undefined)
      throw new CliError("validation_error", "--mail-wait and --mail-batch shape a run gated by --on-new-mail")
    if (options.maxCostPerDay !== undefined && !(Number.isFinite(options.maxCostPerDay) && options.maxCostPerDay >= 0))
      throw new CliError("validation_error", "--max-cost-per-day takes US dollars, 0 or more")
    if (!reportsCost(harness) && (options.maxCost || options.maxCostPerDay))
      throw new CliError(
        "validation_error",
        `${harness} reports no cost, so --max-cost and --max-cost-per-day cannot stop it; leave them out (${COSTED} reports one)`,
        { reason: "agent.cost-unknown" },
      )
    const mailBatch = options.mailBatch === undefined ? undefined : Number(options.mailBatch)
    if (mailBatch !== undefined && !(Number.isSafeInteger(mailBatch) && mailBatch >= 1))
      throw new CliError("validation_error", "--mail-batch takes a count of emails, 1 or more")
    const mailWaitMinutes =
      options.mailWait === undefined ? undefined : Math.ceil(parseDuration(options.mailWait, "--mail-wait") / 60_000)
    await save(
      agentSchedule(site, {
        name,
        harness,
        prompt,
        when: whenOf(options, options.onNewMail ? GATED_AGENT_MINIMUM_MINUTES : AGENT_MINIMUM_MINUTES),
        ...(options.model === undefined ? {} : { model: options.model }),
        ...(options.maxCost ? { maxCost: options.maxCost } : {}),
        ...(options.maxCostPerDay === undefined ? {} : { maxCostPerDay: options.maxCostPerDay }),
        ...(options.onNewMail ? { onNewMail: options.onNewMail } : {}),
        ...(mailWaitMinutes === undefined ? {} : { mailWaitMinutes }),
        ...(mailBatch === undefined ? {} : { mailBatch }),
        ...deliveryOf(options),
      }),
    )
  })
  if (newMail)
    command.commands
      .find((one) => one.name() === "agent")
      ?.option(
        "--on-new-mail <holder>",
        `run only when mail is stored past this holder's mark — after a sync brought new mail; may check every ${GATED_AGENT_MINIMUM_MINUTES}m`,
      )
      .option(
        "--mail-wait <duration>",
        `with --on-new-mail: start once the oldest waiting email has waited this long (default ${SCHEDULE_DEFAULTS.mailWaitMinutes}m, or the config file's)`,
      )
      .option(
        "--mail-batch <n>",
        `with --on-new-mail: or once this many emails wait (default ${SCHEDULE_DEFAULTS.mailBatch}, or the config file's)`,
      )

  withQuery(
    annotate(command.command("list"), {
      effects: LOCAL_READ,
      examples: [`${app.command} personal schedule list`, `${app.command} personal schedule list kind:agent`],
    }),
    SCHEDULES_QUERY,
  )
    .description("the schedules, when they run and how their last run went")
    .action(function (this: Command, words: string[]) {
      const filter = scheduleFilter(words)
      const { context, state } = prepare(this)
      const rows = listSchedules(state, filter).map((schedule) => ({
        name: schedule.name,
        kind: schedule.kind,
        when: describeWhen(schedule.when),
        ...(schedule.paused ? { paused: true } : {}),
        notify: notifyOf(schedule),
        ...(schedule.to?.length ? { deliverTo: schedule.to } : {}),
        last: lastRun(scheduleFile(state, schedule.name)) ?? null,
        ...(schedule.kind === "agent" ? agentCostsOf(this, state, schedule) : {}),
      }))
      const answer = listOf("schedule list", {
        items: rows.map((row) => snakeKeys(row)),
        limit: Math.max(1, rows.length),
        has_more: false,
      })
      renderAnswer(this, context, answer, () => {
        if (rows.length === 0) {
          context.renderer.note(`no schedules — \`${lineOf(this, "schedule command|agent")}\` adds one`)
          return ""
        }
        return rows
          .map(({ name, kind, harness, when, paused, notify, deliverTo, last, spentTodayUsd, maxCostPerDayUsd }) =>
            [
              name,
              kind === "agent" ? `agent ${harness ?? "unknown"}` : kind,
              paused ? `${when}, paused` : when,
              `notify ${notify}`,
              ...(deliverTo ? [`to ${deliverTo.join(", ")}`] : []),
              last
                ? `last ${last.at.slice(0, 16).replace("T", " ")} exit ${last.exitCode}` +
                  (last.failures
                    ? ` — failing since ${(last.failingSince ?? last.at).slice(0, 16).replace("T", " ")}, ` +
                      `${last.failures} in a row${last.reason ? `: ${last.reason}` : ""} — ${last.output}`
                    : "")
                : "not run yet",
              ...(spentTodayUsd
                ? [`today ${usd(spentTodayUsd)}${maxCostPerDayUsd ? ` of ${usd(maxCostPerDayUsd)}` : ""}`]
                : []),
              ...(last?.skipped
                ? [`skipped ${last.skipped.at.slice(0, 16).replace("T", " ")}: ${last.skipped.why}`]
                : []),
              ...(last?.deliveries ?? [])
                .filter((one) => !one.ok)
                .map((one) => `not delivered to ${one.to}: ${one.reason}${one.error ? ` (${one.error})` : ""}`),
            ].join("  "),
          )
          .join("\n")
      })
    })

  withQuery(
    annotate(command.command("agents").description("the coding agents an agent schedule may start").command("list"), {
      effects: LOCAL_READ,
      examples: [`${app.command} schedule agents list`, `${app.command} schedule agents list --json`],
    }),
    SCHEDULE_HARNESSES_QUERY,
  )
    .description("the agents a schedule may start, and which are on PATH here")
    .action(function (this: Command, words: string[]) {
      listQuery(typedQuery(words), SCHEDULE_HARNESSES_QUERY, "schedule agents list")
      const { context, system } = prepare(this, { needsProfile: false })
      const rows = harnessesOn(context.env, system.platform)
      const answer = listOf("schedule agents list", {
        items: rows.map((row) => snakeKeys(row)),
        limit: rows.length,
        has_more: false,
      })
      renderAnswer(this, context, answer, () =>
        rows
          .map(({ id, name, installed, path, reportsCost }) =>
            [id, name, installed ? path : "not on PATH", reportsCost ? "reports cost" : "cost unknown"].join("  "),
          )
          .join("\n"),
      )
    })

  annotate(command.command("run"), {
    effects: REMOTE_WRITE,
    examples: [`${app.command} personal schedule run health`],
  })
    .description("run a schedule now, as its timer would, and wait for it; a paused one runs too")
    .argument("<name>", "the schedule's name, as `schedule list` shows it")
    .option("--no-notify", "keep the result here: send it along none of its routes")
    .option(
      "--deliver-to <route>",
      "send it along only this one of its own routes; repeat it for more",
      (route: string, routes: string[] = []) => [...routes, routeText(parseRoute(route))],
    )
    .action(async function (this: Command, name: string, given: { notify: boolean; deliverTo?: string[] }) {
      const { state, say, site } = prepare(this)
      const file = scheduleFile(state, scheduleName(name))
      const routes = given.notify ? given.deliverTo : []
      if (!given.notify && given.deliverTo)
        throw new CliError(
          "validation_error",
          "--no-notify sends nothing; leave out --deliver-to, or leave out --no-notify",
        )
      const skip = await waits(this, file, { timed: false })
      if (skip !== undefined) {
        return say({ name, skipped: true, why: skip.why, reason: skip.reason }, [`${name}: skipped — ${skip.why}`])
      }
      const last = await runScheduleNow(this, site, file, {
        ...(agentInput ? { agentInput } : {}),
        ...(routes ? { routes } : {}),
      })
      if (!("exitCode" in last)) {
        const { why, reason } = last.skipped
        return say({ name, skipped: true, why, reason }, [`${name}: skipped — ${why}`])
      }
      say(snakeKeys({ name, ...last }) as object, [`${name}: exit ${last.exitCode} — ${last.output}`])
      if (last.exitCode !== 0) setExitCode(this, 1)
    })

  grantsAuthority(
    annotate(command.command("remove"), {
      effects: LOCAL_WRITE,
      examples: [`${app.command} personal schedule remove health`],
    }),
  )
    .description("stop a schedule and remove its timer; its past output stays")
    .argument("<name>", "the schedule's name, as `schedule list` shows it")
    .action(async function (this: Command, name: string) {
      const { state, say, site } = prepare(this)
      if (!existsSync(scheduleFile(state, scheduleName(name))))
        throw new CliError("not_found", `no schedule ${name} — \`${lineOf(this, "schedule list")}\``)
      await removeSchedule(site, name)
      say({ name, removed: true }, [`Removed ${name}.`])
    })

  const setPaused = (paused: boolean) =>
    async function (this: Command, name: string) {
      const { state, say, site } = prepare(this)
      const file = scheduleFile(state, scheduleName(name))
      if (!existsSync(file))
        throw new CliError("not_found", `no schedule ${name} — \`${lineOf(this, "schedule list")}\``)
      const { schedule, timer } = await pauseSchedule(site, name, paused)
      say({ name, paused, timer }, [
        paused
          ? `Paused ${name}: no timer starts it; ${lineOf(this, `schedule run ${name}`)} still does.`
          : `Resumed ${name}: ${describeWhen(schedule.when)}.`,
      ])
    }
  grantsAuthority(
    annotate(command.command("pause"), {
      effects: LOCAL_WRITE,
      examples: [`${app.command} personal schedule pause health`],
    }),
  )
    .description("take a schedule off its timer and keep it; run runs it, resume puts it back")
    .argument("<name>", "the schedule's name, as `schedule list` shows it")
    .action(setPaused(true))
  grantsAuthority(
    annotate(command.command("resume"), {
      effects: LOCAL_WRITE,
      examples: [`${app.command} personal schedule resume health`],
    }),
  )
    .description("put a paused schedule back on its timer")
    .argument("<name>", "the schedule's name, as `schedule list` shows it")
    .action(setPaused(false))

  annotate(command.command("exec"), {
    effects: REMOTE_WRITE,
    examples: [`${app.command} schedule exec ~/.local/share/${app.appName}/schedules/health/schedule.json`],
  })
    .description("what a timer runs, given the schedule's file; to run one by hand, use run")
    .argument("<file>", "the schedule's schedule.json in the state folder, as the timer passes it")
    .action(async function (this: Command, file: string) {
      // A timer starts it with no profile named; the schedule's own environment carries the profile.
      const { context, system, timer } = prepare(this, { needsProfile: false })
      // A timer left behind by a pause that could not remove it must not run the schedule.
      if (existsSync(file) && readSchedule(file).paused) return
      if ((await waits(this, file, { timed: true })) !== undefined) return
      const last = await untilChildEnds(this, (signal) =>
        runSchedule(app, system, context.env, file, {
          timer: timer(),
          agentRuns,
          ownerLanguage: ownerLanguageOf,
          reportTemplates: reportTemplatesOf,
          ...(agentInput ? { agentInput } : {}),
          untilUnlocked: true,
          skipRepeatedInput: true,
          ...(signal ? { signal } : {}),
        }),
      )
      if (last.exitCode !== 0) setExitCode(this, 1)
    })

  return command
}
