import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { CliError } from "@wirecat/cli-base"
import type { AppIdentity } from "../cli/app.js"
import type { ServerSystem } from "./system.js"
import { keptOldStore } from "./wirecat-folder.js"

export interface Unit {
  profile: string
  /** What `systemctl` or `launchctl` call it. */
  name: string
  path: string
  logPath?: string
  /** What the unit runs, and the variables it runs with. */
  command: string[]
  environment: Record<string, string>
  /** What the server does, for `systemctl status` and the agent list. */
  purpose?: string
  /**
   * Exit codes that must not start it again — a refused login retried every 30 s is a login per
   * retry. launchd cannot leave out single codes, so with any of these its agent does not restart.
   */
  noRestartOn?: number[]
}

/**
 * Only the variables that say **where** the files are travel into the unit: a unit written from a
 * development checkout must open that checkout's session and store, never the owner's real ones.
 * Nothing that could hold a credential is copied.
 */
export const locationVariables = (app: AppIdentity, env: NodeJS.ProcessEnv): Record<string, string> => {
  const names = [
    ...["CONFIG_DIR", "STATE_DIR", "CACHE_DIR"].map((name) => `${app.envPrefix}_${name}`),
    "MESSAGING_STORE",
    "MESSAGING_STATE_DIR",
    "WIRECAT_STATE_DIR",
  ]
  const kept = (name: string) => name === "MESSAGING_STORE" && env[name] === keptOldStore()
  return Object.fromEntries(names.flatMap((name) => (env[name] === undefined || kept(name) ? [] : [[name, env[name]]])))
}

/**
 * A unit written with location variables runs another installation — a development checkout — so
 * its name says which: under the bare name, `server start` there drove the owner's real unit.
 */
export const unitScope = (app: AppIdentity, profile: string, env: NodeJS.ProcessEnv, separator = "-") => {
  const where = Object.entries(locationVariables(app, env)).sort(([a], [b]) => a.localeCompare(b))
  if (where.length === 0) return profile
  return `${profile}${separator}${createHash("sha256").update(JSON.stringify(where)).digest("hex").slice(0, 8)}`
}

export interface Platform {
  unit: (base: Omit<Unit, "name" | "path">) => Unit
  text: (unit: Unit, app: AppIdentity) => string
  start: (unit: Unit) => string[][]
  stop: (unit: Unit) => string[][]
  state: (unit: Unit) => Promise<{ loaded: boolean; active: boolean; pid?: number; detail?: string; exitCode?: number }>
  logs: (unit: Unit, lines: number) => Promise<string>
  /** What must exist before the unit first runs. */
  prepare?: (unit: Unit) => void
  /** How to have it start at every login too. */
  atLogin: (unit: Unit) => string
}

const home = (env: NodeJS.ProcessEnv): string => {
  if (!env.HOME) throw new CliError("configuration_error", "HOME is not set, so there is nowhere to put the unit")
  return env.HOME
}

/** `%` is a specifier in both; `$` is a variable only in `ExecStart=` — in `Environment=` it is itself. */
const systemdQuote = (value: string, { command = false } = {}) => {
  const quoted = value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%")
  return `"${command ? quoted.replaceAll("$", "$$$$") : quoted}"`
}

export const systemd = (app: AppIdentity, system: ServerSystem, env: NodeJS.ProcessEnv): Platform => {
  const folder = join(env.XDG_CONFIG_HOME ?? join(home(env), ".config"), "systemd", "user")
  const checked = async (argv: string[]) => {
    const ran = await system.run(argv, env)
    if (ran.code !== 0) throw new CliError("configuration_error", `${argv.join(" ")} failed: ${ran.stderr.trim()}`)
    return ran.stdout
  }
  return {
    unit: (base) => {
      const name = `${app.command}-serve-${unitScope(app, base.profile, base.environment)}.service`
      return { ...base, name, path: join(folder, name) }
    },
    text: (unit) =>
      [
        "[Unit]",
        `Description=${app.command} serve — ${unit.purpose ?? "keep the local message archive current"} (profile ${unit.profile})`,
        "",
        "[Service]",
        `ExecStart=${unit.command.map((word) => systemdQuote(word, { command: true })).join(" ")}`,
        ...Object.entries(unit.environment).map(([name, value]) => `Environment=${systemdQuote(`${name}=${value}`)}`),
        "Restart=on-failure",
        "RestartSec=30",
        ...(unit.noRestartOn?.length ? [`RestartPreventExitStatus=${unit.noRestartOn.join(" ")}`] : []),
        "",
        "[Install]",
        "WantedBy=default.target",
        "",
      ].join("\n"),
    start: (unit) => [
      ["systemctl", "--user", "daemon-reload"],
      ["systemctl", "--user", "start", unit.name],
    ],
    stop: (unit) => [["systemctl", "--user", "stop", unit.name]],
    state: async (unit) => {
      const ran = await system.run(
        [
          "systemctl",
          "--user",
          "show",
          unit.name,
          "-p",
          "LoadState",
          "-p",
          "ActiveState",
          "-p",
          "SubState",
          "-p",
          "MainPID",
          "-p",
          "ExecMainCode",
          "-p",
          "ExecMainStatus",
        ],
        env,
      )
      const fields = Object.fromEntries(
        ran.stdout
          .split("\n")
          .filter((line) => line.includes("="))
          .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
      )
      const pid = Number(fields.MainPID)
      // ExecMainStatus is the signal's number when the process was killed; 1 (CLD_EXITED) means it exited.
      const exitCode = fields.ExecMainCode === "1" ? Number(fields.ExecMainStatus) : 0
      return {
        loaded: fields.LoadState === "loaded",
        active: fields.ActiveState === "active",
        ...(pid > 0 ? { pid } : {}),
        ...(exitCode > 0 ? { exitCode } : {}),
        ...(fields.ActiveState ? { detail: `${fields.ActiveState} (${fields.SubState})` } : {}),
      }
    },
    logs: (unit, lines) => checked(["journalctl", "--user", "-u", unit.name, "-n", String(lines), "--no-pager"]),
    atLogin: (unit) => `at every login too: systemctl --user enable ${unit.name.replace(/\.service$/, "")}`,
  }
}

