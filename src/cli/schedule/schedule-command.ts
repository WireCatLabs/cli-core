import { existsSync, rmSync } from "node:fs"
import { dirname, join } from "node:path"
import { CliError, resolvePaths, writeSecurely } from "@wirecat/cli-base"
import { annotate } from "@wirecat/cli-base/commands"
import { Argument, Command, Option } from "commander"
import { parseRoute, ROUTE_HELP, routeText } from "../../background/deliver.js"
import { REPORT_CHANNELS, type StoredTemplates } from "../../background/report/render.js"
import { reportKeyOf } from "../../background/report/stored-templates.js"
import {
  type AgentCli,
  type AgentInput,
  describeWhen,
  findProgram,
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
  scheduleFile,
  scheduleName,
  spentToday,
  timerFor,
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
import { withQuery } from "../list-query.js"
import { SCHEDULES_QUERY, scheduleFilter } from "../messenger/list-result-queries.js"
import type { DeclaredSetting } from "../setting-defaults.js"
import { lineOf } from "../steps.js"

/** Each run of an agent is a paid model call that reads chats; keeping the store current is `serve`'s job. */
const AGENT_MINIMUM_MINUTES = 60
/** A run gated on new mail costs a store read when nothing came, so it may check as often as mail syncs. */
const GATED_AGENT_MINIMUM_MINUTES = 5
const COMMAND_MINIMUM_MINUTES = 1
const HARNESSES = ["claude", "codex"] as const
type Harness = (typeof HARNESSES)[number]
/** A mid-tier model by default; codex has no alias of that tier, so it takes its own default. Empty: the harness's own. */
const AGENT_MODELS: Record<Harness, string> = { claude: "sonnet", codex: "" }
/** An alias or a model id; a leading dash would read as the harness's next flag. */
const isModel = (model: string) => /^([A-Za-z0-9][\w.:/@[\]-]*)?$/.test(model)
/**
 * Claude starts without the owner's MCP servers, skills, settings and CLAUDE.md: a run reads its instructions
 * through the CLI, and the rest was most of its starting context. Auth, `--permission-mode` and `--allowedTools` hold.
 */
const LEAN_CLAUDE = ["--tools", "Bash", "--strict-mcp-config", "--disable-slash-commands", "--setting-sources", ""]

interface WhenOptions {
  every?: string
  at?: string
  atTime?: string
  notifyOn?: Notify
  deliverTo?: string[]
}

const whenOf = ({ every, at, atTime }: WhenOptions, minimum: number): When => {
  if ([every ?? at, atTime].filter(Boolean).length !== 1) {
    throw new CliError(
      "validation_error",
      "say when: --every <30m|2h|1d>, --at HH:MM (daily), or --at-time <30m|2d|ISO time>",
    )
  }
  if (atTime) {
    const time = aheadOf(atTime, "--at-time")
    if (time <= Date.now()) throw new CliError("validation_error", "--at-time is in the past")
    return { once: new Date(time).toISOString() }
  }
  if (at) {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(at)) throw new CliError("validation_error", `--at takes HH:MM, not "${at}"`)
    if (every && parseDuration(every, "--every") !== 86_400_000) {
      throw new CliError("validation_error", "--at runs once a day; leave out --every, or use --every 1d")
    }
    return { daily: at }
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
    .option("--at <HH:MM>", "every day at this local time")
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
      const model = config[`schedule_model_${harness}`]
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
  (env: NodeJS.ProcessEnv): StoredTemplates =>
  async (kind, language) => {
    const path = storePath(env)
    if (!existsSync(path)) return {}
    const database = await openCache(path)
    try {
      const bodies = storedTemplateBodies(database, reportKeyOf(kind), language)
      return Object.fromEntries(
        REPORT_CHANNELS.flatMap((channel) => (channel in bodies ? [[channel, bodies[channel]]] : [])),
      )
    } finally {
      database.close()
    }
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
    const state = resolvePaths({ appName: app.appName, prefix: app.envPrefix, env: context.env }).state
    const say = (value: object, lines: string[]) => renderAnswer(self, context, itemOf(value), () => lines.join("\n"))
    const timer = () => timerFor(app, system, context.env)
    // The command line refuses a schedule under the lock; a caller that gets here still passes the lock on.
    const readOnly = readOnlyLockOf(app, context.env)
    const environment = (): Record<string, string> => ({
      [`${app.envPrefix}_PROFILE`]: context.profile,
      ...locationVariables(app, context.env),
      // The timer starts with almost no PATH; an agent runs `max` and its own tools by name.
      ...(context.env.PATH ? { PATH: context.env.PATH } : {}),
      ...(readOnly ? { [readOnly]: "1" } : {}),
    })
    const save = async (schedule: Schedule) => {
      const file = scheduleFile(state, schedule.name)
      const replaced = existsSync(file)
      if (replaced) {
        const owner = readSchedule(file).environment[`${app.envPrefix}_PROFILE`]
        if (owner && owner !== context.profile) {
          throw new CliError(
            "validation_error",
            `schedule ${schedule.name} already runs for profile ${owner}; name this one for ${context.profile}, e.g. ${schedule.name}-${context.profile}`,
          )
        }
      }
      writeSecurely(file, `${JSON.stringify(schedule, null, 2)}\n`, 0o600)
      await timer().install(schedule, [...system.entry, "schedule", "exec", file])
      say(scheduleAnswer(schedule, { file, timer: timer().where(schedule.name), replaced }), [
        `${replaced ? "Replaced" : "Added"} ${schedule.name}: ${describeWhen(schedule.when)}.`,
        `It runs: ${schedule.kind === "agent" ? shown(schedule.argv) : `${app.command} ${shown(schedule.argv)}`}`,
        `Output: ${join(dirname(file), "runs")} · now: ${lineOf(self, `schedule run ${schedule.name}`)} · stop: ${lineOf(self, `schedule remove ${schedule.name}`)}`,
      ])
    }
    return { context, system, state, say, timer, environment, save }
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
  const waits = async (
    self: Command,
    file: string,
    { timed }: { timed: boolean },
  ): Promise<{ why: string; reason: SkipReason } | undefined> => {
    if (!existsSync(file)) return undefined
    const schedule = readSchedule(file)
    const { mailWaitMinutes, mailBatch, maxCostPerDay } = limitsOf(self, schedule)
    if (schedule.kind === "agent" && maxCostPerDay > 0) {
      const spent = spentToday(file)
      if (spent >= maxCostPerDay) {
        const why = `today's runs cost ${usd(spent)}, the ${usd(maxCostPerDay)} a day allowed; it runs again tomorrow`
        recordSkip(file, why, SKIP_REASONS.costDayCap)
        return { why, reason: SKIP_REASONS.costDayCap }
      }
    }
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
        `start an agent (claude or codex) with a prompt on a timer; it runs with ${agentClis.map((one) => `${one.envPrefix}_READ_ONLY=1`).join(" and ")}, so it reads and drafts and cannot send — its answer is kept and you are notified`,
      )
      .argument("<name>", "lowercase letters, digits and dashes")
      .addArgument(new Argument("<harness>", "the agent to start").choices(HARNESSES))
      .argument("<prompt>", `what to do, e.g. "${promptExample(app)}"`)
      .option(
        "--model <model>",
        `the model it runs on: an alias such as sonnet, or a model id; "" for the harness's default (default sonnet for claude, codex's own for codex, or the config file's)`,
      )
      .addOption(
        new Option("--max-cost <usd>", "claude only: stop a run that costs more than this, in US dollars").argParser(
          Number,
        ),
      )
      .addOption(
        new Option(
          "--max-cost-per-day <usd>",
          `claude only: start no run for the rest of the day once its runs cost this much, in US dollars; 0 for no cap (default ${SCHEDULE_DEFAULTS.maxCostPerDay}, or the config file's)`,
        ).argParser(Number),
      ),
  ).action(async function (this: Command, name: string, harness: Harness, prompt: string) {
    const { context, system, environment, save } = prepare(this)
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
    const mailBatch = options.mailBatch === undefined ? undefined : Number(options.mailBatch)
    if (mailBatch !== undefined && !(Number.isSafeInteger(mailBatch) && mailBatch >= 1))
      throw new CliError("validation_error", "--mail-batch takes a count of emails, 1 or more")
    const mailWaitMinutes =
      options.mailWait === undefined ? undefined : Math.ceil(parseDuration(options.mailWait, "--mail-wait") / 60_000)
    if (options.model !== undefined && !isModel(options.model))
      throw new CliError(
        "validation_error",
        `--model takes an alias such as sonnet or a model id, not "${options.model}"`,
      )
    const settings = configured?.(this) ?? {}
    const model = options.model ?? settings.models?.[harness] ?? AGENT_MODELS[harness]
    const modelFlag = model ? ["--model", model] : []
    const program = findProgram(harness, context.env, system.platform)
    if (!program) throw new CliError("not_found", `${harness} is not on PATH`)
    const folders = agentClis.flatMap((one) => {
      const paths = resolvePaths({ appName: one.appName, prefix: one.envPrefix, env: context.env })
      return [paths.state, paths.config, paths.cache]
    })
    const argv =
      harness === "claude"
        ? [
            program,
            "-p",
            prompt,
            // The owner's own settings may let every tool run (bypassPermissions); here only the CLI may.
            "--permission-mode",
            "dontAsk",
            "--allowedTools",
            ...agentClis.map((one) => `Bash(${one.command}:*)`),
            "--no-session-persistence",
            ...modelFlag,
            ...((settings.leanStart ?? true) ? LEAN_CLAUDE : []),
            ...(options.maxCost ? ["--max-budget-usd", String(options.maxCost)] : []),
          ]
        : [
            program,
            "exec",
            "--skip-git-repo-check",
            "--ephemeral",
            "--sandbox",
            "workspace-write",
            // The CLIs reach their provider and write the store and their own state, and nothing else.
            "-c",
            "sandbox_workspace_write.network_access=true",
            ...modelFlag,
            ...[dirname(storePath(context.env)), ...folders].flatMap((dir) => ["--add-dir", dir]),
            prompt,
          ]
    await save({
      name: scheduleName(name),
      kind: "agent",
      argv,
      when: whenOf(options, options.onNewMail ? GATED_AGENT_MINIMUM_MINUTES : AGENT_MINIMUM_MINUTES),
      environment: environment(),
      createdAt: new Date().toISOString(),
      ...(options.onNewMail ? { onNewMail: options.onNewMail } : {}),
      ...(mailWaitMinutes === undefined ? {} : { mailWaitMinutes }),
      ...(mailBatch === undefined ? {} : { mailBatch }),
      ...(options.maxCostPerDay === undefined ? {} : { maxCostPerDay: options.maxCostPerDay }),
      ...deliveryOf(options),
    })
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
        notify: notifyOf(schedule),
        ...(schedule.to?.length ? { deliverTo: schedule.to } : {}),
        last: lastRun(scheduleFile(state, schedule.name)) ?? null,
        ...(schedule.kind === "agent"
          ? {
              spentTodayUsd: spentToday(scheduleFile(state, schedule.name)),
              maxCostUsd: runCapOf(schedule.argv),
              maxCostPerDayUsd: limitsOf(this, schedule).maxCostPerDay,
            }
          : {}),
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
          .map(({ name, kind, when, notify, deliverTo, last, spentTodayUsd, maxCostPerDayUsd }) =>
            [
              name,
              kind,
              when,
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

  annotate(command.command("run"), {
    effects: REMOTE_WRITE,
    examples: [`${app.command} personal schedule run health`],
  })
    .description("run a schedule now, as its timer would, and wait for it")
    .argument("<name>", "the schedule's name, as `schedule list` shows it")
    .action(async function (this: Command, name: string) {
      const { context, system, state, say, timer } = prepare(this)
      const skip = await waits(this, scheduleFile(state, scheduleName(name)), { timed: false })
      if (skip !== undefined) {
        return say({ name, skipped: true, why: skip.why, reason: skip.reason }, [`${name}: skipped — ${skip.why}`])
      }
      const last = await untilChildEnds(this, (signal) =>
        runSchedule(app, system, context.env, scheduleFile(state, scheduleName(name)), {
          timer: timer(),
          agentRuns,
          ownerLanguage: ownerLanguageOf,
          reportTemplates: reportTemplatesOf,
          ...(agentInput ? { agentInput } : {}),
          ...(signal ? { signal } : {}),
        }),
      )
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
      const { state, say, timer } = prepare(this)
      const file = scheduleFile(state, scheduleName(name))
      if (!existsSync(file))
        throw new CliError("not_found", `no schedule ${name} — \`${lineOf(this, "schedule list")}\``)
      await timer().remove(name)
      rmSync(file, { force: true })
      say({ name, removed: true }, [`Removed ${name}.`])
    })

  annotate(command.command("exec"), {
    effects: REMOTE_WRITE,
    examples: [`${app.command} schedule exec ~/.local/share/${app.appName}/schedules/health/schedule.json`],
  })
    .description("what a timer runs, given the schedule's file; to run one by hand, use run")
    .argument("<file>", "the schedule's schedule.json in the state folder, as the timer passes it")
    .action(async function (this: Command, file: string) {
      // A timer starts it with no profile named; the schedule's own environment carries the profile.
      const { context, system, timer } = prepare(this, { needsProfile: false })
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
