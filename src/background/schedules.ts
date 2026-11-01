import { spawn } from "node:child_process"
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { CliError, errorCodes, writeSecurely } from "@wirecat/cli-base"
import { type AppIdentity, readOnlyLockOf } from "../ports/app.js"
import { recordLogFor } from "../runs/record-log.js"
import { childTrace } from "../runs/scope.js"
import type { ServerSystem } from "./system.js"

/** Minutes between runs, a daily local time, or one local moment. */
export type When = { every: number } | { daily: string } | { once: string }

export interface Schedule {
  name: string
  kind: "command" | "agent"
  /** What runs: for a command the CLI's own words after its name, for an agent the harness and its arguments. */
  argv: string[]
  when: When
  /** The variables the run gets on top of the timer's: the profile, where the files are, PATH. Never a credential. */
  environment: Record<string, string>
  createdAt: string
}

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
  /** The first failure of the failures in a row, so "failing since" survives every retry. */
  failingSince?: string
  /** Failed runs in a row; absent once a run succeeds. */
  failures?: number
}

const REASON_ID = /^[a-z0-9][a-z0-9.-]{0,79}$/

/**
 * Why a failed run failed, from the error object the CLI printed last: its code and reason id. Never the
 * message, which can name a chat or a person; the run's log keeps that. Any other line is another program's
 * text and is not kept either.
 */
