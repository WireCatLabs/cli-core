import { PassThrough } from "node:stream"
import { CliError, captureStreams } from "@wirecat/cli-base"
import { annotate as described } from "@wirecat/cli-base/commands"
import { Argument, Command, Option } from "commander"
import { describe, expect, it, vi } from "vitest"
import { readSecret } from "../terminal/prompt.js"
import { commandContract, findCommand, resultSchemaFor } from "./command-contract.js"
import { commandsCommand } from "./commands-command.js"
import { environmentOf, outputFor } from "./context.js"
import { preview } from "./preview.js"
import { run } from "./program.js"

const app = {
  command: "fixture",
  appName: "fixture-cli",
  envPrefix: "FIXTURE",
  description: "Synthetic agent tasks",
  version: "1.2.3",
}
const configuration = {
  resolveSettings: () => ({
    profile: "default",
    keepFailedRuns: false,
    keepRunsForDays: 1,
    skillHint: false,
    permissions: {},
  }),
}

const invoke = async (
  argv: string[],
  options: Parameters<typeof run>[2] = {},
  action?: (command: Command) => Promise<void>,
) => {
  const prepare = vi.fn()
  const performed = vi.fn(async function (this: Command) {
    if (action) await action(this)
    else outputFor(this).renderer.result({ id: "synthetic", text: "synthetic payload", operationId: "op-synthetic" })
  })
  const streams = captureStreams()
  const result = await run(
    argv,
    {
      app,
      configuration,
      prepare,
      commands: () => [
        described(
          new Command("messages").addCommand(
            new Command("send").argument("<chat>").argument("[text]").action(performed),
          ),
          { mutates: true },
        ),
        new Command("setup").option("--agent <agent>").action(performed),
        new Command("session").addCommand(
          new Command("start").argument("[method]").option("--qr-file <path>").action(performed),
        ),
        new Command("watch").option("--term").action(async function (this: Command) {
          const stopped = environmentOf(this).signal
          setImmediate(() => process.emit(this.opts<{ term?: boolean }>().term ? "SIGTERM" : "SIGINT"))
          await new Promise((resolve) => stopped?.addEventListener("abort", resolve, { once: true }))
        }),
        new Command("post").action(async function (this: Command) {
          const stopped = environmentOf(this).signal
          await new Promise((_, reject) =>
            stopped?.addEventListener(
              "abort",
              () => reject(new CliError("outcome_unknown", "synthetic write got no answer")),
              { once: true },
            ),
          )
        }),
        new Command("wait").option("--term").action(async function (this: Command) {
          setImmediate(() => process.emit(this.opts<{ term?: boolean }>().term ? "SIGTERM" : "SIGINT"))
          await new Promise(() => {})
        }),
        commandsCommand(app),
      ],
    },
    { ...options, streams, tty: options?.tty ?? false },
  )
  return { result, prepare, performed, stdout: streams.stdout, stderr: streams.stderr }
}

