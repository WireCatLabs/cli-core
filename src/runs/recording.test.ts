import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { CliError, captureStreams } from "@wirecat/cli-base"
import { expectRegisteredEvents } from "@wirecat/cli-base/testing"
import { Command, Option } from "commander"
import { describe, expect, it } from "vitest"
import { providerRequest } from "../cli/command-runs.js"
import { type BaseContext, baseContext } from "../cli/context.js"
import { run } from "../cli/program.js"
import { runsCommand } from "../cli/runs/command.js"
import { settingsFor } from "../cli/settings.js"
import { CORE_LOG_EVENTS } from "./log-events.js"
import { EVENTS_AT_MOST } from "./recording.js"
import { findRun, listRuns, readEvents, runsDirFor } from "./run.js"
import { secretInput } from "./run-context.js"
import { runEvent, withAttempt } from "./scope.js"

const app = { command: "app", appName: "app-cli", envPrefix: "APP", description: "A test CLI", version: "1.2.3" }
const { resolveSettings } = settingsFor(app)

const TITLE = "Family Secrets"
const BODY = "the pin is 4321"
const FAKE_SECRET = "FAKE-secret-not-real"
const INPUT_OFF = JSON.stringify({ defaults: { record_input: false } })

type Action = (context: BaseContext) => Promise<unknown>

const call = async (
  argv: string[],
  action: Action = async () => {},
  config?: string,
  extraEnv: Record<string, string> = {},
) => {
  const root = mkdtempSync(join(tmpdir(), "runs-recording-"))
  const env = {
    APP_PROFILE: "default",
    APP_STATE_DIR: join(root, "state"),
    APP_CONFIG_DIR: join(root, "config"),
    ...extraEnv,
  }
  if (config !== undefined) {
    mkdirSync(env.APP_CONFIG_DIR, { recursive: true })
    writeFileSync(join(env.APP_CONFIG_DIR, "config.json"), config)
  }
  const streams = captureStreams()
  const definition = {
    app,
    commands: () => [
      new Command("messages").addCommand(
        new Command("send")
          .argument("<chat>")
          .argument("<text>")
          .option("--caption <caption>")
          .option("--limit <n>")
          .addOption(secretInput(new Option("--pin <code>")))
          .option("--api-key <key>")
          .action(async function (this: Command) {
            const context = baseContext(this, resolveSettings)
            context.renderer.result(
              await context.run(async (events) => {
                events({ event: "request", operation: "messages.send", ids: { chat: "777" } })
                const answer = await action(context)
                events({ event: "response", operation: "messages.send", durationMs: 5, outcome: "ok" })
                return answer ?? { sent: true }
              }),
            )
          }),
      ),
      runsCommand(app),
    ],
  }
  const code = await run(argv, definition, { streams, tty: false, env })
  const runsDir = runsDirFor(app, env)
  return { code, streams, runsDir, env }
}

const everythingUnder = (dir: string): string =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => readFileSync(join(entry.parentPath, entry.name), "utf8"))
    .join("\n")

const everythingButArgv = (dir: string): string => everythingUnder(dir).replace(/"argv":\s*\[[^\]]*\]/g, "")

