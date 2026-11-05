import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { captureStreams, errorObjectOf, NOT_ALLOWED, renderError } from "@wirecat/cli-base"
import { logRecordSchema } from "@wirecat/cli-base/standards"
import { Command } from "commander"
import * as v from "valibot"
import { describe, expect, it, vi } from "vitest"
import { runSchedule, type Schedule, scheduleFile } from "../../background/schedules.js"
import type { Ran, ServerSystem } from "../../background/system.js"
import type { Chat } from "../../domain/models.js"
import type { MailWaiting } from "../../mail/marks.js"
import type { MessengerAdapter } from "../../ports/messenger.js"
import { pickChat } from "../../resolve.js"
import { type BaseEnvironment, baseContext, provide } from "../context.js"
import type { Messenger } from "../messenger/context.js"
import { scheduleCommand } from "../messenger/schedule-command.js"
import { run } from "../program.js"
import { settingsFor } from "../settings.js"
import { type ScheduleLimits, scheduleCommandFor, scheduleLimitsOf } from "./schedule-command.js"

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
    [...(env.CHAT_PROFILE ? [] : ["default"]), "schedule", ...argv],
    { app, commands: () => [scheduleCommand(messenger)] },
    { streams, env, system },
  )
  return { code, out: streams.stdout.join(""), err: streams.stderr.join("") }
}

describe("the schedule agent prompt example", () => {
  const exampleFor = (identity: typeof app & { messenger?: boolean }) => {
    const command = scheduleCommandFor({ app: identity, context: () => ({}) as never })
    return command.commands.find((sub) => sub.name() === "agent")?.registeredArguments[2]?.description
  }

  it("points a messenger at the follow-ups skill", () => {
    expect(exampleFor(app)).toContain("chat skill show follow-ups")
  })

  it("gives a CLI without that skill a read-only search it can run", () => {
    const example = exampleFor({ ...app, command: "mail", messenger: false })
    expect(example).not.toContain("follow-ups")
    expect(example).toContain("mail personal search messages 'date>1d' --newest")
  })
})

describe("a CLI that is not a messenger", () => {
  it("adds and lists a schedule through the host's own context", async () => {
    const { env } = setup()
    const { system, ran } = machine("linux")
    const resolveSettings = settingsFor(app).resolveSettings
    const host = {
      app,
      context: (command: Command) => {
        const base = baseContext(command, resolveSettings)
        return { ...base, profile: base.settings.profile }
      },
    }
    const streams = captureStreams()
    const code = await run(
      ["default", "schedule", "command", "sync", "--every", "5m", "--", "sync", "--json"],
      { app, commands: () => [scheduleCommandFor(host)] },
      { streams, env, system },
    )
    expect(code, streams.stderr.join("")).toBe(0)
    expect(ran.length).toBeGreaterThan(0)
    const file = scheduleFile(env.CHAT_STATE_DIR, "sync")
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({
      argv: ["sync", "--json"],
      when: { every: 5 },
      environment: { CHAT_PROFILE: "default" },
    })
  })
})

// Unit text for Linux and macOS holds POSIX paths; on Windows the real timer is checked by schedules.os.test.ts.
const posix = process.platform !== "win32"

