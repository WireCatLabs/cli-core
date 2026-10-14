import { existsSync, rmSync } from "node:fs"
import { dirname, join } from "node:path"
import { CliError, resolvePaths, writeSecurely } from "@wirecat/cli-base"
import { Argument, Command, Option } from "commander"
import {
  describeWhen,
  findProgram,
  lastRun,
  listSchedules,
  runSchedule,
  type Schedule,
  scheduleFile,
  scheduleName,
  timerFor,
  type When,
} from "../../background/schedules.js"
import { type ServerSystem, thisMachine } from "../../background/system.js"
import { locationVariables } from "../../background/units.js"
import { aheadOf } from "../../services/moment.js"
import { storePath } from "../../store/path.js"
import { type BaseEnvironment, environmentOf } from "../context.js"
import { itemOf, listOf, renderAnswer, snakeKeys } from "../envelope.js"
import { parseDuration } from "../settings.js"
import { type Messenger, messengerContext } from "./context.js"

/** Each run of an agent is a paid model call that reads chats; keeping the store current is `serve`'s job. */
const AGENT_MINIMUM_MINUTES = 60
const COMMAND_MINIMUM_MINUTES = 1
const HARNESSES = ["claude", "codex"] as const
type Harness = (typeof HARNESSES)[number]

interface WhenOptions {
  every?: string
  at?: string
  once?: string
}

