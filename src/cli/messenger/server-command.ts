import { existsSync, rmSync } from "node:fs"
import { join } from "node:path"
import { CliError, EXIT_CODES, exitCodeFor, resolvePaths, writeSecurely } from "@wirecat/cli-base"
import { annotate } from "@wirecat/cli-base/commands"
import type { NextStep } from "@wirecat/cli-base/standards"
import { Command } from "commander"
import { lockPath, readLock } from "../../background/lock.js"
import { alive, carries } from "../../background/processes.js"
import { type ServerSystem, thisMachine } from "../../background/system.js"
import { locationVariables, platformFor, readableLog, tail, type Unit } from "../../background/units.js"
import { parseDuration } from "../../domain/duration.js"
import type { AppIdentity } from "../../ports/app.js"
import { FloodMemory, floodPathFor } from "../../sends/flood.js"
import { type BaseEnvironment, environmentOf } from "../context.js"
import { grantsAuthority, LOCAL_READ, LOCAL_WRITE } from "../effects.js"
import { itemOf, renderAnswer, snakeKeys } from "../envelope.js"
import { nextStep } from "../steps.js"
import { wholeList } from "./chat-answers.js"
import { type Messenger, type MessengerContext, messengerContext } from "./context.js"

export type { Ran, ServerSystem } from "../../background/system.js"

export const followUpsPrompt = (command: string) =>
  `Run the daily follow-up review: read \`${command} skill show follow-ups\` and follow it. Draft replies; never send.`

/** How many looks, a pause apart, `start` gives `serve` to connect — about 30 seconds on a real machine. */
const LOOKS = 120

type By = "unit" | "server" | "hand" | "command"

/** A running server, as its CLI can tell. */
export interface Running {
  pid: number
  startedAt: string
  connected: boolean
  connectedAt?: string
  version?: string
  /** The server says a command that needed it started it (max); `start` takes its place. */
  byCommand?: boolean
}

/** How a CLI finds, starts and stops its server. Without one, `server` uses tg's: the lock file and a signal. */
export interface ServerProcess {
  probe: () => Promise<Running | undefined>
  /** Starts `serve` apart from this process with `args` and the variables in `env` added; its PID. Throws when it cannot start now. */
  launch: (args: string[], env: Record<string, string>) => number
  /** Asks it to stop; `server` then waits for its PID to be gone. */
  stop: (running: Running) => Promise<void>
}

export interface ServerOptions {
  process?: (context: MessengerContext, system: ServerSystem, logPath: string) => ServerProcess
  /** Where a server started without a unit writes its log. tg's: `<state>/serve/<profile>.log`. */
  logPath?: (context: MessengerContext) => string
  /** The words after the CLI's own entry that run `serve` in the foreground — what a unit runs. */
  serveArgv?: string[]
  /** `start` and `restart` take `--idle <duration>` and hand it to `serve`. */
  idle?: boolean
  unit?: Pick<Unit, "purpose" | "noRestartOn">
}

/** A person reads paths under their home as `~/…`. */
const tilde = (path: string, env: NodeJS.ProcessEnv) =>
  env.HOME && path.startsWith(`${env.HOME}/`) ? `~${path.slice(env.HOME.length)}` : path

/** Local time, and the date too when it is not today. */
const clock = (iso: string) => {
  const when = new Date(iso)
  const time = when.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })
  return when.toDateString() === new Date().toDateString() ? time : `${when.toLocaleDateString("sv-SE")} ${time}`
}

const lockProcess =
  (app: AppIdentity, marker: string, serveArgv: string[]) =>
  (context: MessengerContext, system: ServerSystem, logPath: string): ServerProcess => ({
    probe: async () => {
      const held = readLock(lockPath(app, context.profile, context.env))
      if (!held || !alive(held.pid)) return undefined
      return {
        pid: held.pid,
        startedAt: held.startedAt,
        connected: held.listeningAt !== undefined,
        ...(held.listeningAt ? { connectedAt: held.listeningAt } : {}),
        ...(held.version ? { version: held.version } : {}),
      }
    },
    launch: (args, env) => {
      // A shell's --timeout default would end a server meant to outlive the shell.
      const { [`${app.envPrefix}_TIMEOUT`]: _timeout, ...inherited } = context.env
      return system.spawn(
        [...serveArgv, ...args],
        { ...inherited, [`${app.envPrefix}_PROFILE`]: context.profile, ...env },
        logPath,
      )
    },
    stop: async ({ pid }) => {
      if (!carries(pid, marker)) {
        throw new CliError(
          "validation_error",
          `serve for profile ${context.profile} (PID ${pid}) was not started by \`${app.command} server start\` — stop it where it runs`,
        )
      }
      process.kill(pid, "SIGTERM")
    },
  })