describe("a recorded run", () => {
  it("**keeps ids, timings and the words typed, and the text nowhere but the words typed**", async () => {
    const { code, streams, runsDir } = await call(["messages", "send", TITLE, BODY, "--record", "--json"])

    expect(code).toBe(0)
    expect(streams.stdout).toHaveLength(1)
    expect(JSON.parse(streams.stdout[0] ?? "")).toEqual({ sent: true })

    const [metadata] = listRuns(runsDir)
    expect(metadata).toMatchObject({ command: "messages send", status: "success", requests: 1, cliVersion: "1.2.3" })
    expect(metadata?.argv).toEqual(["messages", "send", TITLE, BODY, "--record", "--json"])
    const kept = everythingButArgv(runsDir)
    expect(kept).toContain('"chat":"777"')
    expect(kept).not.toContain(TITLE)
    expect(kept).not.toContain(BODY)
  })

  it("is kept when it succeeds without being asked, and only when it fails under record: false", async () => {
    expect(listRuns((await call(["messages", "send", TITLE, BODY])).runsDir)).toMatchObject([{ status: "success" }])
    const off = JSON.stringify({ defaults: { record: false } })
    expect(listRuns((await call(["messages", "send", TITLE, BODY], undefined, off)).runsDir)).toEqual([])
  })

  it("keeps the words typed only when it fails, under record_input: failed", async () => {
    const failedOnly = JSON.stringify({ defaults: { record_input: "failed" } })
    const success = await call(["messages", "send", TITLE, BODY], undefined, failedOnly)
    expect(listRuns(success.runsDir)[0]?.argv).toEqual(["messages", "send", "[redacted]", "[redacted]"])
    const failure = await call(
      ["messages", "send", TITLE, BODY],
      async () => {
        throw new CliError("timeout", "slow")
      },
      failedOnly,
    )
    expect(listRuns(failure.runsDir)[0]?.argv).toEqual(["messages", "send", TITLE, BODY])
  })

  it("is kept when it fails under record: false, with the code a script branches on and the sentence masked", async () => {
    const off = JSON.stringify({ defaults: { record: false } })
    const { code, runsDir } = await call(
      ["messages", "send", TITLE, BODY],
      async () => {
        throw new CliError("provider_error", `Telegram refused "${BODY}"`, { provider_error: "PEER_ID_INVALID" })
      },
      off,
    )

    expect(code).toBe(11)
    expect(listRuns(runsDir)).toHaveLength(1)
    const [metadata] = listRuns(runsDir)
    expect(metadata).toMatchObject({
      status: "failed",
      errorCode: "provider_error",
      providerError: "PEER_ID_INVALID",
      keptBecauseFailed: true,
    })
    expect(everythingButArgv(runsDir)).not.toContain(BODY)
  })

  it("is not kept when it fails with --no-record", async () => {
    const { runsDir } = await call(["messages", "send", TITLE, BODY, "--no-record"], async () => {
      throw new CliError("provider_error", "refused")
    })

    expect(listRuns(runsDir)).toEqual([])
  })

  it("**finishes as a timeout, not as running, when --timeout ends it**", async () => {
    const { code, runsDir } = await call(
      ["messages", "send", TITLE, BODY, "--record", "--timeout", "50ms"],
      (context) => {
        return new Promise((_, reject) => {
          context.track({ close: async () => reject(new CliError("network_error", "closed")) })
        })
      },
    )

    expect(code).toBe(9)
    expect(listRuns(runsDir)[0]).toMatchObject({ status: "failed", errorCode: "timeout" })
  })

  it("shows its events on stderr with --trace", async () => {
    const { streams } = await call(["messages", "send", TITLE, BODY, "--trace", "--no-record"])

    expect(streams.stderr.map((line) => JSON.parse(line).operation)).toEqual(["messages.send", "messages.send"])
  })
})

