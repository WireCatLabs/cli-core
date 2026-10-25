import { existsSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Readable } from "node:stream"
import { captureStreams, type KeyringStore, keyringService } from "@wirecat/cli-base"
import { memoryKeyring } from "@wirecat/cli-base/testing"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { MessengerAdapter } from "../../ports/messenger.js"
import { analysisChoice } from "../analysis-choice.js"
import { embeddingChoice } from "../embedding-choice.js"
import { run } from "../program.js"
import { settingsFor } from "../settings.js"
import { rememberAccount } from "./accounts.js"
import { contactsCommand } from "./contacts-command.js"
import type { Messenger } from "./context.js"
import { modelsCommand } from "./models-command.js"

const app = { command: "chat", appName: "chat-cli", envPrefix: "CHAT", description: "A test messenger", version: "1" }

const counted = (initial: Record<string, string> = {}) => {
  const inner = memoryKeyring(initial)
  const calls = { get: 0 }
  const keyring: KeyringStore = {
    ...inner,
    get: (service, account) => {
      calls.get++
      return inner.get(service, account)
    },
  }
  return { keyring, calls, entries: inner.entries }
}

const environment = () => {
  const root = mkdtempSync(join(tmpdir(), "keyring-"))
  return {
    CHAT_PROFILE: "default",
    CHAT_STATE_DIR: join(root, "state"),
    CHAT_CONFIG_DIR: join(root, "config"),
    MESSAGING_STORE: join(root, "m.db"),
  }
}

const person = async () =>
  ({
    self: () => "500",
    contact: async () => ({ id: "40", name: "", username: null, description: null, lastMessagedAt: null, chats: [] }),
    photos: async () => ({ count: 0, oldestAt: null }),
    close: async () => {},
  }) as unknown as MessengerAdapter

const call = async (argv: string[], env: NodeJS.ProcessEnv, keyring: KeyringStore, stdin?: string) => {
  const messenger: Messenger = {
    app,
    provider: "telegram",
    resolveSettings: settingsFor(app).resolveSettings,
    connect: person,
    chatArgument: "a chat",
  }
  const streams = captureStreams()
  const code = await run(
    argv,
    { app, commands: () => [modelsCommand(messenger), contactsCommand(messenger)] },
    {
      streams,
      tty: false,
      env,
      keyring,
      ...(stdin === undefined ? {} : { stdin: Object.assign(Readable.from([stdin]), { isTTY: false }) }),
    },
  )
  return { code, stdout: streams.stdout, stderr: streams.stderr }
}

/** Credentials falls back to a file when the real keyring throws, and says so on the process's own stderr. */
const realKeyringNotices = () => {
  const written: string[] = []
  const original = process.stderr.write.bind(process.stderr)
  vi.spyOn(process.stderr, "write").mockImplementation((chunk, ...rest) => {
    if (String(chunk).includes("keyring")) {
      written.push(String(chunk))
      return true
    }
    return original(chunk, ...(rest as []))
  })
  return written
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe("a run's own keyring", () => {
  it("holds the key models keys set stores and remove forgets, and the real one is never reached", async () => {
    const notices = realKeyringNotices()
    const env = environment()
    const { keyring, entries } = counted()

    const set = await call(["models", "keys", "set", "openai", "--json"], env, keyring, "sk-test\n")
    expect(set.code).toBe(0)
    expect(JSON.parse(set.stdout[0] ?? "").item).toEqual({ provider: "openai", stored: "keyring" })
    expect([...entries.values()]).toEqual(["sk-test"])
    expect(existsSync(join(env.CHAT_CONFIG_DIR, "credentials.json"))).toBe(false)

    const removed = await call(["models", "keys", "remove", "openai", "--json"], env, keyring)
    expect(JSON.parse(removed.stdout[0] ?? "").item).toEqual({ provider: "openai", removed: ["keyring"] })
    expect(entries.size).toBe(0)
    expect(notices).toEqual([])
  })

  it("gives contacts check its CAS key", async () => {
    const notices = realKeyringNotices()
    const env = environment()
    rememberAccount(app, "default", "500", env)
    const service = keyringService(app.appName, env.CHAT_CONFIG_DIR, true)
    const { keyring } = counted({ [`${service}:registries:cas`]: "cas-key" })
    const authorizations: (string | null)[] = []
    vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
      if (new URL(String(input)).hostname === "api.cas.chat")
        authorizations.push(new Headers(init?.headers).get("authorization"))
      return new Response(JSON.stringify({ ok: false, description: "Record not found." }), { status: 200 })
    })

    const checked = await call(["contacts", "check", "40", "--json"], env, keyring)

    expect(checked.code).toBe(0)
    expect(authorizations).toEqual(["Bearer cas-key"])
    expect(notices).toEqual([])
  })

  it("is not read by contacts check --offline, which asks no ban list", async () => {
    const notices = realKeyringNotices()
    const env = environment()
    rememberAccount(app, "default", "500", env)
    const { keyring, calls } = counted()

    await call(["contacts", "check", "40", "--offline", "--json"], env, keyring)

    expect(calls.get).toBe(0)
    expect(notices).toEqual([])
  })

  it("gives the embedding and analysis models their key for a custom endpoint", () => {
    const env = environment()
    const service = keyringService(app.appName, env.CHAT_CONFIG_DIR, true)
    const { keyring } = counted({ [`${service}:embeddings:models.example`]: "endpoint-key" })
    const settings = settingsFor(app).resolveSettings({}, { env })

    const embedding = embeddingChoice({ baseUrl: "https://models.example/v1", dims: 8 }, app, settings, env, {
      keyring,
    })
    const analysis = analysisChoice(
      { analysisProvider: "openai", model: "m", baseUrl: "https://models.example/v1" },
      app,
      settings,
      env,
      keyring,
    )

    expect(embedding).toMatchObject({ apiKey: "endpoint-key" })
    expect(analysis).toMatchObject({ apiKey: "endpoint-key" })
  })
})
