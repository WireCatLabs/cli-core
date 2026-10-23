import { mkdirSync, mkdtempSync, truncateSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { Readable } from "node:stream"
import { captureStreams } from "@wirecat/cli-base"
import { itemEnvelopeSchema, listEnvelopeSchema } from "@wirecat/cli-base/standards"
import { memoryKeyring } from "@wirecat/cli-base/testing"
import * as v from "valibot"
import { describe, expect, it, vi } from "vitest"
import { placedText, textModelsDirectory } from "../../embeddings/embed.js"
import { embeddingKeys } from "../../embeddings/keys.js"
import { textModel } from "../../embeddings/models.js"
import { ENTITIES } from "../../entities/index.js"
import { model as modelEntity } from "../../entities/model.js"
import { modelPath, modelsDirectory, vadPath } from "../../speech/install.js"
import { speechModel, VAD } from "../../speech/models.js"
import { run } from "../program.js"
import { settingsFor } from "../settings.js"
import type { Messenger } from "./context.js"
import { modelsCommand } from "./models-command.js"

let recognized = 0
vi.mock("../../speech/recognize.js", async (original) => ({
  ...(await original<typeof import("../../speech/recognize.js")>()),
  openRecognizer: () => ({
    recognize: () => {
      recognized++
      return ""
    },
    free: () => {},
  }),
}))

/** A sparse file at the pinned size — what `isInstalled` checks — without writing hundreds of MB. */
const sized = (path: string, bytes: number) => {
  writeFileSync(path, "")
  truncateSync(path, bytes)
}

const app = {
  command: "chat",
  appName: "chat-cli",
  envPrefix: "CHAT",
  description: "A test messenger",
  version: "1.0.0",
}

const call = async (argv: string[], speechModels?: string[], tty = false, stdin?: string) => {
  const root = mkdtempSync(join(tmpdir(), "models-"))
  const env = {
    CHAT_PROFILE: "default",
    CHAT_STATE_DIR: join(root, "state"),
    CHAT_CONFIG_DIR: join(root, "config"),
    WIRECAT_STATE_DIR: join(root, "cache"),
  }
  const keyring = memoryKeyring()
  const messenger: Messenger = {
    app,
    provider: "chat",
    resolveSettings: settingsFor(app).resolveSettings,
    connect: async () => {
      throw new Error("models never connect")
    },
    chatArgument: "a chat",
    ...(speechModels ? { speechModels } : {}),
  }
  const place = (id: string) => {
    const model = speechModel(id)
    const directory = modelsDirectory(env)
    mkdirSync(join(directory, model.id), { recursive: true })
    sized(vadPath(directory), VAD.bytes)
    for (const file of model.files) sized(modelPath(directory, model)(file.name), file.bytes)
  }
  const go = async () => {
    const streams = captureStreams()
    const code = await run(
      argv,
      { app, commands: () => [modelsCommand(messenger)] },
      {
        streams,
        tty,
        env,
        keyring,
        ...(stdin === undefined ? {} : { stdin: Object.assign(Readable.from([stdin]), { isTTY: false }) }),
      },
    )
    return { code, stdout: streams.stdout, stderr: streams.stderr }
  }
  return { go, place, env, keyring }
}

describe("models audio", () => {
  it("**checks a downloaded model works** by loading it, and fetches nothing it already has", async () => {
    const { go, place, env } = await call(["models", "audio", "download", "gigaam-v3-ctc", "--json"])
    place("gigaam-v3-ctc")

    const { code, stdout } = await go()

    expect(code).toBe(0)
    const { item } = v.parse(itemEnvelopeSchema(modelEntity), JSON.parse(stdout[0] ?? ""))
    expect(item).toMatchObject({
      id: "gigaam-v3-ctc",
      kind: "audio",
      downloaded: true,
      path: join(modelsDirectory(env), "gigaam-v3-ctc"),
    })
    expect(recognized).toBe(1)
  })

  it("refuses a model it does not know, naming the ones it does", async () => {
    const { go } = await call(["models", "audio", "download", "whisper"])
    const { code, stderr } = await go()

    expect(code).not.toBe(0)
    expect(stderr.join("")).toContain("parakeet-v3")
  })

  it("**lists the CLI's own order**, marking the downloaded ones and the default", async () => {
    const { go, place } = await call(["models", "audio", "list"], ["gigaam-v3"], true)
    place("gigaam-v3")

    const lines = (await go()).stdout.join("").trim().split("\n")

    expect(lines.map((line) => line.slice(0, 16).trim())).toEqual(["* gigaam-v3", "parakeet-v3", "gigaam-v3-ctc"])
    expect(lines[0]).toContain("downloaded")
  })
})

describe("models text", () => {
  it("**lists the embedding models**, e5-small the default, marking the downloaded ones", async () => {
    const { go, env } = await call(["models", "text", "list", "--json"])
    const model = textModel("e5-small")
    for (const [file, path] of placedText(model, textModelsDirectory(env))) {
      mkdirSync(dirname(path), { recursive: true })
      sized(path, file.bytes)
    }

    const { code, stdout } = await go()

    expect(code).toBe(0)
    const { items, next } = v.parse(listEnvelopeSchema(modelEntity), JSON.parse(stdout[0] ?? ""))
    expect(next).toBeUndefined()
    expect(
      items.map(({ id, downloaded, default: chosen }: Record<string, unknown>) => [id, downloaded, chosen]),
    ).toEqual([
      ["e5-small", true, true],
      ["embeddinggemma", false, false],
    ])
  })

  it("names the download step while the default embedding model is missing", async () => {
    const { go } = await call(["models", "text", "list", "--json"])
    const answer = v.parse(listEnvelopeSchema(modelEntity), JSON.parse((await go()).stdout[0] ?? ""))
    expect(answer.next).toMatchObject([{ step: "models.download", args: { model: "e5-small" } }])
    expect(answer.items[0]).toMatchObject({ kind: "text", size_bytes: expect.any(Number) })
    expect(answer.items[0]?.path).toMatch(/e5-small$/)
  })

  it("refuses a query term: the catalog has nothing to filter", async () => {
    const { go } = await call(["models", "text", "list", "kind:text", "--json"])

    const { code, stderr } = await go()

    expect(code).toBe(2)
    expect(stderr.join("")).toContain("query.unsupported-field")
  })

  it("refuses a model with its own licence until its terms are accepted, downloading nothing", async () => {
    const { go } = await call(["models", "text", "download", "embeddinggemma", "--json"])

    const { code, stderr } = await go()

    expect(code).not.toBe(0)
    expect(stderr.join("")).toContain("--accept-terms")
    expect(stderr.join("")).toContain("https://ai.google.dev/gemma/terms")
  })
})

describe("models text key", () => {
  it("**stores a piped key where only the user reads it**, never echoing it", async () => {
    const set = await call(["models", "text", "key", "set", "openai", "--json"], undefined, false, "sk-test\n")
    const { code, stdout, stderr } = await set.go()
    expect(code).toBe(0)
    expect(v.safeParse(ENTITIES["model_key.stored"], JSON.parse(stdout[0] ?? "").item).success).toBe(true)
    expect(JSON.parse(stdout[0] ?? "")).toMatchObject({ item: { provider: "openai" } })
    expect([...stdout, ...stderr].join("\n")).not.toContain("sk-test")
    expect(embeddingKeys(app, set.env, set.keyring).read("openai")?.key).toBe("sk-test")
  })
})

it("declares an empty key-removal answer without connecting or exposing a secret", async () => {
  const removed = await call(["models", "text", "key", "remove", "openai", "--json"])
  const result = await removed.go()
  expect(result.code).toBe(0)
  expect(v.parse(ENTITIES["model_key.removed"], JSON.parse(result.stdout[0] ?? "").item)).toEqual({
    provider: "openai",
    removed: [],
  })
  const projected = await call(["models", "text", "key", "remove", "openai", "--json=provider"])
  expect(JSON.parse((await projected.go()).stdout[0] ?? "").item).toEqual({ provider: "openai" })
})