describe.runIf(posix)("schedule on Linux", () => {
  it("narrows stored schedules by name and kind without touching a timer", async () => {
    const { env } = setup()
    const { system, ran } = machine("linux")
    for (const [name, kind] of [
      ["sync", "command"],
      ["brief", "agent"],
    ]) {
      const file = scheduleFile(env.CHAT_STATE_DIR, name as string)
      mkdirSync(join(file, ".."), { recursive: true })
      writeFileSync(
        file,
        JSON.stringify({
          name,
          kind,
          argv: ["doctor"],
          when: { every: 60 },
          environment: {},
          createdAt: "2026-10-01T00:00:00Z",
        }),
      )
    }
    const result = await call(["list", "kind:agent name:brief", "--json"], env, system)
    expect(result.code, result.err).toBe(0)
    expect(JSON.parse(result.out).items).toEqual([
      { name: "brief", kind: "agent", when: "every 1h", last: null, spent_today_usd: 0 },
    ])
    const refused = await call(["list", "kind:agent OR kind:command", "--json"], env, system)
    expect(refused.code).toBe(2)
    expect(ran).toEqual([])
  })

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
    expect(schedule.environment).not.toHaveProperty("CHAT_READ_ONLY")

    const units = join(env.XDG_CONFIG_HOME, "systemd", "user")
    expect(readFileSync(join(units, "chat-schedule-sync.service"), "utf8")).toContain(
      `ExecStart="/opt/node" "/opt/chat/bin/chat.js" "schedule" "exec" "${file}"`,
    )
    expect(readFileSync(join(units, "chat-schedule-sync.timer"), "utf8")).toContain("OnUnitInactiveSec=15min")
    expect(ran.map(({ argv }) => argv.join(" "))).toEqual([
      "systemctl --user daemon-reload",
      "systemctl --user enable --now chat-schedule-sync.timer",
    ])

    const replaced = await call(
      ["command", "sync", "--every", "15m", "--json", "--", "messages", "list", "42", "--limit", "50"],
      env,
      system,
    )
    expect(JSON.parse(replaced.out).item).toMatchObject({
      name: "sync",
      created_at: expect.any(String),
      replaced: true,
      environment: { CHAT_PROFILE: "default" },
    })

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

describe.runIf(posix)("schedule under the read-only lock", () => {
  it("**refuses to add, replace or remove a schedule**, and still lists them", async () => {
    const { env } = setup()
    const { system, ran } = machine("linux")
    expect((await call(["command", "keep", "--every", "1h", "--", "messages", "list", "42"], env, system)).code).toBe(0)
    const file = scheduleFile(env.CHAT_STATE_DIR, "keep")
    const saved = readFileSync(file, "utf8")
    const installed = ran.length

    const locked = { ...env, CHAT_READ_ONLY: "1" }
    const send = await call(
      ["command", "later", "--at-time", "30m", "--", "messages", "send", "42", "--text", "hi"],
      locked,
      system,
    )
    expect(send.code).toBe(5)
    expect(send.err).toContain("CHAT_READ_ONLY")
    expect(existsSync(scheduleFile(env.CHAT_STATE_DIR, "later"))).toBe(false)
    expect(
      (await call(["command", "keep", "--every", "1m", "--", "messages", "send", "42"], locked, system)).code,
    ).toBe(5)
    expect((await call(["agent", "spy", "claude", "send it", "--every", "1h"], locked, system)).code).toBe(5)
    expect((await call(["remove", "keep"], locked, system)).code).toBe(5)
    expect(readFileSync(file, "utf8")).toBe(saved)
    expect(ran).toHaveLength(installed)

    const listed = await call(["list", "--json"], locked, system)
    expect(listed.code).toBe(0)
    expect(JSON.parse(listed.out).items).toMatchObject([{ name: "keep" }])
  })

  it("refuses a name another profile already uses, and still replaces its own", async () => {
    const { env } = setup()
    const { system } = machine("linux")
    const add = (profile: string) =>
      call(["command", "sync", "--every", "15m", "--", "doctor"], { ...env, CHAT_PROFILE: profile }, system)
    expect((await add("work")).code).toBe(0)

    const other = await add("home")
    expect(other.code).not.toBe(0)
    expect(other.err).toContain("already runs for profile work")
    expect(other.err).toContain("sync-home")
    expect(
      (JSON.parse(readFileSync(scheduleFile(env.CHAT_STATE_DIR, "sync"), "utf8")) as Schedule).environment,
    ).toMatchObject({
      CHAT_PROFILE: "work",
    })

    expect((await add("work")).code).toBe(0)
  })

  it("passes the lock on to a schedule saved past the command line's refusal", async () => {
    const { env } = setup()
    const locked = { ...env, CHAT_PROFILE: "default", CHAT_READ_ONLY: "1" }
    const root = new Command().exitOverride().addCommand(scheduleCommand(messenger))
    provide(root, { streams: captureStreams(), env: locked, system: machine("linux").system } as BaseEnvironment)
    await root.parseAsync(["schedule", "command", "later", "--every", "1h", "--", "messages", "list", "42"], {
      from: "user",
    })
    const schedule = JSON.parse(readFileSync(scheduleFile(env.CHAT_STATE_DIR, "later"), "utf8")) as Schedule
    expect(schedule.environment).toMatchObject({ CHAT_READ_ONLY: "1" })
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
      "--model",
      "sonnet",
      "--tools",
      "Bash",
      "--strict-mcp-config",
      "--disable-slash-commands",
      "--setting-sources",
      "",
      "--max-budget-usd",
      "2",
    ])
  })

  it("leaves codex on its own model and start unless a model is named", async () => {
    const { env } = setup()
    await call(["agent", "plain", "codex", "p", "--at", "08:30"], env, machine("linux").system)
    const plain = JSON.parse(readFileSync(scheduleFile(env.CHAT_STATE_DIR, "plain"), "utf8")) as Schedule
    expect(plain.argv).not.toContain("--model")
    expect(plain.argv.at(-1)).toBe("p")

    await call(
      ["agent", "named", "codex", "p", "--at", "08:30", "--model", "a-codex-model"],
      env,
      machine("linux").system,
    )
    const named = JSON.parse(readFileSync(scheduleFile(env.CHAT_STATE_DIR, "named"), "utf8")) as Schedule
    expect(named.argv.join(" ")).toContain("--model a-codex-model")
  })

  it('takes --model over the default, "" for claude\'s own, and refuses one that reads as a flag', async () => {
    const { env } = setup()
    const { system } = machine("linux")
    const argvOf = (name: string) =>
      (JSON.parse(readFileSync(scheduleFile(env.CHAT_STATE_DIR, name), "utf8")) as Schedule).argv
    await call(["agent", "deep", "claude", "p", "--at", "08:30", "--model", "opus"], env, system)
    expect(argvOf("deep").join(" ")).toContain("--model opus")
    await call(["agent", "own", "claude", "p", "--at", "08:30", "--model", ""], env, system)
    expect(argvOf("own")).not.toContain("--model")
    const dash = await call(["agent", "bad", "claude", "p", "--at", "08:30", "--model=--tools"], env, system)
    expect(dash.code).not.toBe(0)
    expect(dash.err).toContain("--model takes")
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

const lastRunOutput = (file: string) => {
  const runs = join(file, "..", "runs")
  return join(
    runs,
    readdirSync(runs)
      .filter((name) => name.endsWith(".log"))
      .sort()
      .at(-1) ?? "",
  )
}

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

  it("logs its start and exit as records, never its output, and hands its trace to the child", async () => {
    const { env } = setup()
    const { system } = machine("linux", [process.execPath])
    const file = scheduled(env.CHAT_STATE_DIR, {
      name: "review",
      kind: "agent",
      argv: [process.execPath, "-e", 'console.log("secret words", process.env.TRACEPARENT)'],
      when: { daily: "08:30" },
    })
    const last = await runSchedule(app, system, env, file)
    const runs = join(file, "..", "runs")
    const recordFile = readdirSync(runs).find((name) => name.endsWith(".jsonl")) ?? ""
    const text = readFileSync(join(runs, recordFile), "utf8")
    const records = text
      .trimEnd()
      .split("\n")
      .map((line) => v.parse(logRecordSchema, JSON.parse(line)))

    expect(records.map((record) => record.attributes)).toEqual([
      { event: "schedule.start", schedule: "review", kind: "agent" },
      { event: "schedule.exit", schedule: "review", kind: "agent", exit_code: 0, duration_ms: expect.any(Number) },
    ])
    expect(records.every((record) => record.trace_id === last.traceId)).toBe(true)
    expect(text).not.toContain("secret words")
    expect(text).not.toContain(NOT_ALLOWED)
    expect(readFileSync(last.output, "utf8")).toContain(`-${last.traceId}-`)
  })

  it("runs from a timer's own argv, which names no profile", async () => {
    const { env } = setup()
    const { system } = machine("linux", [process.execPath, "-e", "console.log(process.env.CHAT_PROFILE)"])
    const file = scheduled(env.CHAT_STATE_DIR, {
      name: "sync",
      kind: "command",
      argv: [],
      when: { every: 5 },
    })
    const streams = captureStreams()
    const code = await run(
      ["schedule", "exec", file],
      { app, commands: () => [scheduleCommand(messenger)] },
      { streams, env, system },
    )
    expect(code, streams.stderr.join("")).toBe(0)
    expect(readFileSync(lastRunOutput(file), "utf8")).toContain("work")
  })

  it("stops its child when its own --timeout ends the wait, so the child does not outlive the run", async () => {
    const { env } = setup()
    const { system } = machine("linux", [process.execPath, "-e", "setInterval(() => {}, 1000)"])
    const file = scheduled(env.CHAT_STATE_DIR, { name: "sync", kind: "command", argv: [], when: { every: 5 } })
    const began = Date.now()
    const code = await run(
      ["schedule", "exec", file, "--timeout", "500ms"],
      { app, commands: () => [scheduleCommand(messenger)] },
      { streams: captureStreams(), env, system },
    )
    expect(Date.now() - began).toBeLessThan(8_000)
    expect(code).toBe(1)
    expect(JSON.parse(readFileSync(join(file, "..", "last.json"), "utf8")).exitCode).toBe(143)
  })

  describe("a keyring still locked when the timer fires", () => {
    const locked = JSON.stringify({
      error: { code: "provider_unavailable", reason: "credentials.unreachable", message: "the keyring is locked" },
    })
    /** Fails as tg does with the keyring locked for the first `lockedRuns` runs, then succeeds. */
    const child = (root: string, lockedRuns: number) => {
      const count = join(root, "count")
      return `const fs = require("fs"); const n = fs.existsSync(${JSON.stringify(count)}) ? Number(fs.readFileSync(${JSON.stringify(count)}, "utf8")) : 0; fs.writeFileSync(${JSON.stringify(count)}, String(n + 1)); if (n < ${lockedRuns}) { console.error(${JSON.stringify(locked)}); process.exit(12) }`
    }
    const clock = () => {
      let at = Date.parse("2026-11-02T03:49:00Z")
      const waits: number[] = []
      return {
        waits,
        now: () => new Date(at),
        wait: async (ms: number) => {
          waits.push(ms)
          at += ms
        },
      }
    }

    it("tries again, a minute then longer apart, and notifies only how it ended", async () => {
      const { env, root } = setup()
      const { system, ran } = machine("linux", [process.execPath, "-e", child(root, 2)])
      const file = scheduled(env.CHAT_STATE_DIR, { name: "sync", kind: "command", argv: [], when: { daily: "04:30" } })
      const { waits, now, wait } = clock()

      const last = await runSchedule(app, system, env, file, { untilUnlocked: true, now, wait })

      expect(last.exitCode).toBe(0)
      expect(waits).toEqual([60_000, 120_000])
      expect(ran.filter((one) => one.argv[0] === "notify-send")).toEqual([])
    })

    it("gives up after twelve hours with the failure as it is", async () => {
      const { env, root } = setup()
      const { system, ran } = machine("linux", [process.execPath, "-e", child(root, 1000)])
      const file = scheduled(env.CHAT_STATE_DIR, { name: "sync", kind: "command", argv: [], when: { daily: "04:30" } })
      const { waits, now, wait } = clock()

      const last = await runSchedule(app, system, env, file, { untilUnlocked: true, now, wait })

      expect(last).toMatchObject({ exitCode: 12, reason: "provider_unavailable (credentials.unreachable)" })
      expect(waits.reduce((sum, ms) => sum + ms, 0)).toBeLessThanOrEqual(12 * 60 * 60_000)
      expect(Math.max(...waits)).toBe(15 * 60_000)
      expect(ran.filter((one) => one.argv[0] === "notify-send")).toHaveLength(1)
    })

    it("does not wait in a run by hand, in a schedule that repeats, or for any other failure", async () => {
      const { env, root } = setup()
      const { system } = machine("linux", [process.execPath, "-e", child(root, 1000)])
      const daily = scheduled(env.CHAT_STATE_DIR, { name: "sync", kind: "command", argv: [], when: { daily: "04:30" } })
      const repeating = scheduled(env.CHAT_STATE_DIR, { name: "often", kind: "command", argv: [], when: { every: 5 } })
      const { waits, now, wait } = clock()

      expect((await runSchedule(app, system, env, daily, { now, wait })).exitCode).toBe(12)
      expect((await runSchedule(app, system, env, repeating, { untilUnlocked: true, now, wait })).exitCode).toBe(12)
      const other = machine("linux", [process.execPath, "-e", "process.exit(4)"]).system
      expect((await runSchedule(app, other, env, daily, { untilUnlocked: true, now, wait })).exitCode).toBe(4)
      expect(waits).toEqual([])
    })
  })

  it("kills a child that ignores SIGTERM once its grace is over", async () => {
    const { env, root } = setup()
    const ready = join(root, "ready")
    const child = `process.on("SIGTERM", () => {}); require("fs").writeFileSync(${JSON.stringify(ready)}, ""); setInterval(() => {}, 1000)`
    const { system } = machine("linux", [process.execPath, "-e", child])
    const file = scheduled(env.CHAT_STATE_DIR, { name: "sync", kind: "command", argv: [], when: { every: 5 } })
    const stop = new AbortController()
    const running = runSchedule(app, system, env, file, { signal: stop.signal, killAfterMs: 200 })
    await vi.waitFor(() => expect(existsSync(ready)).toBe(true), { timeout: 20_000 })
    stop.abort()
    expect((await running).exitCode).toBe(137)
  })

  it("keeps the newest thirty runs, however many files each has", async () => {
    const { env } = setup()
    const { system } = machine("linux", [process.execPath])
    const file = scheduled(env.CHAT_STATE_DIR, {
      name: "review",
      kind: "agent",
      argv: [process.execPath, "-e", ""],
      when: { daily: "08:30" },
    })
    let at = Date.parse("2026-10-01T00:00:00Z")
    for (let i = 0; i < 32; i += 1) {
      at += 60_000
      const moment = at
      await runSchedule(app, system, env, file, { now: () => new Date(moment) })
    }
    const runs = readdirSync(join(file, "..", "runs"))
    expect(new Set(runs.map((name) => name.split(".")[0])).size).toBe(30)
    expect(runs).toHaveLength(90)
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

  it("keeps a run started under the lock locked, whatever the schedule file says", async () => {
    const { env } = setup()
    const { system } = machine("linux", [process.execPath, "-e", "console.log(process.env.CHAT_READ_ONLY)"])
    const file = scheduleFile(env.CHAT_STATE_DIR, "sneaky")
    mkdirSync(join(file, ".."), { recursive: true })
    writeFileSync(
      file,
      JSON.stringify({
        name: "sneaky",
        kind: "command",
        argv: [],
        when: { every: 60 },
        environment: { CHAT_PROFILE: "work", CHAT_READ_ONLY: "0" },
        createdAt: "",
      }),
    )
    const last = await runSchedule(app, system, { ...env, CHAT_READ_ONLY: "1" }, file)
    expect(readFileSync(last.output, "utf8")).toBe("1\n")
  })

  it("counts failures in a row with the first one's time, and a success clears them", async () => {
    const { env } = setup()
    const failing = machine("linux", [
      process.execPath,
      "-e",
      'console.error("noise\\nvault has no folder id"); process.exit(8)',
    ])
    const file = scheduled(env.CHAT_STATE_DIR, { name: "sync", kind: "command", argv: [], when: { every: 5 } })
    const first = await runSchedule(app, failing.system, env, file, { now: () => new Date("2026-10-14T00:58:00Z") })
    const second = await runSchedule(app, failing.system, env, file, { now: () => new Date("2026-10-14T01:03:00Z") })
    expect(first).toMatchObject({ exitCode: 8, failures: 1, failingSince: "2026-10-14T00:58:00.000Z" })
    expect(second).toMatchObject({
      exitCode: 8,
      failures: 2,
      failingSince: "2026-10-14T00:58:00.000Z",
      reason: "exit 8",
    })

    const passing = machine("linux", [process.execPath, "-e", ""])
    const third = await runSchedule(app, passing.system, env, file)
    expect(third).not.toHaveProperty("failures")
    expect(third).not.toHaveProperty("reason")
  })

  it("keeps a chat's title out of every state file but the run's log, which the failure was printed to", async () => {
    const { env } = setup()
    const chats = [
      { id: "7", title: "Book club" },
      { id: "8", title: "Book club notes" },
    ] as Chat[]
    const refused = (() => {
      try {
        return pickChat("Book", chats)
      } catch (error) {
        return renderError(errorObjectOf(error), { cli: "chat", interactive: false })
      }
    })()
    const failing = machine("linux", [
      process.execPath,
      "-e",
      `console.error(${JSON.stringify(refused)}); process.exit(2)`,
    ])
    const file = scheduled(env.CHAT_STATE_DIR, { name: "digest", kind: "command", argv: [], when: { every: 5 } })
    const last = await runSchedule(app, failing.system, env, file)

    expect(last).toMatchObject({ errorCode: "validation_error", reason: "validation_error (input.invalid)" })
    expect(readFileSync(last.output, "utf8")).toContain("Book club")
    const files = readdirSync(env.CHAT_STATE_DIR, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => join(entry.parentPath, entry.name))
    expect(files).toContain(join(file, "..", "last.json"))
    if (process.platform !== "win32") {
      for (const path of [last.output, join(file, "..", "last.json")]) expect(statSync(path).mode & 0o777).toBe(0o600)
      expect(statSync(join(file, "..", "runs")).mode & 0o777).toBe(0o700)
    }
    for (const path of files.filter((path) => path !== last.output)) {
      expect(readFileSync(path, "utf8"), path).not.toContain("Book club")
    }
  })
})

describe("a failing schedule", () => {
  const other = () => new Command("chats").addCommand(new Command("list").action(() => {}))
  const failed = (state: string) => {
    const folder = join(state, "schedules", "sync")
    mkdirSync(folder, { recursive: true })
    writeFileSync(
      join(folder, "schedule.json"),
      JSON.stringify({ name: "sync", kind: "command", argv: [], when: { every: 5 }, environment: {}, createdAt: "" }),
    )
    writeFileSync(
      join(folder, "last.json"),
      JSON.stringify({ at: "2026-10-14T10:00:00Z", exitCode: 1, output: "", reason: "no folder id", failures: 3 }),
    )
  }
  const command = async (argv: string[], env: NodeJS.ProcessEnv) => {
    const streams = captureStreams()
    const code = await run(["default", ...argv], { app, commands: () => [other()] }, { streams, env })
    return { code, err: streams.stderr.join("") }
  }

  it("is said on stderr before any other command, with the reason and where to look", async () => {
    const { env } = setup()
    failed(env.CHAT_STATE_DIR)
    const { code, err } = await command(["chats", "list"], env)
    expect(code).toBe(0)
    expect(err).toMatch(
      /^chat: scheduled sync failing since .+ \(3 runs\): no folder id — chat default schedule list\n?$/,
    )
  })

  it("is not said inside the scheduled run, nor under --quiet", async () => {
    const { env } = setup()
    failed(env.CHAT_STATE_DIR)
    expect((await command(["chats", "list"], { ...env, CHAT_SCHEDULED: "sync" })).err).toBe("")
    expect((await command(["chats", "list", "--quiet"], env)).err).toBe("")
  })

  it("is not said for a schedule that last ran fine, or one never run", async () => {
    const { env } = setup()
    expect((await command(["chats", "list"], env)).err).toBe("")
  })
})

describe.runIf(process.platform !== "win32")("an agent gated on new mail", () => {
  const MINUTE = 60_000
  const waitingMail = (emails: number, minutesAgo = 0): MailWaiting => ({
    unmarked: false,
    emails,
    oldestStoredAt: emails ? Date.now() - minutesAgo * MINUTE : null,
  })
  const gated = (waiting: () => MailWaiting, limits: ScheduleLimits = {}) => {
    const { env: bare, root } = setup()
    // Prints what claude's JSON answer holds: the report, the run's cost, and the holder the run was started for.
    writeFileSync(
      join(root, "bin", "claude"),
      `#!/bin/sh\nprintf '{"type":"result","result":"holder %s","total_cost_usd":3}' "$CHAT_MAIL_HOLDER"\n`,
    )
    // This host resolves settings in full, so the timer's run names the profile its schedule file holds.
    const env = { ...bare, CHAT_PROFILE: "default" }
    const { system } = machine("linux")
    const resolveSettings = settingsFor(app).resolveSettings
    const asked: string[] = []
    const host = {
      app,
      context: (command: Command) => {
        const base = baseContext(command, resolveSettings)
        return { ...base, profile: base.settings.profile }
      },
      newMail: async (_command: Command, holder: string) => {
        asked.push(holder)
        return waiting()
      },
      limits: () => limits,
    }
    const call = async (argv: string[]) => {
      const streams = captureStreams()
      const code = await run(
        [...argv, "--json"],
        { app, commands: () => [scheduleCommandFor(host)] },
        {
          streams,
          env,
          system,
        },
      )
      return { code, out: streams.stdout.join(""), err: streams.stderr.join("") }
    }
    const add = async (...flags: string[]) => {
      const added = await call(["default", "schedule", "agent", "triage", "claude", "p", "--every", "5m", ...flags])
      expect(added.code, added.err).toBe(0)
      return scheduleFile(env.CHAT_STATE_DIR, "triage")
    }
    const ran = (file: string) => existsSync(join(file, "..", "last.json"))
    return { env, asked, call, add, ran }
  }

  it("may check every 5 minutes, and starts the agent only when mail is stored past the holder's mark", async () => {
    let mail = waitingMail(0)
    const { asked, call, add, ran } = gated(() => mail)
    const file = await add("--on-new-mail", "mail-triage")
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ when: { every: 5 }, onNewMail: "mail-triage" })

    const skipped = await call(["schedule", "exec", file])
    expect(skipped.code, skipped.err).toBe(0)
    expect(ran(file)).toBe(false)
    const byHand = await call(["schedule", "run", "triage"])
    expect(JSON.parse(byHand.out).item).toMatchObject({ skipped: true, why: expect.stringContaining("mail-triage") })

    mail = waitingMail(1)
    expect((await call(["schedule", "run", "triage"])).code).toBe(0)
    expect(readFileSync(join(file, "..", "latest.md"), "utf8")).toBe("holder mail-triage")
    expect(asked).toEqual(["mail-triage", "mail-triage", "mail-triage"])
  })

  it("on its timer, waits until 10 emails wait or the oldest has waited 30 minutes", async () => {
    let mail = waitingMail(9, 29)
    const { call, add, ran } = gated(() => mail)
    const file = await add("--on-new-mail", "mail-triage", "--max-cost-per-day", "0")

    await call(["schedule", "exec", file])
    expect(ran(file)).toBe(false)
    mail = waitingMail(10, 1)
    await call(["schedule", "exec", file])
    expect(ran(file)).toBe(true)

    const second = gated(() => waitingMail(1, 31))
    const later = await second.add("--on-new-mail", "mail-triage")
    await second.call(["schedule", "exec", later])
    expect(second.ran(later)).toBe(true)
  })

  it("takes the config file's batch and wait, and a schedule's own flags over them", async () => {
    const config = gated(() => waitingMail(3), { mailBatch: 3 })
    const file = await config.add("--on-new-mail", "mail-triage")
    await config.call(["schedule", "exec", file])
    expect(config.ran(file)).toBe(true)

    const flagged = gated(() => waitingMail(3, 20), { mailBatch: 3, mailWaitMinutes: 10 })
    const own = await flagged.add("--on-new-mail", "mail-triage", "--mail-batch", "20", "--mail-wait", "1h")
    expect(JSON.parse(readFileSync(own, "utf8"))).toMatchObject({ mailBatch: 20, mailWaitMinutes: 60 })
    await flagged.call(["schedule", "exec", own])
    expect(flagged.ran(own)).toBe(false)
  })

  it("takes the config file's model and lean start, and --model over the config", async () => {
    const argvOf = (file: string) => (JSON.parse(readFileSync(file, "utf8")) as Schedule).argv
    const configured = gated(() => waitingMail(0), { models: { claude: "haiku" }, leanStart: false })
    const file = await configured.add("--on-new-mail", "mail-triage")
    expect(argvOf(file).join(" ")).toContain("--model haiku")
    expect(argvOf(file)).not.toContain("--strict-mcp-config")
    expect(argvOf(file)).not.toContain("--setting-sources")

    const flagged = gated(() => waitingMail(0), { models: { claude: "haiku" } })
    const own = await flagged.add("--on-new-mail", "mail-triage", "--model", "opus")
    expect(argvOf(own).join(" ")).toContain("--model opus")
    expect(argvOf(own)).toContain("--strict-mcp-config")
  })

  it("reads the model and lean start from the config file's keys, and ignores a model that reads as a flag", () => {
    expect(
      scheduleLimitsOf({ schedule_model_claude: " opus ", schedule_model_codex: "", schedule_lean_start: false }),
    ).toEqual({ models: { claude: "opus", codex: "" }, leanStart: false })
    expect(scheduleLimitsOf({ schedule_model_claude: "--tools", schedule_lean_start: "no" })).toEqual({})
  })

  it("starts no run once the day's runs cost the daily cap, says so, and starts again the next day", async () => {
    const { call, add } = gated(() => waitingMail(1, 60), { maxCostPerDay: 100 })
    const file = await add("--on-new-mail", "mail-triage", "--max-cost-per-day", "5")
    const spent = () => JSON.parse(readFileSync(join(file, "..", "spend.json"), "utf8")).usd

    await call(["schedule", "exec", file])
    expect(JSON.parse(readFileSync(join(file, "..", "last.json"), "utf8"))).toMatchObject({ costUsd: 3 })
    await call(["schedule", "exec", file])
    expect(spent()).toBe(6)
    await call(["schedule", "exec", file])
    expect(spent()).toBe(6)
    const listed = JSON.parse((await call(["schedule", "list"])).out).items[0]
    expect(listed).toMatchObject({ spent_today_usd: 6, last: { skipped: { why: expect.stringContaining("$5.00") } } })

    const spend = join(file, "..", "spend.json")
    writeFileSync(spend, JSON.stringify({ day: "2000-01-01", usd: 6 }))
    await call(["schedule", "exec", file])
    expect(spent()).toBe(3)
  })

  it("keeps the hourly floor for an agent that is not gated, and refuses a holder name that is not one", async () => {
    const { call } = gated(() => waitingMail(1))
    expect((await call(["schedule", "agent", "x", "claude", "p", "--every", "5m"])).err).toContain(
      "at least 60 minutes",
    )
    const bad = await call([
      "default",
      "schedule",
      "agent",
      "x",
      "claude",
      "p",
      "--every",
      "1h",
      "--on-new-mail",
      "Bad",
    ])
    expect(bad.code).toBe(2)
  })
})