const whenOf = ({ every, at, once }: WhenOptions, minimum: number): When => {
  if ([every ?? at, once].filter(Boolean).length !== 1) {
    throw new CliError(
      "validation_error",
      "say when: --every <30m|2h|1d>, --at HH:MM (daily), or --once <30m|2d|ISO time>",
    )
  }
  if (once) {
    const time = aheadOf(once, "--once")
    if (time <= Date.now()) throw new CliError("validation_error", "--once is in the past")
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
const scheduleAnswer = ({ environment, createdAt, ...schedule }: Schedule, extra: object) => ({
  ...(snakeKeys(schedule) as object),
  environment,
  created_at: createdAt,
  ...(snakeKeys(extra) as object),
})

const withWhen = (command: Command) =>
  command
    .option("--every <duration>", "repeat: 30m, 2h, 1d")
    .option("--at <HH:MM>", "every day at this local time")
    .option("--once <when>", "one run: 30m, 2d from now, or an ISO time; the schedule removes itself after it")

/**
 * Runs the CLI's own commands, or an agent, later or on a timer — through systemd (Linux), launchd
 * (macOS) or Task Scheduler (Windows). Every timer runs `schedule exec <file>`; the schedule file holds
 * the rest, so what runs and with which variables is the same on all three.
 */
export const scheduleCommand = (messenger: Messenger): Command => {
  const { app } = messenger
  const command = new Command("schedule").description(
    `run a ${app.command} command or an agent later or on a timer (systemd, launchd, Task Scheduler); an agent cannot send`,
  )

  const prepare = (self: Command) => {
    const context = messengerContext(self, messenger)
    const system = environmentOf<BaseEnvironment & { system?: ServerSystem }>(self).system ?? thisMachine()
    const state = resolvePaths({ appName: app.appName, prefix: app.envPrefix, env: context.env }).state
    const say = (value: object, lines: string[]) => renderAnswer(self, context, itemOf(value), () => lines.join("\n"))
    const timer = () => timerFor(app, system, context.env)
    const environment = (): Record<string, string> => ({
      [`${app.envPrefix}_PROFILE`]: context.profile,
      ...locationVariables(app, context.env),
      // The timer starts with almost no PATH; an agent runs `max` and its own tools by name.
      ...(context.env.PATH ? { PATH: context.env.PATH } : {}),
    })
    const save = async (schedule: Schedule) => {
      const file = scheduleFile(state, schedule.name)
      const replaced = existsSync(file)
      writeSecurely(file, `${JSON.stringify(schedule, null, 2)}\n`, 0o600)
      await timer().install(schedule, [...system.entry, "schedule", "exec", file])
      say(scheduleAnswer(schedule, { file, timer: timer().where(schedule.name), replaced }), [
        `${replaced ? "Replaced" : "Added"} ${schedule.name}: ${describeWhen(schedule.when)}.`,
        `It runs: ${schedule.kind === "agent" ? schedule.argv.join(" ") : `${app.command} ${schedule.argv.join(" ")}`}`,
        `Output: ${join(dirname(file), "runs")} · now: ${app.command} schedule run ${schedule.name} · stop: ${app.command} schedule remove ${schedule.name}`,
      ])
    }
    return { context, system, state, say, timer, environment, save }
  }

  withWhen(
    command
      .command("command")
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
    })
  })

  withWhen(
    command
      .command("agent")
      .description(
        `start an agent (claude or codex) with a prompt on a timer; it runs with ${app.envPrefix}_READ_ONLY=1, so it reads and drafts and cannot send — its answer is kept and you are notified`,
      )
      .argument("<name>", "lowercase letters, digits and dashes")
      .addArgument(new Argument("<harness>", "the agent to start").choices(HARNESSES))
      .argument("<prompt>", `what to do, e.g. "run the daily follow-up review: ${app.command} skill show follow-ups"`)
      .addOption(
        new Option("--max-cost <usd>", "claude only: stop a run that costs more than this, in US dollars").argParser(
          Number,
        ),
      ),
  ).action(async function (this: Command, name: string, harness: Harness, prompt: string) {
    const { context, system, environment, save } = prepare(this)
    const options = this.opts<WhenOptions & { maxCost?: number }>()
    const program = findProgram(harness, context.env, system.platform)
    if (!program) throw new CliError("not_found", `${harness} is not on PATH`)
    const paths = resolvePaths({ appName: app.appName, prefix: app.envPrefix, env: context.env })
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
            `Bash(${app.command}:*)`,
            "--no-session-persistence",
            ...(options.maxCost ? ["--max-budget-usd", String(options.maxCost)] : []),
          ]
        : [
            program,
            "exec",
            "--skip-git-repo-check",
            "--ephemeral",
            "--sandbox",
            "workspace-write",
            // The CLI reaches the messenger and writes its store and state, and nothing else.
            "-c",
            "sandbox_workspace_write.network_access=true",
            ...[dirname(storePath(context.env)), paths.state, paths.config, paths.cache].flatMap((dir) => [
              "--add-dir",
              dir,
            ]),
            prompt,
          ]
    await save({
      name: scheduleName(name),
      kind: "agent",
      argv,
      when: whenOf(options, AGENT_MINIMUM_MINUTES),
      environment: environment(),
      createdAt: new Date().toISOString(),
    })
  })

  command
    .command("list")
    .description("the schedules, when they run and how their last run went")
    .action(function (this: Command) {
      const { context, state } = prepare(this)
      const rows = listSchedules(state).map((schedule) => ({
        name: schedule.name,
        kind: schedule.kind,
        when: describeWhen(schedule.when),
        last: lastRun(scheduleFile(state, schedule.name)) ?? null,
      }))
      const answer = listOf("schedule list", {
        items: rows.map((row) => snakeKeys(row)),
        limit: Math.max(1, rows.length),
        has_more: false,
      })
      renderAnswer(this, context, answer, () => {
        if (rows.length === 0) {
          context.renderer.note(`no schedules — \`${app.command} schedule command|agent\` adds one`)
          return ""
        }
        return rows
          .map(({ name, kind, when, last }) =>
            [
              name,
              kind,
              when,
              last
                ? `last ${last.at.slice(0, 16).replace("T", " ")} exit ${last.exitCode}` +
                  (last.failures
                    ? ` — failing since ${(last.failingSince ?? last.at).slice(0, 16).replace("T", " ")}, ` +
                      `${last.failures} in a row${last.reason ? `: ${last.reason}` : ""}`
                    : "")
                : "not run yet",
            ].join("  "),
          )
          .join("\n")
      })
    })

  command
    .command("run")
    .description("run a schedule now, as its timer would, and wait for it")
    .argument("<name>")
    .action(async function (this: Command, name: string) {
      const { context, system, state, say, timer } = prepare(this)
      const last = await runSchedule(app, system, context.env, scheduleFile(state, scheduleName(name)), {
        timer: timer(),
      })
      say(snakeKeys({ name, ...last }) as object, [`${name}: exit ${last.exitCode} — ${last.output}`])
      if (last.exitCode !== 0) process.exitCode = 1
    })

  command
    .command("remove")
    .description("stop a schedule and remove its timer; its past output stays")
    .argument("<name>")
    .action(async function (this: Command, name: string) {
      const { state, say, timer } = prepare(this)
      const file = scheduleFile(state, scheduleName(name))
      if (!existsSync(file)) throw new CliError("not_found", `no schedule ${name} — \`${app.command} schedule list\``)
      await timer().remove(name)
      rmSync(file, { force: true })
      say({ name, removed: true }, [`Removed ${name}.`])
    })

  command
    .command("exec")
    .description("what a timer runs, given the schedule's file; to run one by hand, use run")
    .argument("<file>")
    .action(async function (this: Command, file: string) {
      const { context, system, timer } = prepare(this)
      const last = await runSchedule(app, system, context.env, file, { timer: timer() })
      if (last.exitCode !== 0) process.exitCode = 1
    })

  return command
}
