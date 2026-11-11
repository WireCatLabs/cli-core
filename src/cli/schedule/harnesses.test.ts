import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { captureStreams } from "@wirecat/cli-base"
import type { Command } from "commander"
import * as v from "valibot"
import { describe, expect, it } from "vitest"
import { runSchedule, type Schedule, scheduleFile } from "../../background/schedules.js"
import type { Ran, ServerSystem } from "../../background/system.js"
import { scheduledJob, scheduleHarness } from "../../entities/list-results.js"
import { baseContext } from "../context.js"
import { run } from "../program.js"
import { settingsFor } from "../settings.js"
import { HARNESSES, harnessOfArgv } from "./harnesses.js"
import { scheduleCommandFor } from "./schedule-command.js"

const app = { command: "chat", appName: "chat-cli", envPrefix: "CHAT", description: "A test", version: "1.0.0" }

const system: ServerSystem = {
  platform: "linux",
  uid: 501,
  entry: ["/opt/node", "/opt/chat/bin/chat.js"],
  run: async (): Promise<Ran> => ({ code: 0, stdout: "", stderr: "" }),
  spawn: () => 0,
  pause: async () => {},
}

const setup = (programs: string[]) => {
  const root = mkdtempSync(join(tmpdir(), "harness-"))
  const bin = join(root, "bin")
  mkdirSync(bin)
  for (const name of programs) {
    writeFileSync(join(bin, name), "#!/bin/sh\n")
    chmodSync(join(bin, name), 0o755)
  }
  const env = {
    HOME: join(root, "home"),
    XDG_CONFIG_HOME: join(root, "home", ".config"),
    CHAT_STATE_DIR: join(root, "state"),
    MESSAGING_STORE: join(root, "m.db"),
    PATH: bin,
  }
  const call = async (...argv: string[]) => {
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
      ["default", "schedule", ...argv],
      { app, commands: () => [scheduleCommandFor(host)] },
      { streams, env, system },
    )
    return { code, out: streams.stdout.join(""), err: streams.stderr.join("") }
  }
  const argvOf = (name: string) =>
    (JSON.parse(readFileSync(scheduleFile(env.CHAT_STATE_DIR, name), "utf8")) as Schedule).argv
  return { root, bin, env, call, argvOf }
}

describe.runIf(process.platform !== "win32")("agents other than claude", () => {
  it("lists every agent, which are on PATH, and whether each reports cost", async () => {
    const { bin, call } = setup(["claude", "kimi", "agent"])
    const listed = await call("agents", "list", "--json")
    expect(listed.code, listed.err).toBe(0)
    const items = JSON.parse(listed.out).items as { id: string; installed: boolean; path: string | null }[]
    expect(items.map((one) => one.id)).toEqual([...HARNESSES])
    for (const item of items) expect(v.safeParse(scheduleHarness, item).success).toBe(true)
    expect(items.filter((one) => one.installed).map((one) => [one.id, one.path])).toEqual([
      ["claude", join(bin, "claude")],
      ["cursor", join(bin, "agent")],
      ["kimi", join(bin, "kimi")],
    ])
    expect(items.find((one) => one.id === "gemini")).toMatchObject({
      name: "Gemini CLI",
      programs: ["gemini"],
      reports_cost: false,
      restricted: false,
      installed: false,
      path: null,
    })
  })

  it("starts each agent in its one-shot mode with its own model flag", async () => {
    const { bin, call, argvOf } = setup(["gemini", "hermes", "opencode"])
    expect((await call("agent", "g", "gemini", "brief me", "--at", "08:30", "--model", "gemini-pro")).code).toBe(0)
    expect(argvOf("g")).toEqual([join(bin, "gemini"), "-p", "brief me", "--approval-mode", "yolo", "-m", "gemini-pro"])
    expect((await call("agent", "h", "hermes", "brief me", "--at", "08:30")).code).toBe(0)
    expect(argvOf("h")).toEqual([join(bin, "hermes"), "chat", "-q", "brief me", "-Q", "--yolo"])
    expect(
      (await call("agent", "o", "opencode", "brief me", "--at", "08:30", "--model", "provider/model-a")).code,
    ).toBe(0)
    expect(argvOf("o")).toEqual([join(bin, "opencode"), "run", "-m", "provider/model-a", "brief me"])
    expect(harnessOfArgv(argvOf("o"))).toBe("opencode")
  })

  it("gives every agent the prompt and its model, and reads the agent back from what it saved", async () => {
    const programs = ["claude", "codex", "gemini", "cursor-agent", "opencode", "openclaw", "hermes", "grok", "kimi"]
    const { call, argvOf } = setup(programs)
    for (const harness of HARNESSES) {
      const added = await call("agent", harness, harness, "brief me", "--at", "08:30", "--model", "model-a")
      expect(added.code, added.err).toBe(0)
      const argv = argvOf(harness)
      expect(argv).toEqual(expect.arrayContaining(["brief me", "model-a"]))
      expect(harnessOfArgv(argv)).toBe(harness)
    }
  })

  it("refuses a cost cap for an agent that reports no cost, and lists its cost as unknown", async () => {
    const { call } = setup(["codex"])
    const capped = await call("agent", "c", "codex", "brief me", "--at", "08:30", "--max-cost-per-day", "2")
    expect(capped.code).not.toBe(0)
    expect(capped.err).toContain("agent.cost-unknown")
    expect((await call("agent", "c", "codex", "brief me", "--at", "08:30")).code).toBe(0)
    const [row] = JSON.parse((await call("list", "--json")).out).items
    expect(row).toMatchObject({
      harness: "codex",
      reports_cost: false,
      spent_today_usd: null,
      max_cost_usd: null,
      max_cost_per_day_usd: null,
    })
    expect(v.safeParse(scheduledJob, row).success).toBe(true)
  })

  it("names an agent that is not installed by every program it is looked for by", async () => {
    const { call } = setup([])
    expect((await call("agent", "x", "cursor", "p", "--at", "08:30")).err).toContain(
      "cursor-agent or agent is not on PATH",
    )
  })
})

describe.runIf(process.platform !== "win32")("a claude run that answers an error", () => {
  it("fails, keeping claude's answer in the run's log, though claude exited 0", async () => {
    const { bin, env } = setup([])
    const answer = JSON.stringify({ type: "result", is_error: true, result: "Credit balance is too low" })
    writeFileSync(join(bin, "claude"), `#!/bin/sh\necho '${answer}'\n`)
    chmodSync(join(bin, "claude"), 0o755)
    const file = scheduleFile(env.CHAT_STATE_DIR, "brief")
    mkdirSync(join(file, ".."), { recursive: true })
    const schedule = { name: "brief", kind: "agent", argv: [join(bin, "claude"), "-p", "brief me"] }
    writeFileSync(file, JSON.stringify({ ...schedule, when: { daily: "08:30" }, environment: {}, createdAt: "" }))
    const last = await runSchedule(app, system, env, file, {})
    expect(last.exitCode).toBe(1)
    expect(readFileSync(last.output.replace(/\.md$/, ".log"), "utf8")).toContain("Credit balance is too low")
  })
})
