import { mkdirSync, mkdtempSync, truncateSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PassThrough } from "node:stream"
import { captureStreams } from "@wirecat/cli-base"
import { COMMANDS_PAGE_LABELS, commandsPage, describeOptions, describeProgram } from "@wirecat/cli-base/commands"
import { memoryKeyring } from "@wirecat/cli-base/testing"
import { afterEach, describe, expect, it, vi } from "vitest"
import { isEngineInstalled } from "../engines/install.js"
import { ENGINE_PINS } from "../engines/pins.js"
import { placeEngines } from "../kit/engines.js"
import { isInstalled, modelPath, modelsDirectory, vadPath } from "../speech/install.js"
import { speechModel, VAD } from "../speech/models.js"
import { sharedProgram } from "../testing/shared-program.js"
import { commandHelpMarkdown } from "./help/command-help.js"
import { createProgram, run } from "./program.js"

const folder = () => {
  const root = mkdtempSync(join(tmpdir(), "engine-surface-"))
  return {
    HOME: root,
    CHAT_PROFILE: "default",
    CHAT_STATE_DIR: join(root, "state"),
    CHAT_CONFIG_DIR: join(root, "config"),
    MESSAGING_STORE: join(root, "m.db"),
    WIRECAT_STATE_DIR: join(root, "wirecat"),
  }
}

/** Every engine and a speech model in place, as on a machine where voice has run. */
const full = () => {
  const env = folder()
  placeEngines(env)
  const directory = modelsDirectory(env)
  // The smallest model: its files are sparse here, but not on every file system a runner has.
  for (const model of [speechModel("gigaam-v3-ctc")]) {
    mkdirSync(join(directory, model.id), { recursive: true })
    for (const [path, bytes] of [
      [vadPath(directory), VAD.bytes] as const,
      ...model.files.map((file) => [modelPath(directory, model)(file.name), file.bytes] as const),
    ]) {
      writeFileSync(path, "")
      truncateSync(path, bytes)
    }
  }
  return env
}

const printed = async (argv: string[], env: NodeJS.ProcessEnv) => {
  const streams = captureStreams()
  const code = await run(argv, sharedProgram, { streams, tty: false, env, keyring: memoryKeyring() })
  return { code, out: streams.stdout.join("") }
}

const HELP = [
  [],
  ["messages"],
  ["messages", "transcribe"],
  ["messages", "list"],
  ["models"],
  ["models", "download"],
  ["models", "list"],
  ["inbox"],
  ["review"],
]

/** The MCP server's tools and every command its search lists, as an agent sees them. */
const mcpListing = async (env: NodeJS.ProcessEnv) => {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  let written = ""
  stdout.on("data", (chunk) => {
    written += chunk
  })
  const requests = [
    {
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } },
    },
    { method: "notifications/initialized" },
    { id: 2, method: "tools/list" },
    { id: 3, method: "tools/call", params: { name: "chat_tools_search", arguments: {} } },
  ]
  for (const request of requests) stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...request })}\n`)
  stdin.end()
  const streams = captureStreams()
  await run(["mcp", "serve"], sharedProgram, {
    streams,
    tty: false,
    env,
    keyring: memoryKeyring(),
    stdin,
    stdout,
  } as Parameters<typeof run>[2])
  const answers = written
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { id: number; result: { tools?: unknown[]; content?: { text: string }[] } })
  const tools = answers.find(({ id }) => id === 2)?.result.tools
  // Each run's id and duration differ; the listing is what an agent reads.
  const { meta: _, ...listed } = JSON.parse(answers.find(({ id }) => id === 3)?.result.content?.[0]?.text ?? "{}")
  return { tools, listed }
}

const docs = (env: NodeJS.ProcessEnv) => {
  vi.stubEnv("WIRECAT_STATE_DIR", env.WIRECAT_STATE_DIR)
  const program = createProgram(sharedProgram)
  return commandsPage({
    cli: "chat",
    commands: describeProgram(program),
    options: describeOptions(program),
    labels: COMMANDS_PAGE_LABELS.en,
    text: {
      banner: "<!-- generated -->",
      title: "Commands",
      intro: "",
      globalHeading: "Global options",
      globalIntro: "",
      mutates: "Changes something outside this machine.",
      mutatesLocal: "Changes something on this machine only.",
      exitHeading: "Exit codes",
      exitIntro: "",
      outro: "",
    },
    details: (command) => commandHelpMarkdown(program, command.path),
  })
}

const surface = async (env: NodeJS.ProcessEnv) => {
  vi.stubEnv("WIRECAT_STATE_DIR", env.WIRECAT_STATE_DIR)
  const help: Record<string, string> = {}
  for (const path of HELP) help[path.join(" ")] = (await printed([...path, "--help"], env)).out
  return {
    help,
    commands: JSON.parse((await printed(["commands", "--json"], env)).out),
    docs: docs(env),
    mcp: await mcpListing(env),
  }
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe("a command whose engine is not installed", () => {
  it("**no command disappears**: --help, commands, the generated docs and the MCP tools are the same with an empty data folder and a full one", async () => {
    const empty = folder()
    const installed = full()
    expect(Object.values(ENGINE_PINS).every((pin) => isEngineInstalled(pin, installed))).toBe(true)
    expect(isInstalled(speechModel("gigaam-v3-ctc"), modelsDirectory(installed))).toBe(true)
    expect(Object.values(ENGINE_PINS).some((pin) => isEngineInstalled(pin, empty))).toBe(false)

    const without = await surface(empty)
    const withAll = await surface(installed)

    for (const key of ["help", "commands", "docs", "mcp"] as const)
      expect(JSON.stringify(withAll[key], null, 1), key).toBe(JSON.stringify(without[key], null, 1))
    expect(without.help["messages transcribe"]).toContain("--local")
    expect(without.docs).toContain("messages transcribe")
    expect(JSON.stringify(without.commands)).toContain("messages transcribe")
    expect(without.mcp.tools).toHaveLength(3)
    expect(JSON.stringify(without.mcp.listed)).toContain("messages transcribe")
  })
})
