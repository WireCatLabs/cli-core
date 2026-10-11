import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { captureStreams } from "@wirecat/cli-core"
import { describe, expect, it } from "vitest"
import { runSchedule, type Schedule, scheduleFile } from "../../background/schedules.js"
import type { Ran, ServerSystem } from "../../background/system.js"
import { run } from "../program.js"
import { settingsFor } from "../settings.js"
import type { Messenger } from "./context.js"
import type { MessengerAdapter } from "./port.js"
import { scheduleCommand } from "./schedule-command.js"

const app = { command: "chat", appName: "chat-cli", envPrefix: "CHAT", description: "A test", version: "1.0.0" }
const messenger: Messenger = {
  app,
  provider: "chat",
  resolveSettings: settingsFor(app).resolveSettings,
  connect: async () => ({}) as MessengerAdapter,
  chatArgument: "a chat",
}

const setup = () => {
  const root = mkdtempSync(join(tmpdir(), "schedule-"))
  const bin = join(root, "bin")
  mkdirSync(bin)
  for (const name of ["claude", "codex"]) {
    writeFileSync(join(bin, name), "#!/bin/sh\n")
    chmodSync(join(bin, name), 0o755)
  }
  const env = {
    HOME: join(root, "home"),
    XDG_CONFIG_HOME: join(root, "home", ".config"),
    CHAT_STATE_DIR: join(root, "state"),
    MESSAGING_STORE: join(root, "m.db"),
    CHAT_API_HASH: "never-in-a-schedule",
    PATH: bin,
  }
  return { root, env }
}

const machine = (platform: NodeJS.Platform, entry = ["/opt/node", "/opt/chat/bin/chat.js"]) => {
  const ran: { argv: string[]; env: NodeJS.ProcessEnv }[] = []
  const system: ServerSystem = {
    platform,
    uid: 501,
    entry,
    run: async (argv, env): Promise<Ran> => {
      ran.push({ argv, env })
      return { code: 0, stdout: "", stderr: "" }
    },
    spawn: () => 0,
    pause: async () => {},
  }
  return { system, ran }
}

const call = async (argv: string[], env: NodeJS.ProcessEnv, system: ServerSystem) => {
  const streams = captureStreams()
  const code = await run(
    ["schedule", ...argv],
    { app, commands: () => [scheduleCommand(messenger)] },
    { streams, env, system },
  )
  return { code, out: streams.stdout.join(""), err: streams.stderr.join("") }
}

// Unit text for Linux and macOS holds POSIX paths; on Windows the real timer is checked by schedules.os.test.ts.
const posix = process.platform !== "win32"

describe.runIf(posix)("schedule on Linux", () => {
  it("writes a oneshot service and a timer that run `schedule exec <file>`, lists it, and removes both", async () => {
    const { env } = setup()
    const { system, ran } = machine("linux")
    const added = await call(
      ["command", "sync", "--every", "15m", "--", "messages", "list", "42", "--limit", "50"],
      env,
      system,
    )
    expect(added.code).toBe(0)

    const file = scheduleFile(env.CHAT_STATE_DIR, "sync")
    const schedule = JSON.parse(readFileSync(file, "utf8")) as Schedule
    expect(schedule).toMatchObject({
      kind: "command",
      argv: ["messages", "list", "42", "--limit", "50"],
      when: { every: 15 },
    })
    expect(schedule.environment).toMatchObject({
      CHAT_PROFILE: "default",
      CHAT_STATE_DIR: env.CHAT_STATE_DIR,
      PATH: env.PATH,
    })
    expect(JSON.stringify(schedule)).not.toContain("never-in-a-schedule")

    const units = join(env.XDG_CONFIG_HOME, "systemd", "user")
    expect(readFileSync(join(units, "chat-schedule-sync.service"), "utf8")).toContain(
      `ExecStart="/opt/node" "/opt/chat/bin/chat.js" "schedule" "exec" "${file}"`,
    )
    expect(readFileSync(join(units, "chat-schedule-sync.timer"), "utf8")).toContain("OnUnitActiveSec=15min")
    expect(ran.map(({ argv }) => argv.join(" "))).toEqual([
      "systemctl --user daemon-reload",
      "systemctl --user enable --now chat-schedule-sync.timer",
    ])

    const listed = JSON.parse((await call(["list", "--json"], env, system)).out)
    expect(listed.items).toEqual([{ name: "sync", kind: "command", when: "every 15m", last: null }])

    expect((await call(["remove", "sync"], env, system)).code).toBe(0)
    expect(existsSync(join(units, "chat-schedule-sync.timer"))).toBe(false)
    expect(existsSync(file)).toBe(false)
  })

  it("puts a daily run on the calendar and catches up after sleep", async () => {
    const { env } = setup()
    await call(["command", "morning", "--at", "08:30", "--", "review", "--new"], env, machine("linux").system)
    const timer = readFileSync(join(env.XDG_CONFIG_HOME, "systemd", "user", "chat-schedule-morning.timer"), "utf8")
    expect(timer).toContain("OnCalendar=*-*-* 08:30:00")
    expect(timer).toContain("Persistent=true")
  })
})