describe("agent CLI contract", () => {
  it("previews without prepare, action, payload content or credential input", async () => {
    const result = await invoke(["messages", "send", "chat-synthetic", "synthetic payload", "--dry-run", "--json"])
    expect(result.result).toBe(0)
    expect(result.prepare).not.toHaveBeenCalled()
    expect(result.performed).not.toHaveBeenCalled()
    expect(result.stdout.join()).not.toContain("synthetic payload")
    expect(JSON.parse(result.stdout[0] ?? "")).toMatchObject({
      preview: true,
      effects: { actionInvoked: false, writeReserved: false },
    })
  })

  it("runs setup without a terminal, where it decides itself what needs one", async () => {
    const result = await invoke(["setup", "--agent", "codex", "--json"])
    expect(result.result).toBe(0)
    expect(result.performed).toHaveBeenCalledOnce()
  })

  it("leaves a login without a terminal to the command, which knows what it must ask", async () => {
    const result = await invoke(["session", "start", "qr", "--json"])
    expect(result.result).toBe(0)
    expect(result.performed).toHaveBeenCalledOnce()
  })

  it("ends a listening command on Ctrl-C with 0, and any other with 130", async () => {
    expect((await invoke(["watch", "--json"])).result).toBe(0)
    expect((await invoke(["wait", "--json"])).result).toBe(130)
  })

  it("ends a listening command on SIGTERM with 0 and nothing on stderr, and any other with 143", async () => {
    const listening = await invoke(["watch", "--term", "--json"])
    expect(listening.result).toBe(0)
    expect(listening.stderr).toEqual([])
    expect((await invoke(["wait", "--term", "--json"])).result).toBe(143)
  })

  it("allows an explicit QR artifact while keeping headless prompts disabled", async () => {
    const result = await invoke(["session", "start", "qr", "--qr-file", "synthetic.png", "--json"])
    expect(result.result).toBe(0)
    expect(result.performed).toHaveBeenCalledOnce()
    const input = Object.assign(new PassThrough(), { isTTY: true })
    const prompted = await invoke(
      ["session", "start", "qr", "--qr-file", "synthetic.png", "--json"],
      { tty: true, stdin: input },
      async (command) => {
        await readSecret("credential", { input: environmentOf(command).stdin })
      },
    )
    expect(prompted.result).toBe(2)
    expect(JSON.parse(prompted.stderr[0] ?? "").error.reason).toBe("input.required")
  })

  it("reports a command's own unknown outcome when --timeout stops it, never a plain timeout", async () => {
    const result = await invoke(["--timeout", "50ms", "post", "--json"])
    expect(JSON.parse(result.stderr[0] ?? "").error.code).toBe("outcome_unknown")
  })

  it("makes JSON on a TTY headless before a secret prompt", async () => {
    const input = Object.assign(new PassThrough(), { isTTY: true })
    const result = await invoke(
      ["messages", "send", "synthetic", "--json"],
      { tty: true, stdin: input },
      async (command) => {
        await readSecret("credential", { input: environmentOf(command).stdin })
      },
    )
    expect(result.result).toBe(2)
    expect(result.stdout).toEqual([])
    expect(JSON.parse(result.stderr[0] ?? "").error.reason).toBe("input.required")
  })

  it("allows headless setup to verify existing credentials without prompting", async () => {
    const result = await invoke(["setup", "--json"])
    expect(result.result).toBe(0)
    expect(result.performed).toHaveBeenCalledOnce()
  })

  it("still refuses a credential prompt inside headless setup", async () => {
    const input = Object.assign(new PassThrough(), { isTTY: true })
    const result = await invoke(["setup", "--json"], { tty: true, stdin: input }, async (command) => {
      await readSecret("credential", { input: environmentOf(command).stdin })
    })
    expect(result.result).toBe(2)
    expect(JSON.parse(result.stderr[0] ?? "").error.reason).toBe("input.required")
  })

  it("allows explicit piped credentials while --no-input is set", async () => {
    const input = new PassThrough()
    input.end("synthetic credential")
    const result = await invoke(
      ["messages", "send", "synthetic", "--no-input", "--json"],
      { stdin: input },
      async (command) => {
        expect(await readSecret("credential", { input: environmentOf(command).stdin })).toBe("synthetic credential")
      },
    )
    expect(result.result).toBe(0)
  })

  it("bounds open stdin with the whole-command deadline", async () => {
    const input = new PassThrough()
    const result = await invoke(
      ["messages", "send", "synthetic", "--timeout", "5ms", "--json"],
      { stdin: input },
      async (command) => {
        await readSecret("credential", { input: environmentOf(command).stdin })
      },
    )
    expect(result.result).toBe(9)
    expect(JSON.parse(result.stderr[0] ?? "").error.code).toBe("timeout")
    expect(input.listenerCount("data")).toBe(0)
  })

  it("projects fields and fails visibly before an oversized document is emitted", async () => {
    const projected = await invoke(["messages", "send", "synthetic", "--json=id"])
    expect(JSON.parse(projected.stdout[0] ?? "")).toEqual({ id: "synthetic", operationId: "op-synthetic" })
    const bounded = await invoke(["messages", "send", "synthetic", "--json", "--max-output-bytes", "4"])
    expect(bounded.result).not.toBe(0)
    expect(bounded.stdout).toEqual([])
    expect(JSON.parse(bounded.stderr[0] ?? "").error).toMatchObject({
      reason: "output.too-large",
      details: { retryable: false },
    })
  })

  it("publishes a separately versioned schema without changing the application version", async () => {
    const result = await invoke(["commands", "schema", "messages", "send", "--json"])
    expect(result.result).toBe(0)
    expect(JSON.parse(result.stdout[0] ?? "")).toMatchObject({
      version: "1.2.3",
      schemaVersion: 1,
      path: ["messages", "send"],
      inputSchema: { $schema: "https://json-schema.org/draft/2020-12/schema" },
    })
  })

  it("describes variadic choices on items, inherited flags, conflicts and unknown paths", () => {
    const root = new Command("fixture").option("--json")
    const leaf = new Command("probe")
      .addArgument(new Argument("<kinds...>").choices(["one", "two"]))
      .addOption(new Option("--offline").conflicts("refresh"))
      .addOption(new Option("--refresh").implies({ online: true }))
    root.addCommand(leaf)
    const contract = commandContract(findCommand(root, ["probe"]))
    expect(contract.inputSchema.properties.arguments.properties.kinds).toMatchObject({
      type: "array",
      items: { enum: ["one", "two"] },
    })
    expect(contract.validation.conflicts).toEqual([["offline", "refresh"]])
    expect(contract.validation.implications).toHaveLength(1)
    expect(() => findCommand(root, ["absent"])).toThrow("unknown command path")
    expect(resultSchemaFor(["messages", "list"]).coverage).toBe("declared-domain-fields")
    expect(resultSchemaFor(["tasks", "list"]).coverage).toBe("collection-with-open-items")
  })
})

it("refuses preview of denied source data and write paths before exposing targets", () => {
  const root = new Command("fixture")
  const stats = new Command("stats").addCommand(new Command("messages").addCommand(new Command("show")))
  root.addCommand(stats)
  const leaf = findCommand(root, ["stats", "messages", "show"])
  expect(() => preview(leaf, { messages: "deny" })).toThrow("messages")
  expect(() => preview(leaf, { "messages.stats": "deny" })).toThrow("config migrate")
  root.addCommand(new Command("messages").addCommand(new Command("send")))
  expect(() => preview(findCommand(root, ["messages", "send"]), { messages: "readonly" })).toThrow("does not permit")
})

it("honors the whole-command timeout environment and explicit flag precedence", async () => {
  const hung = await invoke(
    ["messages", "send", "synthetic", "--json"],
    { env: { ...process.env, FIXTURE_TIMEOUT: "5ms" } },
    async () => new Promise(() => {}),
  )
  expect(hung.result).toBe(9)
  expect(hung.stderr.join()).toContain("5ms")
  const overridden = await invoke(
    ["messages", "send", "synthetic", "--json", "--timeout", "100ms"],
    { env: { ...process.env, FIXTURE_TIMEOUT: "5ms" } },
    async () => {
      await new Promise((resolve) => setTimeout(resolve, 15))
      throw new CliError("not_found", "synthetic")
    },
  )
  expect(overridden.result).toBe(6)
})
