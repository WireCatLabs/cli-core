import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PassThrough } from "node:stream"
import { captureStreams } from "@wirecat/cli-base"
import { memoryKeyring } from "@wirecat/cli-base/testing"
import { describe, expect, it } from "vitest"
import { fakeProfileServer } from "../../testing/fake-mcp-child.js"
import { sharedCommands } from "../../testing/shared-program.js"
import { provide } from "../context.js"
import { createProgram } from "../program.js"
import { settingsFor } from "../settings.js"
import type { Messenger } from "./context.js"

const app = {
  command: "chat",
  appName: "chat-cli",
  envPrefix: "CHAT",
  description: "A test messenger",
  version: "1.0.0",
}

const messenger: Messenger = {
  app,
  provider: "chat",
  name: "Chat",
  resolveSettings: settingsFor(app).resolveSettings,
  connect: async () => {
    throw new Error("the server of every profile never connects itself")
  },
  chatArgument: "a chat",
}

/** `chat mcp serve --profiles` as an agent runs it: requests on stdin, then stdin closes; the answers are on stdout. */
const serve = async (
  requests: object[],
  {
    profiles = ["work", "personal"],
    argv = ["mcp", "serve", "--profiles", "all"],
    profileState = undefined as Messenger["profileState"],
    extra = {} as Record<string, string>,
  } = {},
) => {
  const root = mkdtempSync(join(tmpdir(), "mcp-every-"))
  const env = {
    CHAT_CONFIG_DIR: join(root, "config"),
    CHAT_STATE_DIR: join(root, "state"),
    MESSAGING_STORE: join(root, "m.db"),
    ...extra,
  }
  mkdirSync(env.CHAT_CONFIG_DIR, { recursive: true })
  writeFileSync(
    join(env.CHAT_CONFIG_DIR, "config.json"),
    JSON.stringify({ profiles: Object.fromEntries(profiles.map((one) => [one, {}])) }),
  )
  const { script, log } = fakeProfileServer()
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  let written = ""
  stdout.on("data", (chunk) => {
    written += chunk
  })
  const streams = captureStreams()
  const program = createProgram({ app, commands: () => sharedCommands({ ...messenger, profileState }) })
  provide(program, {
    streams,
    tty: false,
    env,
    app,
    keyring: memoryKeyring(),
    stdin,
    stdout,
    mcp: { execPath: process.execPath, scriptPath: script },
  } as Parameters<typeof provide>[1])
  for (const request of requests) stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...request })}\n`)
  stdin.end()
  const failure = await program.parseAsync(argv, { from: "user" }).then(
    () => undefined,
    (error: Error) => error,
  )
  const answers = written
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { id: number; result: Record<string, unknown> })
  return { answers, log: () => readFileSync(log, "utf8"), failure, stderr: streams.stderr }
}

const HANDSHAKE = [
  {
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } },
  },
  { method: "notifications/initialized" },
]

describe("chat mcp serve --profiles", () => {
  it("--profiles all serves every profile: each tool takes one, and a call runs in `chat <profile> mcp serve`", async () => {
    const { answers, log, stderr } = await serve([
      ...HANDSHAKE,
      { id: 2, method: "tools/list" },
      { id: 3, method: "tools/call", params: { name: "chat_read", arguments: { profile: "work", command: "inbox" } } },
    ])
    const [hello, listed, called] = [1, 2, 3].map((id) => answers.find((one) => one.id === id)?.result)
    expect(String(hello?.instructions)).toContain('every tool needs "profile" — ask if none was named')
    expect(listed).toMatchObject({
      tools: [{ name: "chat_read", inputSchema: { required: ["profile", "command"] } }],
    })
    expect(JSON.parse(((called?.content ?? []) as { text: string }[])[0]?.text ?? "")).toMatchObject({
      profile: "work",
      arguments: { command: "inbox" },
    })
    expect(log()).toContain("start work mcp serve")
    expect(stderr.join("")).toContain("serving every profile (personal, work)")
  })

  it("serves only the profiles listed, and refuses a call for another", async () => {
    const { answers, stderr } = await serve(
      [
        ...HANDSHAKE,
        { id: 2, method: "tools/list" },
        { id: 3, method: "tools/call", params: { name: "chat_read", arguments: { profile: "home", command: "x" } } },
      ],
      { profiles: ["work", "personal", "home"], argv: ["mcp", "serve", "--profiles", "work, personal,work"] },
    )
    const listed = answers.find((one) => one.id === 2)?.result as { tools: { inputSchema: object }[] }
    expect(JSON.stringify(listed.tools[0]?.inputSchema)).toContain('"enum":["personal","work"]')
    expect(JSON.stringify(answers.find((one) => one.id === 3)?.result)).toContain("one of: personal, work")
    expect(stderr.join("")).toContain("serving profiles personal, work")
  })

  it.each([
    [["mcp", "serve"], "validation_error", "name the profiles to serve"],
    [["mcp", "serve", "--profiles", "work,nobody"], "validation_error", 'no profile named "nobody"'],
    [["mcp", "serve", "--profiles", "all,work"], "validation_error", "`all` alone for every profile"],
  ])("refuses %j and lists the profiles", async (argv, code, words) => {
    const { failure, answers } = await serve(HANDSHAKE, { argv })
    expect(failure).toMatchObject({ code, details: { profiles: ["personal", "work"] } })
    expect(failure?.message).toContain(words)
    expect(answers).toEqual([])
  })

  it("under a profile lock, --profiles may name the locked profile only", async () => {
    for (const given of ["all", "work,personal"]) {
      const { failure } = await serve(HANDSHAKE, {
        argv: ["mcp", "serve", "--profiles", given],
        extra: { CHAT_PROFILE_LOCK: "work" },
      })
      expect(failure).toMatchObject({ code: "permission_error" })
    }
    const { failure, stderr } = await serve(HANDSHAKE, {
      argv: ["mcp", "serve", "--profiles", "work"],
      extra: { CHAT_PROFILE_LOCK: "work" },
    })
    expect(failure).toBeUndefined()
    expect(stderr.join("")).toContain("serving profile work")
  })

  it("passes a stricter permission on to every profile's server", async () => {
    const { log } = await serve(
      [
        ...HANDSHAKE,
        {
          id: 2,
          method: "tools/call",
          params: { name: "chat_read", arguments: { profile: "personal", command: "x" } },
        },
      ],
      { argv: ["mcp", "serve", "--profiles", "all", "--permission", "messages.send=deny"] },
    )
    expect(log()).toContain("start personal mcp serve --permission messages.send=deny")
  })

  it("marks the profiles not signed in, leaves bots out, and refuses a call for one with how to sign in", async () => {
    const states = { default: "signed-out", personal: "signed-in", news: "bot" } as const
    const { answers, log } = await serve(
      [
        ...HANDSHAKE,
        { id: 2, method: "tools/list" },
        {
          id: 3,
          method: "tools/call",
          params: { name: "chat_read", arguments: { profile: "default", command: "x" } },
        },
      ],
      { profiles: ["default", "news", "personal"], profileState: (profile) => states[profile as keyof typeof states] },
    )
    const listed = answers.find((one) => one.id === 2)?.result as {
      tools: { inputSchema: { properties: { profile: { enum: string[]; oneOf: object[]; description: string } } } }[]
    }
    const profile = listed.tools[0]?.inputSchema.properties.profile
    expect(profile?.enum).toEqual(["default", "personal"])
    expect(profile?.oneOf).toEqual([
      { const: "default", title: "default — not signed in" },
      { const: "personal", title: "personal" },
    ])
    expect(profile?.description).toContain("Signed in: personal · Not signed in: default.")
    expect(profile?.description).toContain("ask which — never guess")
    const refused = answers.find((one) => one.id === 3)?.result as { isError: boolean; content: { text: string }[] }
    expect(refused.isError).toBe(true)
    expect(refused.content[0]?.text).toContain("profile default is not signed in — run `chat default setup`")
    expect(refused.content[0]?.text).toContain("or sign in from WireCat Desktop")
    expect(log()).not.toContain("start default mcp")
  })

  it("marks a listed profile not signed in and refuses its call, and refuses a bot in the list", async () => {
    const states = { default: "signed-out", personal: "signed-in", news: "bot" } as const
    const profileState = (profile: string) => states[profile as keyof typeof states]
    const { answers } = await serve(
      [
        ...HANDSHAKE,
        { id: 2, method: "tools/list" },
        { id: 3, method: "tools/call", params: { name: "chat_read", arguments: { profile: "default", command: "x" } } },
      ],
      {
        profiles: ["default", "news", "personal"],
        profileState,
        argv: ["mcp", "serve", "--profiles", "default,personal"],
      },
    )
    expect(JSON.stringify(answers.find((one) => one.id === 2)?.result)).toContain('"title":"default — not signed in"')
    expect(JSON.stringify(answers.find((one) => one.id === 3)?.result)).toContain("profile default is not signed in")

    const { failure } = await serve(HANDSHAKE, {
      profiles: ["default", "news", "personal"],
      profileState,
      argv: ["mcp", "serve", "--profiles", "news,personal"],
    })
    expect(failure).toMatchObject({ code: "validation_error" })
    expect(failure?.message).toContain("news is a bot profile")
  })

  it("says so when there is no profile on this computer yet", async () => {
    const { failure } = await serve(HANDSHAKE, { profiles: [] })
    expect(failure?.message ?? "").toContain("no chat profile on this computer yet")
  })
})
