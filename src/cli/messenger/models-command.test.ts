import { existsSync, mkdirSync, mkdtempSync, truncateSync, writeFileSync } from "node:fs"
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
    MESSAGING_STORE: join(root, "store.sqlite"),
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
  const go = async (args = argv) => {
    const streams = captureStreams()
    const code = await run(
      args,
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

describe("canonical model commands", () => {
  it("lists both model kinds and filters each catalogue", async () => {
    const { go, env } = await call(["models", "list", "--json"])
    const all = JSON.parse((await go()).stdout[0] ?? "null")
    expect(new Set(all.items.map((item: { id: string }) => item.id)).size).toBe(all.items.length)
    for (const kind of ["audio", "text"]) {
      const selected = JSON.parse((await go(["models", "list", `kind:${kind}`, "--json"])).stdout[0] ?? "null")
      expect(selected.items).toEqual(all.items.filter((item: { kind: string }) => item.kind === kind))
    }
    const missing = JSON.parse(
      (await go(["models", "list", "id:e5-small downloaded:false", "--json"])).stdout[0] ?? "null",
    )
    expect(missing.items).toHaveLength(1)
    expect(missing.items[0]).toMatchObject({ id: "e5-small", kind: "text", downloaded: false })
    expect(existsSync(env.MESSAGING_STORE)).toBe(false)
  })

  it("uses canonical key commands and keeps key material out of the receipt", async () => {
    const { go } = await call(["models", "keys", "set", "openai", "--json"], undefined, false, "synthetic-key\n")
    const result = await go()
    expect(result.code).toBe(0)
    expect(result.stdout.join("")).not.toContain("synthetic-key")
    expect(JSON.parse(result.stdout[0] ?? "null").item).toMatchObject({ provider: "openai", stored: "keyring" })
  })
})

describe("models audio", () => {
  it("**checks a downloaded model works** by loading it, and fetches nothing it already has", async () => {
    const { go, place, env } = await call(["models", "download", "gigaam-v3-ctc", "--json"])
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

  it("refuses an unknown model and points to the model catalogue", async () => {
    const { go } = await call(["models", "download", "whisper"])
    const { code, stderr } = await go()

    expect(code).not.toBe(0)
    expect(stderr.join("")).toContain("models list")
  })

  it("**lists the CLI's own order**, marking the downloaded ones and the default", async () => {
    const { go, place } = await call(["models", "list", "kind:audio"], ["gigaam-v3"], true)
    place("gigaam-v3")

    const lines = (await go()).stdout.join("").trim().split("\n")

    expect(lines.map((line) => line.replace(/^audio\s+/, "").match(/^(?:\* )?[^ ]+/)?.[0])).toEqual([
      "* gigaam-v3",
      "parakeet-v3",
      "gigaam-v3-ctc",
    ])
    expect(lines[0]).toContain("downloaded")
  })
})

describe("models text", () => {
  it("**lists the embedding models**, e5-small the default, marking the downloaded ones", async () => {
    const { go, env } = await call(["models", "list", "kind:text", "--json"])
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
    const { go } = await call(["models", "list", "kind:text", "--json"])
    const answer = v.parse(listEnvelopeSchema(modelEntity), JSON.parse((await go()).stdout[0] ?? ""))
    expect(answer.next).toMatchObject([{ step: "models.download", args: { model: "e5-small" } }])
    expect(answer.items[0]).toMatchObject({ kind: "text", size_bytes: expect.any(Number) })
    expect(answer.items[0]?.path).toMatch(/e5-small$/)
  })

  it("refuses a query field outside the model catalogue", async () => {
    const { go } = await call(["models", "list", "kind:text", "unknown:value", "--json"])

    const { code, stderr } = await go()

    expect(code).toBe(2)
    expect(stderr.join("")).toContain("query.unknown-field")
  })

  it("refuses a model with its own licence until its terms are accepted, downloading nothing", async () => {
    const { go } = await call(["models", "download", "embeddinggemma", "--json"])

    const { code, stderr } = await go()

    expect(code).not.toBe(0)
    expect(stderr.join("")).toContain("--accept-terms")
    expect(stderr.join("")).toContain("https://ai.google.dev/gemma/terms")
  })
})

describe("models keys", () => {
  it("**stores a piped key where only the user reads it**, never echoing it", async () => {
    const set = await call(["models", "keys", "set", "openai", "--json"], undefined, false, "sk-test\n")
    const { code, stdout, stderr } = await set.go()
    expect(code).toBe(0)
    expect(v.safeParse(ENTITIES["model_key.stored"], JSON.parse(stdout[0] ?? "").item).success).toBe(true)
    expect(JSON.parse(stdout[0] ?? "")).toMatchObject({ item: { provider: "openai" } })
    expect([...stdout, ...stderr].join("\n")).not.toContain("sk-test")
    expect(embeddingKeys(app, set.env, set.keyring).read("openai")?.key).toBe("sk-test")
  })
})

it("declares canonical key-removal fields and rejects a secret projection before input", async () => {
  const { go } = await call(["models", "keys", "remove", "openai", "--json"])
  const removed = await go()
  expect(removed.code).toBe(0)
  expect(v.parse(ENTITIES["model_key.removed"], JSON.parse(removed.stdout[0] ?? "null").item)).toEqual({
    provider: "openai",
    removed: [],
  })
  const projected = await go(["models", "keys", "remove", "openai", "--json=provider"])
  expect(JSON.parse(projected.stdout[0] ?? "null").item).toEqual({ provider: "openai" })
  const refused = await go(["models", "keys", "set", "openai", "--json=key"])
  expect(refused.code).toBe(2)
  expect(refused.stdout).toEqual([])
  expect(refused.stderr.join(" ")).toContain("output.unknown-field")
})