describe("what a run says about how it was started", () => {
  const PHONE = "+79161234567"
  const runFile = (runsDir: string) => {
    const [metadata] = listRuns(runsDir)
    const found = readdirSync(runsDir, { recursive: true }).find((entry) => String(entry).endsWith("run.json"))
    return { metadata, raw: readFileSync(join(runsDir, String(found)), "utf8") }
  }

  it("**keeps the whole command and its arguments as typed**, a phone number hidden", async () => {
    const { runsDir } = await call(
      ["messages", "send", PHONE, BODY, "--caption", TITLE, "--limit", "5", "--record"],
      undefined,
      undefined,
      { CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "6f1c2a9e-session" },
    )

    expect(JSON.parse(runFile(runsDir).raw)).toMatchObject({
      command: "messages send",
      cli_command: "app messages send",
      argv: ["messages", "send", "[redacted]", BODY, "--caption", TITLE, "--limit", "5", "--record"],
      agent: { kind: "claude-code", session_id: "6f1c2a9e-session" },
    })
  })

  it("**never keeps a secret typed: a marked input, one named for a key, or a URL's password**", async () => {
    const proxy = `socks5://me:${FAKE_SECRET}@127.0.0.1:1080`
    const { runsDir } = await call([
      "messages",
      "send",
      "777",
      proxy,
      "--pin",
      FAKE_SECRET,
      `--api-key=${FAKE_SECRET}`,
      `--token=${FAKE_SECRET}`,
      "--record",
    ])

    expect(listRuns(runsDir)[0]?.argv).toEqual([
      "messages",
      "send",
      "777",
      "[redacted]",
      "--pin",
      "[redacted]",
      "--api-key=[redacted]",
      "--token=[redacted]",
      "--record",
    ])
    expect(everythingUnder(runsDir)).not.toContain(FAKE_SECRET)
  })

  it("**masks message text and phone numbers with `record_input: false`**, as before the setting", async () => {
    const { runsDir } = await call(
      ["messages", "send", PHONE, BODY, "--caption", TITLE, "--limit", "5", "--record"],
      undefined,
      INPUT_OFF,
      { CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "6f1c2a9e-session" },
    )

    const { raw } = runFile(runsDir)
    const written = JSON.parse(raw)
    expect(written).toMatchObject({
      command: "messages send",
      cli_command: "app messages send",
      argv: ["messages", "send", "[redacted]", "[redacted]", "--caption", "[redacted]", "--limit", "5", "--record"],
      agent: { kind: "claude-code", session_id: "6f1c2a9e-session" },
    })
    expect(everythingUnder(runsDir)).not.toContain(PHONE)
    expect(everythingUnder(runsDir)).not.toContain("79161234567")
    expect(everythingUnder(runsDir)).not.toContain(BODY)
    expect(everythingUnder(runsDir)).not.toContain(TITLE)
  })

  it("keeps that an OpenClaw run came from a chat, and never who sent it or from which chat", async () => {
    const { runsDir } = await call(["messages", "list", "--record"], undefined, undefined, {
      OPENCLAW_SHELL: "exec",
      OPENCLAW_CHANNEL_CONTEXT: '{"sender":{"id":"sender-77"},"chat":{"id":"chat-88"}}',
    })

    const { raw } = runFile(runsDir)
    expect(JSON.parse(raw).agent).toEqual({ kind: "openclaw", session_id: null, from_chat: true })
    expect(everythingUnder(runsDir)).not.toMatch(/sender-77|chat-88/)
  })

  it("names the word that was no command, and keeps the profile", async () => {
    const { runsDir } = await call(["work", "mesages", "list", BODY])

    const { raw } = runFile(runsDir)
    expect(JSON.parse(raw)).toMatchObject({
      command: "app",
      cli_command: "app",
      unknown_command: "mesages",
      argv: ["work", "mesages", "list", BODY],
    })
    expect(JSON.parse(raw)).not.toHaveProperty("agent")
    const off = runFile((await call(["work", "mesages", "list", BODY], undefined, INPUT_OFF)).runsDir)
    expect(JSON.parse(off.raw).argv).toEqual(["work", "mesages", "[redacted]", "[redacted]"])
  })

  it("says what went wrong: class, masked message, where the call went, the cause and our own frames", async () => {
    const { runsDir } = await call(["messages", "send", "777", BODY], async () => {
      throw new CliError("rate_limited", `MAX refused "${BODY}" from ${PHONE}`, {
        status: 429,
        method: "post",
        endpoint: `https://botapi.max.ru/chats/777/messages?access_token=${"x".repeat(12)}`,
        cause: new TypeError(`fetch failed for ${PHONE}`),
      })
    })

    const { raw: written } = runFile(runsDir)
    const raw = JSON.stringify({ ...JSON.parse(written), argv: undefined })
    const { error } = JSON.parse(raw)
    expect(error).toMatchObject({
      class: "CliError",
      code: "rate_limited",
      message: 'MAX refused "[redacted]" from [number]',
      http: { method: "POST", endpoint_template: "https://botapi.max.ru/chats/:id/messages", status: 429 },
      causes: [{ class: "TypeError", message: "fetch failed for [number]" }],
    })
    expect(error.stack[0]).toMatch(/^\S+ \S+:\d+$/)
    expect(raw).not.toContain(homedir())
    expect(raw).not.toContain("access_token")
    expect(raw).not.toContain(BODY)
    expect(raw).not.toContain(PHONE)
  })

  it("names a messenger protocol's refusal by its key and code, not as an HTTP status", async () => {
    const { runsDir } = await call(["messages", "send", "777", BODY], async () => {
      throw new CliError("rate_limited", "Telegram asks to wait 30 s", { provider_error: "FLOOD_WAIT", status: 420 })
    })

    expect(JSON.parse(runFile(runsDir).raw).error).toMatchObject({
      code: "rate_limited",
      provider: { key: "FLOOD_WAIT", code: 420 },
    })
    expect(JSON.parse(runFile(runsDir).raw).error).not.toHaveProperty("http")
  })
})