export const failureOf = (stderr: string, exitCode: number): { reason: string; errorCode?: string } => {
  for (const line of stderr.split("\n").reverse()) {
    try {
      const { code, reason } = (JSON.parse(line) as { error?: { code?: unknown; reason?: unknown } }).error ?? {}
      if ((errorCodes as readonly unknown[]).includes(code) && typeof reason === "string" && REASON_ID.test(reason)) {
        return { reason: `${code} (${reason})`, errorCode: code as string }
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
  run: { at: string; exitCode: number; output: string; traceId?: string; reason?: string; errorCode?: string },
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

export const describeWhen = (when: When): string =>
  "every" in when
    ? `every ${when.every % 1440 === 0 ? `${when.every / 1440}d` : when.every % 60 === 0 ? `${when.every / 60}h` : `${when.every}m`}`
    : "daily" in when
      ? `daily at ${when.daily}`
      : `once at ${when.once}`

/** A local wall-clock time, as both systemd's `OnCalendar=` and PowerShell's parser take it. */
const localStamp = (iso: string) => {
  const at = new Date(iso)
  const two = (n: number) => String(n).padStart(2, "0")
  return `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())} ${two(at.getHours())}:${two(at.getMinutes())}:${two(at.getSeconds())}`
}

/** How one operating system starts `argv` at the schedule's times. Every timer runs the same thing: `<cli> schedule exec <file>`. */
export interface Timer {
  install: (schedule: Schedule, argv: string[]) => Promise<void>
  remove: (name: string) => Promise<void>
  /** Where the timer lives, for the owner to look at. */
  where: (name: string) => string
}

const systemdQuote = (value: string) =>
  `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%").replaceAll("$", "$$$$")}"`

const xml = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")

const checked = async (system: ServerSystem, env: NodeJS.ProcessEnv, argv: string[], allowFailure = false) => {
  const ran = await system.run(argv, env)
  if (ran.code !== 0 && !allowFailure) {
    throw new CliError("configuration_error", `${argv[0]} failed: ${(ran.stderr || ran.stdout).trim()}`)
  }
  return ran
}

export const systemdTimer = (app: AppIdentity, system: ServerSystem, env: NodeJS.ProcessEnv, home: string): Timer => {
  const folder = join(env.XDG_CONFIG_HOME ?? join(home, ".config"), "systemd", "user")
  const unit = (name: string) => `${app.command}-schedule-${name}`
  return {
    where: (name) => join(folder, `${unit(name)}.timer`),
    install: async (schedule, argv) => {
      const { when } = schedule
      writeSecurely(
        join(folder, `${unit(schedule.name)}.service`),
        [
          "[Unit]",
          `Description=${app.command} schedule ${schedule.name}`,
          "",
          "[Service]",
          "Type=oneshot",
          `ExecStart=${argv.map(systemdQuote).join(" ")}`,
          "",
        ].join("\n"),
        0o644,
      )
      writeSecurely(
        join(folder, `${unit(schedule.name)}.timer`),
        [
          "[Unit]",
          `Description=${app.command} schedule ${schedule.name} — ${describeWhen(when)}`,
          "",
          "[Timer]",
          ...("every" in when
            ? // From when a run ends: counted from its start, a run longer than the interval left no next run.
              [`OnActiveSec=${when.every}min`, `OnUnitInactiveSec=${when.every}min`]
            : // Persistent: a run missed while the machine slept happens when it wakes.
              [`OnCalendar=${"daily" in when ? `*-*-* ${when.daily}:00` : localStamp(when.once)}`, "Persistent=true"]),
          "",
          "[Install]",
          "WantedBy=timers.target",
          "",
        ].join("\n"),
        0o644,
      )
      await checked(system, env, ["systemctl", "--user", "daemon-reload"])
      await checked(system, env, ["systemctl", "--user", "enable", "--now", `${unit(schedule.name)}.timer`])
    },
    remove: async (name) => {
      await checked(system, env, ["systemctl", "--user", "disable", "--now", `${unit(name)}.timer`], true)
      rmSync(join(folder, `${unit(name)}.timer`), { force: true })
      rmSync(join(folder, `${unit(name)}.service`), { force: true })
      await checked(system, env, ["systemctl", "--user", "daemon-reload"])
    },
  }
}

export const launchdTimer = (app: AppIdentity, system: ServerSystem, env: NodeJS.ProcessEnv, home: string): Timer => {
  const folder = join(home, "Library", "LaunchAgents")
  const label = (name: string) => `${app.appName}.schedule.${name}`
  const plist = (name: string) => join(folder, `${label(name)}.plist`)
  const domain = `gui/${system.uid}`
  const calendar = (when: When) => {
    if ("every" in when) return [`  <key>StartInterval</key><integer>${when.every * 60}</integer>`]
    const [hour, minute] = ("daily" in when ? when.daily : localStamp(when.once).slice(11, 16)).split(":").map(Number)
    const once = "once" in when ? new Date(when.once) : undefined
    return [
      "  <key>StartCalendarInterval</key>",
      "  <dict>",
      // launchd has no year: a one-off is a yearly date, and the run removes it.
      ...(once
        ? [
            `    <key>Month</key><integer>${once.getMonth() + 1}</integer>`,
            `    <key>Day</key><integer>${once.getDate()}</integer>`,
          ]
        : []),
      `    <key>Hour</key><integer>${hour}</integer>`,
      `    <key>Minute</key><integer>${minute}</integer>`,
      "  </dict>",
    ]
  }
  return {
    where: plist,
    install: async (schedule, argv) => {
      await checked(system, env, ["launchctl", "bootout", `${domain}/${label(schedule.name)}`], true)
      writeSecurely(
        plist(schedule.name),
        [
          '<?xml version="1.0" encoding="UTF-8"?>',
          '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
          '<plist version="1.0">',
          "<dict>",
          `  <key>Label</key><string>${xml(label(schedule.name))}</string>`,
          "  <key>ProgramArguments</key>",
          "  <array>",
          ...argv.map((word) => `    <string>${xml(word)}</string>`),
          "  </array>",
          ...calendar(schedule.when),
          "</dict>",
          "</plist>",
          "",
        ].join("\n"),
        0o644,
      )
      await checked(system, env, ["launchctl", "bootstrap", domain, plist(schedule.name)])
    },
    remove: async (name) => {
      await checked(system, env, ["launchctl", "bootout", `${domain}/${label(name)}`], true)
      rmSync(plist(name), { force: true })
    },
  }
}

/**
 * Task Scheduler through PowerShell's ScheduledTasks module. The values travel in variables, never in
 * the script, so nothing needs quoting for PowerShell; Windows has no per-task environment, which is why
 * the runner reads its variables from the schedule file.
 */
export const windowsTimer = (app: AppIdentity, system: ServerSystem, env: NodeJS.ProcessEnv): Timer => {
  const path = `\\${app.appName}\\`
  const powershell = (script: string, values: Record<string, string>, allowFailure = false) =>
    checked(
      system,
      { ...env, ...values },
      ["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      allowFailure,
    )
  return {
    where: (name) => `Task Scheduler ${path}${name}`,
    install: async (schedule, [exe = "", ...args]) => {
      const { when } = schedule
      await powershell(
        [
          "$ErrorActionPreference = 'Stop'",
          "$action = New-ScheduledTaskAction -Execute $env:WIRECAT_EXE -Argument $env:WIRECAT_ARGS",
          "$trigger = switch ($env:WIRECAT_KIND) {",
          "  'every' { New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes ([int]$env:WIRECAT_MINUTES)) }",
          "  'daily' { New-ScheduledTaskTrigger -Daily -At $env:WIRECAT_AT }",
          "  'once' { New-ScheduledTaskTrigger -Once -At ([datetime]::ParseExact($env:WIRECAT_AT, 'yyyy-MM-dd HH:mm:ss', $null)) }",
          "}",
          "$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew",
          "Register-ScheduledTask -TaskName $env:WIRECAT_NAME -TaskPath $env:WIRECAT_PATH -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null",
        ].join("\n"),
        {
          WIRECAT_EXE: exe,
          WIRECAT_ARGS: args.map((word) => `"${word.replaceAll('"', '\\"')}"`).join(" "),
          WIRECAT_KIND: "every" in when ? "every" : "daily" in when ? "daily" : "once",
          WIRECAT_MINUTES: "every" in when ? String(when.every) : "",
          WIRECAT_AT: "daily" in when ? when.daily : "once" in when ? localStamp(when.once) : "",
          WIRECAT_NAME: schedule.name,
          WIRECAT_PATH: path,
        },
      )
    },
    remove: async (name) => {
      await powershell(
        "Unregister-ScheduledTask -TaskName $env:WIRECAT_NAME -TaskPath $env:WIRECAT_PATH -Confirm:$false",
        { WIRECAT_NAME: name, WIRECAT_PATH: path },
        true,
      )
    },
  }
}

export const timerFor = (app: AppIdentity, system: ServerSystem, env: NodeJS.ProcessEnv): Timer => {
  if (system.platform === "win32") return windowsTimer(app, system, env)
  if (!env.HOME) throw new CliError("configuration_error", "HOME is not set, so there is nowhere to put the timer")
  if (system.platform === "linux") return systemdTimer(app, system, env, env.HOME)
  if (system.platform === "darwin") return launchdTimer(app, system, env, env.HOME)
  throw new CliError(
    "validation_error",
    `${app.command} schedule knows Linux, macOS and Windows, not ${system.platform}`,
  )
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
const KILL_AFTER_MS = 10_000

/**
 * One run: the command or the agent with the schedule's variables, its output kept beside the schedule,
 * the last result in `last.json`. An agent runs under `<PREFIX>_READ_ONLY`, so nothing it is talked
 * into can send. A one-off removes itself afterwards.
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
  }: { now?: () => Date; timer?: Timer; signal?: AbortSignal; killAfterMs?: number } = {},
): Promise<LastRun> => {
  const schedule = readSchedule(file)
  const folder = join(file, "..")
  const runs = join(folder, "runs")
  mkdirSync(runs, { recursive: true, mode: 0o700 })
  const stamp = now()
    .toISOString()
    .replaceAll(":", "-")
    .replace(/\.\d+Z$/, "Z")
  const agent = schedule.kind === "agent"
  const output = join(runs, `${stamp}.${agent ? "md" : "log"}`)
  const errors = agent ? join(runs, `${stamp}.log`) : output
  const [program = "", ...args] = agent ? schedule.argv : [...system.entry, ...schedule.argv]
  const trace = childTrace()
  const childEnv = {
    ...env,
    ...schedule.environment,
    TRACEPARENT: trace.traceparent,
    [`${app.envPrefix}_SCHEDULED`]: schedule.name,
    // A run started under the lock stays under it, whatever the schedule file says.
    ...(agent || readOnlyLockOf(app, env) ? { [`${app.envPrefix}_READ_ONLY`]: "1" } : {}),
  }
  // The child's output is data, and an agent's is another program's: it is kept as it came. These lines say
  // only when it ran and how it ended.
  const log = recordLogFor(join(runs, `${stamp}.jsonl`), app, { traceId: trace.traceId })
  const facts = { schedule: schedule.name, kind: schedule.kind }
  const began = now().getTime()
  log.info({ event: "schedule.start", ...facts })
  const exitCode = await new Promise<number>((resolve) => {
    const child = spawn(program, args, { env: childEnv, cwd: folder, stdio: ["ignore", "pipe", "pipe"] })
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
      writeFileSync(output, Buffer.concat(agent ? out : [...out, ...err]), { mode: 0o600 })
      if (agent) writeFileSync(errors, Buffer.concat(err), { mode: 0o600 })
      resolve(code ?? (killedBy === "SIGKILL" ? 137 : killedBy === "SIGTERM" ? 143 : 1))
    })
  })
  const ended = now()
  log[exitCode === 0 ? "info" : "error"]({
    event: "schedule.exit",
    ...facts,
    exitCode,
    durationMs: ended.getTime() - began,
  })
  const last = recordRun(join(folder, "last.json"), {
    at: ended.toISOString(),
    exitCode,
    output,
    traceId: trace.traceId,
    ...(exitCode === 0 ? {} : failureOf(readFileSync(errors, "utf8"), exitCode)),
  })
  if (agent && exitCode === 0) copyFileSync(output, join(folder, "latest.md"))

  const stampOf = (file: string) => file.split(".")[0] ?? file
  const kept = new Set([...new Set(readdirSync(runs).map(stampOf))].sort().slice(-KEEP_RUNS))
  for (const file of readdirSync(runs)) if (!kept.has(stampOf(file))) rmSync(join(runs, file), { force: true })

  const title = `${app.command} ${schedule.name}`
  if (agent && exitCode === 0) {
    const first =
      readFileSync(output, "utf8")
        .split("\n")
        .find((line) => line.trim()) ?? "report ready"
    await notify(system, env, title, `${first.trim().slice(0, 180)}\n${join(folder, "latest.md")}`)
  } else if (exitCode !== 0) {
    await notify(system, env, title, `failed (exit ${exitCode}) — ${errors}`)
  }

  if ("once" in schedule.when) {
    await timer?.remove(schedule.name)
    rmSync(file, { force: true })
  }
  return last
}
