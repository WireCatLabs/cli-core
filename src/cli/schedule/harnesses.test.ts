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
import { ancestorValue, lockedByAncestor } from "../../ports/app.js"
import { baseContext } from "../context.js"
import { run } from "../program.js"
import { settingsFor } from "../settings.js"
import { HARNESS_VARIABLES, HARNESSES, harnessOf, harnessOfArgv } from "./harnesses.js"
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

describe.runIf(process.platform !== "win32")("agents a schedule may start", () => {
  it("lists every agent, which are on PATH, whether each reports cost, and why one may not run", async () => {
    const { bin, call } = setup(["claude", "kimi", "agent"])
    const listed = await call("agents", "list", "--json")
    expect(listed.code, listed.err).toBe(0)
    const items = JSON.parse(listed.out).items as {
      id: string
      installed: boolean
      path: string | null
      restricted: boolean
    }[]
    expect(items.map((one) => one.id)).toEqual([...HARNESSES])
    for (const item of items) expect(v.safeParse(scheduleHarness, item).success).toBe(true)
    expect(items.filter((one) => one.restricted).map((one) => one.id)).toEqual(["claude", "gemini", "opencode"])
    expect(items.filter((one) => one.installed).map((one) => [one.id, one.path])).toEqual([
      ["claude", join(bin, "claude")],
      ["cursor", join(bin, "agent")],
      ["kimi", join(bin, "kimi")],
    ])
    expect(items.find((one) => one.id === "gemini")).toMatchObject({
      name: "Gemini CLI",
      programs: ["gemini"],
      reports_cost: false,
      restricted_reason: null,
      installed: false,
      path: null,
    })
    expect(items.find((one) => one.id === "cursor")).toMatchObject({
      restricted_reason: expect.stringContaining("chained command"),
    })
  })

  it("refuses an agent its own limits do not hold to the CLI's commands, saying why", async () => {
    const refused = ["codex", "cursor", "openclaw", "hermes", "grok", "kimi"]
    const { call } = setup(["codex", "cursor-agent", "openclaw", "hermes", "grok", "kimi"])
    for (const harness of refused) {
      const answer = await call("agent", "x", harness, "brief me", "--at", "08:30")
      expect(answer.code).not.toBe(0)
      expect(answer.err).toContain("agent.unrestricted")
    }
  })

  it("starts gemini and opencode in their one-shot modes with their own model flags", async () => {
    const { bin, call, argvOf } = setup(["gemini", "opencode"])
    expect((await call("agent", "g", "gemini", "brief me", "--at", "08:30", "--model", "gemini-pro")).code).toBe(0)
    const prompt = expect.stringMatching(/untrusted.*\n\nbrief me$/s)
    expect(argvOf("g")).toEqual([join(bin, "gemini"), "-p", prompt, "-m", "gemini-pro"])
    expect(
      (await call("agent", "o", "opencode", "brief me", "--at", "08:30", "--model", "provider/model-a")).code,
    ).toBe(0)
    expect(argvOf("o")).toEqual([join(bin, "opencode"), "run", "-m", "provider/model-a", prompt])
    expect(harnessOfArgv(argvOf("o"))).toBe("opencode")
  })

  it("gives gemini and opencode their limits in a work folder of their own, never the schedule's", async () => {
    const { bin, env, call } = setup([])
    const script = (body: string) => `#!/bin/sh\n${body}\n`
    writeFileSync(
      join(bin, "gemini"),
      script('/bin/cat "$GEMINI_CLI_SYSTEM_SETTINGS_PATH"; echo; /bin/cat gemini/policy.toml; echo x > schedule.json'),
    )
    writeFileSync(join(bin, "opencode"), script('printf %s "$OPENCODE_CONFIG_CONTENT"'))
    for (const name of ["gemini", "opencode"]) chmodSync(join(bin, name), 0o755)
    const ran = async (harness: string) => {
      expect((await call("agent", harness, harness, "brief me", "--at", "08:30")).code).toBe(0)
      const file = scheduleFile(env.CHAT_STATE_DIR, harness)
      const saved = readFileSync(file, "utf8")
      const last = await runSchedule(app, system, env, file, {})
      expect(last.exitCode).toBe(0)
      expect(readFileSync(file, "utf8")).toBe(saved)
      return readFileSync(last.output, "utf8")
    }
    const gemini = await ran("gemini")
    const settings = JSON.parse(gemini.split("\n")[0] ?? "")
    expect(settings).toMatchObject({
      tools: { allowed: [] },
      mcpServers: {},
      security: { disableYoloMode: true },
    })
    expect(settings.adminPolicyPaths[0]).not.toContain(env.CHAT_STATE_DIR)
    expect(gemini).toContain('toolName = "run_shell_command"\ndecision = "deny"\npriority = 10')
    expect(gemini).toContain('commandPrefix = "chat "\ndecision = "allow"')
    expect(gemini).toContain('toolName = "write_file"\ndecision = "deny"')
    // As Gemini's policy engine matches them: after `"command":"`, against the call's arguments as JSON.
    const regexes = [...gemini.matchAll(/commandRegex = (".*")/g)].map(
      (match) => new RegExp(`"command":"${JSON.parse(match[1] ?? "")}`),
    )
    const denied = (command: string) =>
      regexes.some((regex) => regex.test(JSON.stringify({ command, dir_path: "/tmp; x" })))
    expect(gemini).toContain('toolName = "*"\ndecision = "deny"\npriority = 1\n')
    expect(denied("chat search messages 'date>1d'")).toBe(false)
    expect(denied('chat search messages "a \\"quoted\\" word"')).toBe(false)
    expect(denied("chat x\nrm -rf ~")).toBe(true)
    expect(denied("chat x && touch y")).toBe(true)
    expect(denied("chat $(id)")).toBe(true)
    expect(denied("chat x; rm -rf ~")).toBe(true)
    expect(denied("chat x | sh")).toBe(true)
    expect(denied("CHAT_READ_ONLY=0 chat send")).toBe(true)
    expect(denied("env -u CHAT_READ_ONLY chat send")).toBe(true)
    const opencode = JSON.parse(await ran("opencode"))
    expect(opencode.permissions).toEqual([
      { action: "*", resource: "*", effect: "deny" },
      { action: "shell", resource: "chat *", effect: "allow" },
    ])
    expect(opencode.permission).toMatchObject({ "*": "deny", bash: { "*": "deny", "chat *": "allow" } })
  })

  it("runs what the harness builds now, never the argv saved in the file", async () => {
    const { root, bin, env, call } = setup([])
    writeFileSync(join(bin, "claude"), `#!/bin/sh\nprintf "%s|" "$@" > "${root}/claude-argv"\n`)
    chmodSync(join(bin, "claude"), 0o755)
    expect((await call("agent", "brief", "claude", "brief me", "--at", "08:30")).code).toBe(0)
    const file = scheduleFile(env.CHAT_STATE_DIR, "brief")
    const saved = JSON.parse(readFileSync(file, "utf8")) as Schedule
    writeFileSync(file, JSON.stringify({ ...saved, argv: ["/bin/sh", "-c", "echo escaped"] }))
    expect((await call("run", "brief")).code).toBe(0)
    const argv = readFileSync(join(root, "claude-argv"), "utf8").split("|")
    expect(argv).toEqual(expect.arrayContaining(["--setting-sources", "", "--permission-mode", "dontAsk"]))
    expect(argv.find((word) => word.endsWith("brief me"))).toMatch(/^The WireCat CLIs' output holds/)
    expect(argv.join(" ")).toMatch(/⟦untrusted:[0-9a-f]{16} …⟧/)
  })

  it.each([
    [
      "an older file with no agent to rebuild from",
      (saved: Schedule) => ({ ...saved, agent: undefined }),
      "older version",
    ],
    [
      "a variable no schedule sets",
      (saved: Schedule) => ({ ...saved, environment: { ...saved.environment, NODE_OPTIONS: "--require /tmp/x.js" } }),
      "NODE_OPTIONS",
    ],
    [
      "a relative PATH",
      (saved: Schedule) => ({ ...saved, environment: { ...saved.environment, PATH: "bin:/usr/bin" } }),
      "relative path",
    ],
    [
      "codex without the owner's acknowledgement",
      (saved: Schedule) => ({
        ...saved,
        agent: { ...(saved.agent as NonNullable<Schedule["agent"]>), harness: "codex" },
      }),
      "--allow-dangerous",
    ],
  ])("refuses %s", async (_name, change, why) => {
    const { env, call } = setup(["claude", "codex"])
    expect((await call("agent", "brief", "claude", "brief me", "--at", "08:30")).code).toBe(0)
    const file = scheduleFile(env.CHAT_STATE_DIR, "brief")
    writeFileSync(file, JSON.stringify(change(JSON.parse(readFileSync(file, "utf8")) as Schedule)))
    const ran = await call("run", "brief")
    expect(ran.code).not.toBe(0)
    expect(ran.err).toContain("agent.refused")
    expect(ran.err).toContain(why)
  })

  it("does not run a sealed schedule whose file changed after it was saved", async () => {
    const { env, call } = setup(["claude"])
    expect((await call("agent", "brief", "claude", "brief me", "--at", "08:30")).code).toBe(0)
    const sealed = await call("exec", scheduleFile(env.CHAT_STATE_DIR, "brief"), "0".repeat(64))
    expect(sealed.code).not.toBe(0)
    expect(sealed.err).toContain("changed since it was saved")
  })

  it("starts codex only with the owner's acknowledgement, sandboxed with no network and none of its own config", async () => {
    const { env, call } = setup(["codex"])
    const refused = await call("agent", "triage", "codex", "brief me", "--at", "08:30")
    expect(refused.code).not.toBe(0)
    expect(refused.err).toContain("agent.unrestricted")
    expect((await call("agent", "triage", "codex", "brief me", "--at", "08:30", "--allow-dangerous")).code).toBe(0)
    const saved = JSON.parse(readFileSync(scheduleFile(env.CHAT_STATE_DIR, "triage"), "utf8")) as Schedule
    expect(saved.agent).toMatchObject({ harness: "codex", allowDangerous: true })
    expect(saved.argv).toEqual(
      expect.arrayContaining([
        "--ignore-user-config",
        "--ignore-rules",
        "--sandbox",
        "workspace-write",
        "sandbox_workspace_write.network_access=false",
      ]),
    )
    expect(saved.argv).not.toContain(join(env.XDG_CONFIG_HOME, "chat-cli"))
  })

  it("rebuilds the harness variables a run reads its limits from", () => {
    for (const id of HARNESSES) {
      const start = harnessOf(id).start({
        program: id,
        prompt: "p",
        model: "",
        clis: [{ command: "chat", appName: "chat-cli", envPrefix: "CHAT" }],
        folders: [],
        leanStart: true,
      })
      for (const name of Object.keys(start.environment ?? {})) expect(HARNESS_VARIABLES).toContain(name)
    }
  })

  it("refuses a cost cap for an agent that reports no cost, and lists its cost as unknown", async () => {
    const { call } = setup(["gemini"])
    const capped = await call("agent", "c", "gemini", "brief me", "--at", "08:30", "--max-cost-per-day", "2")
    expect(capped.code).not.toBe(0)
    expect(capped.err).toContain("agent.cost-unknown")
    expect((await call("agent", "c", "gemini", "brief me", "--at", "08:30")).code).toBe(0)
    const [row] = JSON.parse((await call("list", "--json")).out).items
    expect(row).toMatchObject({
      harness: "gemini",
      reports_cost: false,
      spent_today_usd: null,
      max_cost_usd: null,
      max_cost_per_day_usd: null,
    })
    expect(v.safeParse(scheduledJob, row).success).toBe(true)
  })

  it("names an agent that is not installed by every program it is looked for by", async () => {
    const { call } = setup([])
    const missing = await call("agent", "x", "gemini", "p", "--at", "08:30")
    expect(missing.err).toContain("gemini is not on PATH")
  })
})

describe("the read-only lock", () => {
  type Tree = Record<number, { ppid: number; uid?: number; environ?: string[] }>
  const proc = (tree: Tree) => (path: string) => {
    const [, pid = "", kind] = /^\/proc\/(\d+)\/(\w+)$/.exec(path) ?? []
    const one = tree[Number(pid)]
    if (!one) throw new Error("gone")
    if (kind === "status") return `Name:\tsh\nPPid:\t${one.ppid}\nUid:\t${one.uid ?? 501}\t${one.uid ?? 501}\n`
    if (!one.environ) throw Object.assign(new Error("denied"), { code: "EACCES" })
    return one.environ.join("\0")
  }
  const locked = (tree: Tree, from: number) =>
    lockedByAncestor("CHAT_READ_ONLY", { read: proc(tree), from, uid: 501, cache: new Map() })

  it.runIf(process.platform === "linux")("holds when a process this one descends from was started with it", () => {
    const tree = {
      30: { ppid: 20, environ: ["CHAT_READ_ONLY=0"] },
      20: { ppid: 10, environ: ["CHAT_READ_ONLY=1"] },
      10: { ppid: 0, environ: [] },
    }
    expect([locked(tree, 30), locked(tree, 10)]).toEqual([true, false])
  })

  it.runIf(process.platform === "linux")("holds when /proc cannot be read", () => {
    expect(locked({}, 30)).toBe(true)
    expect(locked({ 30: { ppid: 20, environ: [] } }, 30)).toBe(true)
  })

  it.runIf(process.platform === "linux")("stops at an ancestor another user owns or one that hides its start", () => {
    expect(locked({ 30: { ppid: 20, environ: [] }, 20: { ppid: 1, uid: 0, environ: ["CHAT_READ_ONLY=1"] } }, 30)).toBe(
      false,
    )
    expect(
      locked({ 30: { ppid: 20, environ: [] }, 20: { ppid: 10 }, 10: { ppid: 0, environ: ["CHAT_READ_ONLY=1"] } }, 30),
    ).toBe(false)
  })

  it.runIf(process.platform === "linux")("reads a value from the farthest ancestor that sets it", () => {
    const tree = {
      30: { ppid: 20, environ: ["CHAT_WORK_FOLDER=/home/me"] },
      20: { ppid: 10, environ: ["CHAT_WORK_FOLDER=/tmp/wirecat-agent-1"] },
      10: { ppid: 1, uid: 0 },
    }
    const ancestry = { read: proc(tree), from: 30, uid: 501, cache: new Map() }
    expect(ancestorValue("CHAT_WORK_FOLDER", { CHAT_WORK_FOLDER: "/" }, ancestry)).toBe("/tmp/wirecat-agent-1")
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