describe("a failure before the command runs", () => {
  it("is kept, naming the command and keeping what was typed", async () => {
    const { code, runsDir } = await call(["messages", "send", TITLE, "--bogus"])

    expect(code).not.toBe(0)
    expect(listRuns(runsDir)).toHaveLength(1)
    expect(listRuns(runsDir)[0]).toMatchObject({
      command: "messages send",
      status: "failed",
      errorCode: "validation_error",
      keptBecauseFailed: true,
      argv: ["messages", "send", TITLE, "--bogus"],
    })
  })

  it("is kept for a profile with no command after it", async () => {
    const { code, runsDir } = await call(["work"])

    expect(code).toBe(2)
    expect(listRuns(runsDir)[0]).toMatchObject({ command: "app", profile: "work", errorCode: "validation_error" })
  })

  it("is kept when the configuration will not load", async () => {
    const { code, runsDir } = await call(["messages", "send", TITLE, BODY], undefined, "{ not json")

    expect(code).not.toBe(0)
    expect(listRuns(runsDir)).toHaveLength(1)
    expect(listRuns(runsDir)[0]).toMatchObject({ command: "messages send", status: "failed" })
    expect(everythingUnder(runsDir)).not.toContain(BODY)
  })

  it("is not kept with --no-record, nor for --help", async () => {
    expect(listRuns((await call(["messages", "send", TITLE, "--bogus", "--no-record"])).runsDir)).toEqual([])
    expect(listRuns((await call(["messages", "--help"])).runsDir)).toEqual([])
  })
})

describe("the runs command", () => {
  it("lists, shows and locates a recorded run without starting one of its own", async () => {
    const { runsDir, env } = await call(["messages", "send", TITLE, BODY, "--record"])
    const [metadata] = listRuns(runsDir)
    const read = async (argv: string[]) => {
      const streams = captureStreams()
      const code = await run(argv, { app, commands: () => [runsCommand(app)] }, { streams, tty: false, env })
      return { code, answer: streams.stdout[0] ? JSON.parse(streams.stdout[0]) : undefined }
    }

    expect((await read(["runs", "list", "--json"])).answer).toMatchObject({
      items: [{ run_id: metadata?.runId }],
      page: { has_more: false },
    })
    const problems = (await read(["runs", "show", metadata?.runId ?? "", "--problems", "--json"])).answer.item
    expect(problems).toMatchObject({ run_id: metadata?.runId, event_count: 2, events: [] })
    const shown = (await read(["runs", "show", metadata?.runId ?? "", "--json"])).answer.item
    expect(shown.events.map((event: { event: string }) => event.event)).toEqual([
      "provider.request",
      "provider.response",
    ])
    expect(shown.events[0]).not.toHaveProperty("run_id")
    const { path } = (await read(["runs", "path", metadata?.runId ?? "", "--json"])).answer.item
    expect(path).toContain(runsDir)
    expectRegisteredEvents(readFileSync(join(path, "events.jsonl"), "utf8").trim().split("\n"), CORE_LOG_EVENTS)
    expect(listRuns(runsDir)).toHaveLength(1)
    expect((await read(["runs", "path", "no-such-run"])).code).toBe(6)
    expect(listRuns(runsDir).map((one) => one.command)).toContain("runs path")
  })
})

