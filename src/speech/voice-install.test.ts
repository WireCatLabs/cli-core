import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, truncateSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { captureStreams } from "@wirecat/cli-base"
import { memoryKeyring } from "@wirecat/cli-base/testing"
import { describe, expect, it, vi } from "vitest"
import { messagesCommand } from "../cli/messenger/messages-command.js"
import { modelsCommand } from "../cli/messenger/models-command.js"
import { type RunOptions, run } from "../cli/program.js"
import { settingsFor } from "../cli/settings.js"
import type { Message } from "../domain/models.js"
import { engineFolder, enginesDirectory, ensureEngine, isEngineInstalled } from "../engines/install.js"
import type { MessengerAdapter, RemoteFile } from "../ports/messenger.js"
import { fakeRegistry } from "../testing/engine-fixtures.js"
import { decodeAudio } from "./decode.js"
import { modelPath, modelsDirectory, vadPath } from "./install.js"
import { speechModel, VAD } from "./models.js"

// The engines this cli-core pins, as a registry on no network serves them: what voice does on a first run. Loaded
// before the imports below, which reach the pins themselves.
const { VOICE_FIXTURE, voiceEngines } = await vi.hoisted(() => import("../testing/voice-engine-fixtures.js"))
vi.mock("../engines/pins.js", () => ({ ENGINE_PINS: VOICE_FIXTURE.pins }))

const app = { command: "chat", appName: "chat-cli", envPrefix: "CHAT", description: "synthetic", version: "1.0.0" }
const tone = new Uint8Array(readFileSync(new URL("../testing/fixtures/tone.ogg", import.meta.url)))
// The smallest model: its files are sparse here, but not on every file system a runner has.
const MODEL = "gigaam-v3-ctc"
const RETRY = `chat default models download ${MODEL}`

/** An empty WireCat data folder with only the speech model's files: what a first transcription finds. */
const firstRun = () => {
  const root = mkdtempSync(join(tmpdir(), "voice-install-"))
  const env = {
    HOME: root,
    CHAT_PROFILE: "default",
    CHAT_STATE_DIR: join(root, "state"),
    CHAT_CONFIG_DIR: join(root, "config"),
    MESSAGING_STORE: join(root, "m.db"),
    WIRECAT_STATE_DIR: join(root, "wirecat"),
  }
  const directory = modelsDirectory(env)
  const model = speechModel(MODEL)
  mkdirSync(join(directory, model.id), { recursive: true })
  for (const [path, bytes] of [
    [vadPath(directory), VAD.bytes] as const,
    ...model.files.map((file) => [modelPath(directory, model)(file.name), file.bytes] as const),
  ]) {
    writeFileSync(path, "")
    truncateSync(path, bytes)
  }
  return env
}

const voiceNote: Message = {
  id: "5",
  chatId: "7",
  senderId: "9",
  senderName: "Olga",
  timestamp: "2026-09-27T10:00:00.000Z",
  editedAt: null,
  text: "",
  outgoing: false,
  attachments: [{ kind: "voice", mime: "audio/ogg" }],
  replyTo: null,
  forwardedFrom: null,
  reactions: null,
}

const adapter = (): MessengerAdapter => {
  const voice: RemoteFile = {
    kind: "voice",
    mime: "audio/ogg",
    position: 0,
    async *bytes() {
      yield tone
    },
  }
  return {
    self: () => "500",
    me: async () => ({ id: "500", name: "Owner", username: null }),
    chats: async () => ({ items: [], hasMore: false }),
    history: async () => ({ items: [voiceNote], hasMore: false }),
    resolve: async () => ({ id: "7", title: "Book club", kind: "group", unreadCount: 0, lastMessageAt: null }),
    download: async () => ({ files: [voice], skipped: [] }),
    send: async () => {
      throw new Error("voice never sends")
    },
    logout: async () => {},
    close: async () => {},
  } as unknown as MessengerAdapter
}

const chat = async (argv: string[], env: NodeJS.ProcessEnv, options: Partial<RunOptions> & object = {}) => {
  const messenger = {
    app,
    provider: "chat",
    resolveSettings: settingsFor(app).resolveSettings,
    connect: async () => adapter(),
    chatArgument: "a chat",
  }
  const streams = captureStreams()
  const code = await run(
    argv,
    { app, commands: () => [messagesCommand(messenger), modelsCommand(messenger)] },
    { streams, tty: false, env, keyring: memoryKeyring(), ...options },
  )
  return { code, out: streams.stdout.join(""), err: streams.stderr.join("") }
}

const installed = (env: NodeJS.ProcessEnv) =>
  Object.values(VOICE_FIXTURE.pins).every((pin) => isEngineInstalled(pin, env))