describe.runIf(posix)("schedule agent", () => {
  it("starts claude by its full path with only the CLI's own commands allowed", async () => {
    const { env, root } = setup()
    const added = await call(
      ["agent", "follow-ups", "claude", "run the daily review", "--at", "08:30", "--max-cost", "2"],
      env,
      machine("linux").system,
    )
    expect(added.code).toBe(0)
    const schedule = JSON.parse(readFileSync(scheduleFile(env.CHAT_STATE_DIR, "follow-ups"), "utf8")) as Schedule
    expect(schedule.argv).toEqual([
      join(root, "bin", "claude"),
      "-p",
      "run the daily review",
      "--permission-mode",
      "dontAsk",
      "--allowedTools",
      "Bash(chat:*)",
      "--no-session-persistence",
      "--max-budget-usd",
      "2",
    ])
  })

  it("refuses to run an agent more often than hourly, and a harness that is not installed", async () => {
    const { env } = setup()
    const often = await call(["agent", "x", "claude", "p", "--every", "5m"], env, machine("linux").system)
    expect(often.code).not.toBe(0)
    expect(often.err).toContain("at least 60 minutes")
    const missing = await call(
      ["agent", "x", "codex", "p", "--at", "08:30"],
      { ...env, PATH: "/nowhere" },
      machine("linux").system,
    )
    expect(missing.err).toContain("codex is not on PATH")
  })

  it("on macOS writes a launch agent on the calendar", async () => {
    const { env } = setup()
    const { system, ran } = machine("darwin")
    await call(["agent", "follow-ups", "claude", "review", "--at", "08:30"], env, system)
    const plist = readFileSync(join(env.HOME, "Library", "LaunchAgents", "chat-cli.schedule.follow-ups.plist"), "utf8")
    expect(plist).toContain("<key>Hour</key><integer>8</integer>")
    expect(plist).toContain("<key>Minute</key><integer>30</integer>")
    expect(ran.at(-1)?.argv).toEqual(["launchctl", "bootstrap", "gui/501", expect.stringContaining("follow-ups.plist")])
  })
})

describe("schedule on Windows", () => {
  it("on Windows registers a scheduled task, its values in variables rather than in the script", async () => {
    const { env } = setup()
    const { system, ran } = machine("win32", ["C:\\node\\node.exe", "C:\\chat\\chat.js"])
    await call(["command", "sync", "--every", "2h", "--", "review", "--new"], env, system)
    const [registered] = ran
    expect(registered?.argv.slice(0, 2)).toEqual(["powershell.exe", "-NoProfile"])
    expect(registered?.env).toMatchObject({
      WIRECAT_EXE: "C:\\node\\node.exe",
      WIRECAT_KIND: "every",
      WIRECAT_MINUTES: "120",
      WIRECAT_NAME: "sync",
      WIRECAT_PATH: "\\chat-cli\\",
    })
    expect(registered?.env.WIRECAT_ARGS).toMatch(/^"C:\\chat\\chat.js" "schedule" "exec" ".*schedule.json"$/)
  })
})

describe("a run", () => {
  const scheduled = (state: string, schedule: Omit<Schedule, "createdAt" | "environment">) => {
    const file = scheduleFile(state, schedule.name)
    mkdirSync(join(file, ".."), { recursive: true })
    writeFileSync(file, JSON.stringify({ ...schedule, environment: { CHAT_PROFILE: "work" }, createdAt: "" }))
    return file
  }

  it("runs an agent read-only, keeps its answer as the latest report and notifies", async () => {
    const { env } = setup()
    const { system, ran } = machine("linux", [process.execPath])
    const file = scheduled(env.CHAT_STATE_DIR, {
      name: "review",
      kind: "agent",
      argv: [process.execPath, "-e", 'console.log("read-only", process.env.CHAT_READ_ONLY, process.env.CHAT_PROFILE)'],
      when: { daily: "08:30" },
    })
    const last = await runSchedule(app, system, env, file)
    expect(last.exitCode).toBe(0)
    expect(readFileSync(join(file, "..", "latest.md"), "utf8")).toBe("read-only 1 work\n")
    expect(ran.at(-1)?.argv.slice(0, 4)).toEqual(["notify-send", "--app-name", "chat review", "chat review"])
  })

  it("runs the CLI's own command without the lock, and a one-off removes itself", async () => {
    const { env } = setup()
    const { system } = machine("linux", [
      process.execPath,
      "-e",
      "console.log(process.env.CHAT_READ_ONLY ?? 'writable')",
    ])
    const removed: string[] = []
    const file = scheduled(env.CHAT_STATE_DIR, {
      name: "once",
      kind: "command",
      argv: [],
      when: { once: new Date().toISOString() },
    })
    const last = await runSchedule(app, system, env, file, {
      timer: { install: async () => {}, remove: async (name) => void removed.push(name), where: () => "" },
    })
    expect(readFileSync(last.output, "utf8")).toBe("writable\n")
    expect(removed).toEqual(["once"])
    expect(existsSync(file)).toBe(false)
  })
})