it("records failed batch IDs on a partial run without retaining error payloads", async () => {
  const { code, runsDir } = await call(["messages", "send", TITLE, BODY, "--json"], async () => ({
    batch: {
      failed: 1,
      failures: [{ id: "50", stage: "download", attachment: 2, error: { code: "rate_limited", message: BODY } }],
    },
  }))
  expect(code).toBe(0)
  expect(listRuns(runsDir)[0]).toMatchObject({
    status: "partial",
    partial: { failed: 1, failures: [{ id: "50", stage: "download", attachment: 2, errorCode: "rate_limited" }] },
  })
  expect(everythingButArgv(runsDir)).not.toContain(BODY)
})

describe("request lines in a run", () => {
  it("**come from a wire layer that is handed no sink**, with method, template, attempt and wait, never the URL", async () => {
    const { runsDir } = await call(["messages", "send", "777", "hi", "--record"], async () => {
      const first = providerRequest("messages.send", runEvent, { method: "POST", endpointTemplate: "/chats/:id?x=1" })
      first({ status: 429, errorCode: "rate_limited", providerError: "FLOOD_WAIT" })
      const second = providerRequest("messages.send", runEvent, {
        method: "POST",
        endpointTemplate: "/chats/:id",
        transport: "http",
        attempt: 2,
        waitMs: 3000,
      })
      second({ status: 200, bytes: 120 })
    })
    const [metadata] = listRuns(runsDir)
    // Two wire calls under one operation: the wire count wins, never three.
    expect(metadata?.requests).toBe(2)
    const events = readEvents(findRun(runsDir, metadata?.runId ?? "")?.dir ?? "")
    const wire = events.filter((event) => event.level === "wire")
    expect(wire.map(({ event, attempt, wait_ms, status }) => ({ event, attempt, wait_ms, status }))).toEqual([
      { event: "provider.request", attempt: undefined, wait_ms: undefined, status: undefined },
      { event: "provider.response", attempt: undefined, wait_ms: undefined, status: 429 },
      { event: "provider.request", attempt: 2, wait_ms: 3000, status: undefined },
      { event: "provider.response", attempt: 2, wait_ms: 3000, status: 200 },
    ])
    expect(wire[1]).toMatchObject({ provider_error: "FLOOD_WAIT", endpoint_template: "/chats/:id", method: "POST" })
    expect(JSON.stringify(events)).not.toContain("x=1")
  })

  it("take the attempt and the wait of a retry made above the transport", async () => {
    const { runsDir } = await call(["messages", "send", "777", "hi", "--record"], async () => {
      await withAttempt({ attempt: 2, waitMs: 1500 }, async () => {
        providerRequest("sendMessage", runEvent)({ status: 200 })
      })
    })
    const [metadata] = listRuns(runsDir)
    const wire = readEvents(findRun(runsDir, metadata?.runId ?? "")?.dir ?? "").filter((e) => e.level === "wire")
    expect(wire.map(({ attempt, wait_ms }) => ({ attempt, wait_ms }))).toEqual([
      { attempt: 2, wait_ms: 1500 },
      { attempt: 2, wait_ms: 1500 },
    ])
  })

  it("stop at the cap and count the rest by operation", async () => {
    const { runsDir } = await call(["messages", "send", "777", "hi", "--record"], async () => {
      for (let at = 0; at < EVENTS_AT_MOST + 5; at++) runEvent({ event: "request", operation: "messages.get" })
    })
    const [metadata] = listRuns(runsDir)
    const events = readEvents(findRun(runsDir, metadata?.runId ?? "")?.dir ?? "")
    expect(events.filter((event) => event.event !== "events.dropped")).toHaveLength(EVENTS_AT_MOST)
    // The helper's own request and response come first; its response and six loop requests are past the cap.
    expect(events.at(-1)).toMatchObject({
      event: "events.dropped",
      dropped: 7,
      counts: { "messages.get": 6, "messages.send": 1 },
    })
    expect(metadata?.eventsDropped).toBe(7)
  })
})