const xml = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")

export const launchd = (app: AppIdentity, system: ServerSystem, env: NodeJS.ProcessEnv): Platform => {
  const folder = join(home(env), "Library", "LaunchAgents")
  const domain = `gui/${system.uid}`
  return {
    unit: (base) => {
      const name = `${app.appName}.serve.${unitScope(app, base.profile, base.environment, ".")}`
      return { ...base, name, path: join(folder, `${name}.plist`) }
    },
    text: (unit) =>
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
        '<plist version="1.0">',
        "<dict>",
        `  <key>Label</key><string>${xml(unit.name)}</string>`,
        "  <key>ProgramArguments</key>",
        "  <array>",
        ...unit.command.map((word) => `    <string>${xml(word)}</string>`),
        "  </array>",
        "  <key>EnvironmentVariables</key>",
        "  <dict>",
        ...Object.entries(unit.environment).map(
          ([name, value]) => `    <key>${xml(name)}</key><string>${xml(value)}</string>`,
        ),
        "  </dict>",
        // launchd loads every agent here at login; disabled, it waits for `server start` to enable it.
        "  <key>Disabled</key><true/>",
        "  <key>RunAtLoad</key><true/>",
        ...(unit.noRestartOn?.length ? [] : ["  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>"]),
        "  <key>ThrottleInterval</key><integer>30</integer>",
        `  <key>StandardOutPath</key><string>${xml(unit.logPath ?? "")}</string>`,
        `  <key>StandardErrorPath</key><string>${xml(unit.logPath ?? "")}</string>`,
        "</dict>",
        "</plist>",
        "",
      ].join("\n"),
    // RunAtLoad makes loading the agent the start; `enable` overrides the file's Disabled until `disable`.
    start: (unit) => [
      ["launchctl", "enable", `${domain}/${unit.name}`],
      ["launchctl", "bootstrap", domain, unit.path],
    ],
    stop: (unit) => [
      ["launchctl", "bootout", `${domain}/${unit.name}`],
      ["launchctl", "disable", `${domain}/${unit.name}`],
    ],
    state: async (unit) => {
      const ran = await system.run(["launchctl", "print", `${domain}/${unit.name}`], env)
      if (ran.code !== 0) return { loaded: false, active: false }
      const state = /^\s*state = (.+)$/m.exec(ran.stdout)?.[1]?.trim()
      const pid = Number(/^\s*pid = (\d+)$/m.exec(ran.stdout)?.[1])
      const exitCode = Number(/^\s*last exit code = (\d+)/m.exec(ran.stdout)?.[1])
      return {
        loaded: true,
        active: state === "running",
        ...(pid > 0 ? { pid } : {}),
        ...(exitCode > 0 ? { exitCode } : {}),
        ...(state ? { detail: state } : {}),
      }
    },
    // launchd opens the log itself and does not create its folder.
    prepare: (unit) => {
      if (unit.logPath) mkdirSync(dirname(unit.logPath), { recursive: true, mode: 0o700 })
    },
    logs: async (unit, lines) => tail(unit.logPath, lines),
    atLogin: () => "from then on it also starts at every login, until `server stop`",
  }
}

/**
 * serve's log lines for a person: a log record as `time severity body`, anything else — a line from an
 * older serve, the summary it prints on stop — as it is. A journal's own prefix is kept.
 */
export const readableLog = (text: string): string =>
  text
    .split("\n")
    .map((line) => {
      const start = line.indexOf("{")
      if (start < 0) return line
      try {
        const record = JSON.parse(line.slice(start)) as { time?: unknown; severity?: unknown; body?: unknown }
        if (typeof record.time !== "string" || typeof record.severity !== "string" || typeof record.body !== "string")
          return line
        return `${line.slice(0, start)}${record.time} ${record.severity.padEnd(5)} ${record.body}`
      } catch {
        return line
      }
    })
    .join("\n")

export const tail = (path: string | undefined, lines: number): string =>
  path && existsSync(path) ? `${readFileSync(path, "utf8").split("\n").filter(Boolean).slice(-lines).join("\n")}\n` : ""

/** Where there is neither: `start` still runs serve in the background; only `install` needs one of them. */
export const noUnits = (app: AppIdentity, system: ServerSystem): Platform => {
  const refuse = (): never => {
    throw new CliError(
      "validation_error",
      `${app.command} server install knows systemd (Linux) and launchd (macOS), not ${system.platform} — \`${app.command} server start\` runs serve without a unit`,
    )
  }
  return {
    unit: (base) => ({ ...base, name: `${app.command}-serve-${base.profile}`, path: "" }),
    text: refuse,
    start: refuse,
    stop: refuse,
    state: async () => ({ loaded: false, active: false }),
    logs: async () => "",
    atLogin: () => "",
  }
}

export const platformFor = (app: AppIdentity, system: ServerSystem, env: NodeJS.ProcessEnv): Platform => {
  if (system.platform === "linux") return systemd(app, system, env)
  if (system.platform === "darwin") return launchd(app, system, env)
  return noUnits(app, system)
}