describe("voice on the engine installer", () => {
  it("**the first transcription installs both engines with no question, then transcribes; progress on stderr only**", async () => {
    const env = firstRun()
    const { fetch, requests } = fakeRegistry(VOICE_FIXTURE.bodies)

    const { code, out, err } = await chat(["messages", "transcribe", "Book", "5", "--model", MODEL], env, {
      tty: true,
      fetch,
    })

    expect(code).toBe(0)
    expect(out).toBe("heard by the installed engine\n")
    expect(err).toContain("installing ogg-opus-decoder 9.0.0")
    expect(err).toContain("installing sherpa-onnx 9.0.0")
    expect(installed(env)).toBe(true)
    expect([...requests.values()]).toEqual([1, 1])
  })

  it("**under --json, stdout is one JSON value and stderr stays empty** while the engines install", async () => {
    const env = firstRun()

    const { code, out, err } = await chat(["messages", "transcribe", "Book", "5", "--model", MODEL, "--json"], env, {
      fetch: fakeRegistry(VOICE_FIXTURE.bodies).fetch,
    })

    expect(code).toBe(0)
    expect(err).toBe("")
    expect(JSON.parse(out).item).toMatchObject({ text: "heard by the installed engine", via: "local" })
    expect(installed(env)).toBe(true)
  })

  it("**an MCP call gets the transcript and nothing extra**", async () => {
    let result: unknown
    const { code, out, err } = await chat(["messages", "transcribe", "Book", "5", "--model", MODEL], firstRun(), {
      fetch: fakeRegistry(VOICE_FIXTURE.bodies).fetch,
      agent: {
        result: (value: unknown) => {
          result = value
        },
        failure: () => {},
      },
    } as Partial<RunOptions>)

    expect(code).toBe(0)
    expect(out).toBe("")
    expect(err).toBe("")
    expect(result).toMatchObject({ item: { text: "heard by the installed engine" } })
  })

  it("**offline: engine.missing with the exact command to retry**, and a list still shows its messages", async () => {
    const offline = async (): Promise<Response> => {
      throw new TypeError("fetch failed")
    }
    const env = firstRun()

    const one = await chat(["messages", "transcribe", "Book", "5", "--model", MODEL, "--json"], env, { fetch: offline })
    const listed = await chat(["messages", "list", "Book", "--transcribe", "--model", MODEL, "--json"], env, {
      fetch: offline,
    })

    expect(one.code).not.toBe(0)
    expect(JSON.parse(one.err).error).toMatchObject({
      code: "configuration_error",
      reason: "engine.missing",
      message: expect.stringContaining(`Retry with: ${RETRY}`),
    })
    expect(JSON.parse(one.err).error.details).toMatchObject({ retry: RETRY })
    expect(listed.code).toBe(0)
    const answer = JSON.parse(listed.out)
    expect(answer.items.map((item: { id: string }) => item.id)).toEqual(["5"])
    expect(JSON.stringify(answer.missing)).toContain(`Retry with: ${RETRY}`)
  })

  it("**models download, the retry command, installs the engines** beside the model it checks", async () => {
    const env = firstRun()

    const { code, err } = await chat(["models", "download", MODEL, "--json"], env, {
      fetch: fakeRegistry(VOICE_FIXTURE.bodies).fetch,
    })

    expect(code).toBe(0)
    expect(err).not.toContain("installing")
    expect(installed(env)).toBe(true)
  })

  it("**two transcriptions at once: one installs, the other waits and uses it**", async () => {
    const env = firstRun()
    const { fetch, requests } = fakeRegistry(VOICE_FIXTURE.bodies)
    const runs = [0, 1].map(() =>
      chat(["messages", "transcribe", "Book", "5", "--model", MODEL, "--json"], env, { fetch }),
    )

    const answers = await Promise.all(runs)

    expect(answers.map(({ code }) => code)).toEqual([0, 0])
    expect(answers.map(({ out }) => JSON.parse(out).item.text)).toEqual([
      "heard by the installed engine",
      "heard by the installed engine",
    ])
    expect([...requests.values()]).toEqual([1, 1])
  })

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "**a data folder it cannot write: engine.missing naming the folder**, and nothing half-written",
    async () => {
      const env = firstRun()
      mkdirSync(env.WIRECAT_STATE_DIR, { recursive: true })
      const engines = enginesDirectory(env)
      mkdirSync(engines)
      chmodSync(engines, 0o500)
      try {
        const { code, err } = await chat(["messages", "transcribe", "Book", "5", "--model", MODEL, "--json"], env, {
          fetch: fakeRegistry(VOICE_FIXTURE.bodies).fetch,
        })

        expect(code).not.toBe(0)
        const { error } = JSON.parse(err)
        expect(error.reason).toBe("engine.missing")
        expect(error.message).toContain(`cannot write to ${engines}`)
        expect(existsSync(engineFolder(VOICE_FIXTURE.pins["sherpa-onnx"], env))).toBe(false)
      } finally {
        chmodSync(engines, 0o700)
      }
    },
  )

  it("**an engine an older cli-core installed is not loaded**: the pinned one is installed beside it", async () => {
    const env = firstRun()
    const older = voiceEngines("8.0.0", "heard by the older engine")
    for (const pin of Object.values(older.pins))
      expect(await ensureEngine(pin, { retry: RETRY, env, fetch: fakeRegistry(older.bodies).fetch })).toMatchObject({
        status: "ready",
      })

    const { out } = await chat(["messages", "transcribe", "Book", "5", "--model", MODEL, "--json"], env, {
      fetch: fakeRegistry(VOICE_FIXTURE.bodies).fetch,
    })

    expect(JSON.parse(out).item.text).toBe("heard by the installed engine")
    expect(Object.values(older.pins).every((pin) => isEngineInstalled(pin, env))).toBe(true)
    expect(installed(env)).toBe(true)
  })

  it("**a library caller gets the engine too**: decodeAudio installs the Opus decoder on first use", async () => {
    const env = firstRun()
    const refusing = async () => {
      throw new Error("ffmpeg was asked")
    }

    const pcm = await decodeAudio(tone, refusing, { env, fetch: fakeRegistry(VOICE_FIXTURE.bodies).fetch })

    expect(pcm.rate).toBe(48_000)
    expect(isEngineInstalled(VOICE_FIXTURE.pins["ogg-opus-decoder"], env)).toBe(true)
    expect(isEngineInstalled(VOICE_FIXTURE.pins["sherpa-onnx"], env)).toBe(false)
  })
})