/**
 * `serve` in the background: `start`, `stop`, `restart`, `status`, `logs`. Without a unit, `start`
 * runs `serve` as a process of its own; with one — `install`, a systemd user unit or a launchd
 * agent — it goes through systemd or launchd. **Nothing starts until `start` is typed** (NEED-9):
 * `install` only writes the file. What the server does stays each CLI's; `options.process` says how
 * to find, start and stop it.
 */
export const serverCommand = (messenger: Messenger, options: ServerOptions = {}): Command => {
  const { app } = messenger
  const command = annotate(new Command("server"), { mcp: false }).description(
    `\`${app.command} serve\` in the background: start, stop, restart, status, logs; install adds a systemd or launchd unit`,
  )
  const marker = (profile: string) => `${app.envPrefix}_SERVER=${profile}`
  const serveArgv = options.serveArgv ?? ["serve"]

  const prepare = (self: Command) => {
    const context = messengerContext(self, messenger)
    const system = environmentOf<BaseEnvironment & { system?: ServerSystem }>(self).system ?? thisMachine()
    const platform = platformFor(app, system, context.env)
    const state = resolvePaths({ appName: app.appName, prefix: app.envPrefix, env: context.env }).state
    const logPath = options.logPath?.(context) ?? join(state, "serve", `${context.profile}.log`)
    const unit = platform.unit({
      profile: context.profile,
      command: [...system.entry, ...serveArgv],
      environment: { [`${app.envPrefix}_PROFILE`]: context.profile, ...locationVariables(app, context.env) },
      logPath,
      ...options.unit,
    })
    const server = (options.process ?? lockProcess(app, marker(context.profile), serveArgv))(context, system, logPath)
    const each = async (argvs: string[][]) => {
      for (const argv of argvs) {
        const ran = await system.run(argv, context.env)
        if (ran.code !== 0) throw new CliError("configuration_error", `${argv.join(" ")} failed: ${ran.stderr.trim()}`)
      }
    }
    const say = (value: object, lines: string[], next: NextStep[] = []) =>
      renderAnswer(self, context, itemOf(snakeKeys(value), { next }), () => lines.join("\n"))
    return { context, system, platform, unit, server, each, say }
  }
  type Prepared = ReturnType<typeof prepare>

  const installed = (unit: Unit) => {
    if (!existsSync(unit.path)) {
      throw new CliError(
        "not_found",
        `no unit for profile ${unit.profile} — \`${app.command} server install\` writes it`,
      )
    }
  }

  const byOf = async ({ platform, unit }: Prepared, running: Running): Promise<By> => {
    if (existsSync(unit.path) && (await platform.state(unit)).pid === running.pid) return "unit"
    if (running.byCommand) return "command"
    return carries(running.pid, marker(unit.profile)) ? "server" : "hand"
  }

  const how = (by: By, unit: Unit) =>
    by === "unit"
      ? `under ${unit.path.endsWith(".plist") ? "launchd" : "systemd"} (${unit.name})`
      : by === "server"
        ? `started by \`${app.command} server start\``
        : by === "command"
          ? `started by a ${app.command} command that needed it — it stops once unused`
          : `started by hand — \`${app.command} server stop\` leaves it alone`

  const start = async (prepared: Prepared, args: string[]) => {
    const { system, platform, unit, server, each, say } = prepared
    const before = await server.probe()
    if (before && !before.byCommand) {
      say({ profile: unit.profile, started: false, running: true, pid: before.pid, startedAt: before.startedAt }, [
        `Already serving profile ${unit.profile} since ${clock(before.startedAt)} (PID ${before.pid}).`,
      ])
      return
    }
    let by: By
    let spawned: number | undefined
    if (existsSync(unit.path)) {
      await each(platform.start(unit))
      by = "unit"
    } else {
      const [name = "", value = ""] = marker(unit.profile).split("=")
      spawned = server.launch(args, { [name]: value })
      by = "server"
    }
    for (let look = 0; look < LOOKS; look++) {
      const now = await server.probe()
      // A server a command started answers until the new one takes its place.
      if (now?.connected && now.pid !== before?.pid) {
        say(
          {
            profile: unit.profile,
            started: true,
            by,
            pid: now.pid,
            startedAt: now.startedAt,
            ...(now.connectedAt ? { connectedAt: now.connectedAt } : {}),
            log: unit.logPath,
          },
          [
            `Started: serving profile ${unit.profile} (PID ${now.pid}), connected${now.connectedAt ? ` since ${clock(now.connectedAt)}` : ""}, ${how(by, unit)}.`,
            `Its log: ${app.command} server logs`,
          ],
        )
        return
      }
      const gone = spawned !== undefined ? !alive(spawned) : look > 8 && !(await platform.state(unit)).active
      if (gone) {
        const last = readableLog(by === "unit" ? await platform.logs(unit, 5) : tail(unit.logPath, 5)).trim()
        throw new CliError("provider_unavailable", `serve stopped before it was connected${last ? `:\n${last}` : ""}`)
      }
      await system.pause()
    }
    throw new CliError(
      "timeout",
      `serve is running but not connected yet — \`${app.command} server status\`, \`${app.command} server logs\``,
    )
  }

  const stop = async (prepared: Prepared) => {
    const { platform, unit, server, each, say, system } = prepared
    if (existsSync(unit.path) && (await platform.state(unit)).active) {
      await each(platform.stop(unit))
      say({ profile: unit.profile, stopped: true, by: "unit" }, [`Stopped ${unit.name}.`])
      return
    }
    const running = await server.probe()
    if (!running) {
      say({ profile: unit.profile, stopped: false }, [`Nothing to stop: profile ${unit.profile} is not being served.`])
      return
    }
    const by = await byOf(prepared, running)
    await server.stop(running)
    for (let look = 0; look < LOOKS && alive(running.pid); look++) await system.pause()
    say({ profile: unit.profile, stopped: true, by, pid: running.pid }, [
      `Stopped serving profile ${unit.profile} (PID ${running.pid}).`,
    ])
  }

  const idleArgs = (self: Command): string[] => {
    const { idle } = self.opts<{ idle?: string }>()
    if (idle === undefined) return []
    parseDuration(idle, "--idle")
    return ["--idle", idle]
  }
  const withIdle = (sub: Command) =>
    options.idle ? sub.option("--idle <duration>", "stop after this long with nobody using it — 15m, 1h") : sub

  withIdle(
    annotate(command.command("start"), { effects: LOCAL_WRITE }).description(
      "start serve in the background — through the unit if one is installed — and answer once it connects",
    ),
  ).action(async function (this: Command) {
    await start(prepare(this), idleArgs(this))
  })

  annotate(command.command("stop"), { effects: LOCAL_WRITE })
    .description("stop this profile's serve — through the unit if it runs under one")
    .action(async function (this: Command) {
      await stop(prepare(this))
    })

  withIdle(
    annotate(command.command("restart"), { effects: LOCAL_WRITE }).description("stop it and start it again"),
  ).action(async function (this: Command) {
    const args = idleArgs(this)
    const prepared = prepare(this)
    await stop({ ...prepared, say: () => {} })
    await start(prepared, args)
  })

  annotate(command.command("status"), { effects: LOCAL_READ })
    .description("whether serve runs for this profile, since when, who started it, and the unit if there is one")
    .action(async function (this: Command) {
      const prepared = prepare(this)
      const { context, platform, unit, server, say } = prepared
      const isInstalled = existsSync(unit.path)
      const state = isInstalled ? await platform.state(unit) : { loaded: false, active: false }
      const held = await server.probe()
      const by = held ? await byOf(prepared, held) : null
      const left = held ? undefined : readLock(lockPath(app, unit.profile, context.env))
      // An update leaves a running serve on the old code.
      const outdated = held?.version !== undefined && held.version !== app.version
      const gaveUp =
        !held && !state.active && state.exitCode !== undefined && unit.noRestartOn?.includes(state.exitCode)
          ? state.exitCode
          : undefined
      const gaveUpReason =
        gaveUp === undefined ? undefined : Object.entries(EXIT_CODES).find(([, code]) => code === gaveUp)?.[0]
      const flood = new FloodMemory(floodPathFor(app, unit.profile, context.env)).read()
      const unitLine = isInstalled
        ? `Unit: ${tilde(unit.path, context.env)} — ${state.detail ?? (state.active ? "active" : "inactive")}.`
        : `No unit installed — \`${app.command} server install\` adds one, for starting under systemd or launchd.`
      say(
        {
          profile: unit.profile,
          running: held !== undefined,
          ...(held
            ? {
                pid: held.pid,
                startedAt: held.startedAt,
                connected: held.connected,
                ...(held.connectedAt ? { connectedAt: held.connectedAt } : {}),
                by,
              }
            : {}),
          ...(held?.version ? { version: held.version } : {}),
          cliVersion: app.version,
          log: isInstalled && unit.path.endsWith(".service") ? `journalctl --user -u ${unit.name}` : unit.logPath,
          ...(left ? { stale: { pid: left.pid, startedAt: left.startedAt } } : {}),
          ...(gaveUp !== undefined
            ? { stopped: { exitCode: gaveUp, reason: gaveUpReason ?? null, restarts: false } }
            : {}),
          unit: { name: unit.name, path: unit.path, installed: isInstalled, ...state },
          flood: { deadlines: flood.deadlines, sendBlock: flood.sendBlock ?? null },
        },
        [
          held
            ? held.connected
              ? `Serving profile ${unit.profile} since ${clock(held.startedAt)} (PID ${held.pid}), connected${held.connectedAt ? ` since ${clock(held.connectedAt)}` : ""}, ${how(by ?? "hand", unit)}.`
              : `Starting profile ${unit.profile} since ${clock(held.startedAt)} (PID ${held.pid}) — not connected yet, ${how(by ?? "hand", unit)}.`
            : `Not serving profile ${unit.profile}.${isInstalled && gaveUp === undefined && state.detail?.startsWith("failed") ? ` The unit failed — \`${app.command} server logs\`.` : ""}`,
          ...(gaveUp === exitCodeFor("authentication_error")
            ? [
                `It stopped because the login is no longer valid, and it will not restart by itself — \`${app.command} session start\`, then \`${app.command} server start\`.`,
              ]
            : gaveUp !== undefined
              ? [
                  `It stopped with ${gaveUpReason ?? `exit code ${gaveUp}`}, which a restart would not fix, so it will not restart by itself — \`${app.command} server logs\`, then \`${app.command} server start\`.`,
                ]
              : []),
          ...(left
            ? [
                `A serve that started ${clock(left.startedAt)} (PID ${left.pid}) is gone and left its lock — the next start takes it over.`,
              ]
            : []),
          unitLine,
          ...(flood.sendBlock
            ? [`Writes are held until ${clock(flood.sendBlock.until)}: ${flood.sendBlock.hint}.`]
            : []),
          ...flood.deadlines.map(
            (one) =>
              `Asked to wait before ${one.operation}${one.chatId ? ` in chat ${one.chatId}` : ""} until ${clock(one.until)}.`,
          ),
        ],
        outdated ? [nextStep("server.restart", { args: {} })] : [],
      )
    })

  annotate(command.command("logs"), { effects: LOCAL_READ })
    .description("serve's latest log lines — from the journal under systemd, else its log file")
    .option("-n, --limit <n>", "how many lines", (value) => wholeNumber(value), 50)
    .action(async function (this: Command) {
      const { limit: lines } = this.opts<{ limit: number }>()
      const { context, platform, unit } = prepare(this)
      const text = existsSync(unit.path) ? await platform.logs(unit, lines) : tail(unit.logPath, lines)
      if (!text) context.renderer.note(`no log yet for profile ${unit.profile}`)
      renderAnswer(this, context, wholeList("server logs", text.split("\n").filter(Boolean)), () =>
        text ? readableLog(text.replace(/\n$/, "")) : "",
      )
    })

  grantsAuthority(annotate(command.command("install"), { effects: LOCAL_WRITE }))
    .description("write a systemd user unit or a launchd agent for this profile; starts nothing")
    .action(function (this: Command) {
      const { context, platform, unit, say } = prepare(this)
      const replaced = existsSync(unit.path)
      writeSecurely(unit.path, platform.text(unit, app), 0o644)
      platform.prepare?.(unit)
      say({ profile: unit.profile, unit: unit.name, path: unit.path, command: unit.command, replaced }, [
        `${replaced ? "Rewrote" : "Wrote"} ${tilde(unit.path, context.env)} — nothing started.`,
        `It runs: ${unit.command.map((word) => tilde(word, context.env)).join(" ")}`,
        `Start it now: ${app.command} server start · ${platform.atLogin(unit)}`,
        // Suggested, never turned on: an agent reading chats every morning is the owner's choice (NEED-161).
        `A daily follow-up review is off. To turn it on: ${app.command} schedule agent follow-ups claude "${followUpsPrompt(app.command)}" --at 08:30`,
      ])
    })

  grantsAuthority(annotate(command.command("uninstall"), { effects: LOCAL_WRITE }))
    .description("remove this profile's unit; stop it first")
    .action(async function (this: Command) {
      const { context, platform, unit, say } = prepare(this)
      installed(unit)
      if ((await platform.state(unit)).active) {
        throw new CliError("validation_error", `the unit is running — \`${app.command} server stop\` first`)
      }
      rmSync(unit.path, { force: true })
      say({ profile: unit.profile, unit: unit.name, path: unit.path, removed: true }, [
        `Removed ${tilde(unit.path, context.env)}.`,
      ])
    })

  return command
}

const wholeNumber = (value: string): number => {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1) throw new CliError("validation_error", `"${value}" is not a count`)
  return parsed
}
