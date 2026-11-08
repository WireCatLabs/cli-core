import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, truncateSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"
import { isTextModelInstalled, placedText, textModelsDirectory } from "../embeddings/embed.js"
import {
  type CustomTextModel,
  chosenTextModel,
  textModel,
  textModels,
  textModelsFile,
  vectorModelKey,
} from "../embeddings/models.js"
import { readSharedSection, writeSharedSection } from "../store/shared-config.js"
import { type MessageStore, openStore } from "../store/store.js"
import { embeddingTarget } from "./embeddings-maintenance.js"
import { meaningModel } from "./meaning-model.js"
import { embedNotes, nearestNotes } from "./notes-search.js"
import { addCustomTextModel, useTextModel } from "./text-model-choice.js"

const fixture = fileURLToPath(new URL("../embeddings/fixtures/tiny", import.meta.url))
const pinned = (name: string) => {
  const bytes = readFileSync(join(fixture, name))
  return {
    name,
    url: `https://example.test/${name}`,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.length,
  }
}
const tiny = (id: string): CustomTextModel => ({
  id,
  title: "a five-word model",
  languages: "test",
  licence: "none",
  dims: 4,
  maxTokens: 64,
  pooling: "mean",
  prefix: { query: "", passage: "" },
  onnx: "onnx/model.onnx",
  files: ["onnx/model.onnx", "tokenizer.json", "tokenizer_config.json"].map(pinned),
})

const live: MessageStore[] = []
afterEach(async () => {
  for (const store of live.splice(0)) await store.close()
})

/** A store and the shared settings file beside it, with two downloaded custom models of the same files. */
const machine = async (custom: CustomTextModel[] = [tiny("tiny-a"), tiny("tiny-b")]) => {
  const root = mkdtempSync(join(tmpdir(), "text-models-"))
  const env = { ...process.env, WIRECAT_STATE_DIR: root, MESSAGING_STORE: join(root, "store.db") }
  mkdirSync(join(root, "models", "text"), { recursive: true })
  for (const { id } of custom) symlinkSync(fixture, join(root, "models", "text", id))
  writeSharedSection(textModelsFile(env), "text_models", { custom })
  const store = await openStore({ env })
  live.push(store)
  return { env, store }
}

describe("the chosen text model", () => {
  it("is EmbeddingGemma until the owner chooses, then every embed and search by meaning uses the choice", async () => {
    const { env, store } = await machine()
    expect(chosenTextModel(env)).toEqual({ id: "embeddinggemma", from: "default" })
    await store.notes.addNote({ text: "fish fish fish" })

    await useTextModel("tiny-a", { env, command: "memo" })

    expect(chosenTextModel(env)).toEqual({ id: "tiny-a", from: "chosen" })
    expect(embeddingTarget({ env, messenger: { app: { command: "tg" } } }).id).toBe("tiny-a")
    expect(await embedNotes(store, { env, threads: 1 })).toMatchObject({ model: "tiny-a", embedded: 1 })
    const [best] = await nearestNotes(store, "fish", { env, limit: 1, threads: 1 })
    expect(best?.note.text).toBe("fish fish fish")
  })

  it("keeps each model's vectors apart: after a switch search reads none of the old model's until it embeds", async () => {
    const { env, store } = await machine()
    await store.notes.addNote({ text: "fish fish fish" })
    await store.notes.addNote({ text: "cat dog" })
    await useTextModel("tiny-a", { env, command: "memo" })
    await embedNotes(store, { env, threads: 1 })

    const switched = await useTextModel("tiny-b", { env, command: "memo" })

    expect(switched).toMatchObject({ previous: "tiny-a", toEmbed: 2, estimateSeconds: null })
    await expect(nearestNotes(store, "fish", { env, limit: 1, threads: 1 })).rejects.toThrow(
      "nothing searched here has vectors of tiny-b yet",
    )
    expect(await embedNotes(store, { env, threads: 1 })).toMatchObject({ model: "tiny-b", embedded: 2 })
    const keys = [vectorModelKey(textModel("tiny-a", env)), vectorModelKey(textModel("tiny-b", env))]
    expect([...(await store.vectors.vectorCounts(keys)).values()]).toEqual([2, 2])
    expect(await useTextModel("tiny-a", { env, command: "memo" })).toMatchObject({ previous: "tiny-b", toEmbed: 0 })
  })

  it("refuses a model that is not downloaded, naming it and the command that downloads it", async () => {
    const { env, store } = await machine()

    await expect(useTextModel("e5-large", { env, command: "memo" })).rejects.toMatchObject({
      message: "e5-large is not downloaded — `memo models download e5-large` first",
      details: { reason: "model.not-downloaded", model: "e5-large" },
    })
    await expect(nearestNotes(store, "x", { env, model: "embeddinggemma", limit: 1 })).rejects.toThrow(
      "embeddinggemma is not downloaded",
    )
    expect(chosenTextModel(env).id).toBe("embeddinggemma")
  })

  it("gives a custom model a key with its weights' hash, so a redefined id never reads the old vectors", async () => {
    const { env } = await machine()
    const key = vectorModelKey(textModel("tiny-a", env))
    expect(key).toMatch(/^local:tiny-a@[0-9a-f]{12}:4$/)
    expect(vectorModelKey(textModel("e5-small"))).toBe("local:e5-small:384")
  })
})

describe("a custom model in the shared file", () => {
  it.each([
    ["a built-in id", { ...tiny("e5-small") }, "takes the id of a model this version ships"],
    [
      "a file outside its folder",
      { ...tiny("x"), files: [...tiny("x").files, { ...pinned("tokenizer.json"), name: "../tokenizer.json" }] },
      "is not a file inside the model's folder",
    ],
    ["no tokenizer", { ...tiny("x"), files: [pinned("onnx/model.onnx")] }, "tokenizer.json"],
    ["an unknown pooling", { ...tiny("x"), pooling: "last_token" }, "text_models.custom.0.pooling"],
    ["a hash that is not one", { ...tiny("x"), files: [{ ...pinned("onnx/model.onnx"), sha256: "abc" }] }, "sha256"],
  ])("is refused with %s, naming the file and the field", async (_, model, message) => {
    const { env } = await machine([])
    writeSharedSection(textModelsFile(env), "text_models", { custom: [model] })
    expect(() => textModels(env)).toThrow(message)
    expect(() => textModels(env)).toThrow(textModelsFile(env))
  })

  it("is added from Hugging Face pinned to the commit, with LFS hashes from the listing and small files hashed", async () => {
    const { env } = await machine([])
    const commit = "a".repeat(40)
    const lfs = "b".repeat(64)
    const asked: string[] = []
    const fetch = async (url: string) => {
      asked.push(url)
      if (url.endsWith("/revision/main")) return Response.json({ sha: commit, cardData: { license: "mit" } })
      if (url.endsWith(`/tree/${commit}/onnx`))
        return Response.json([{ path: "onnx/model.onnx", size: 900, lfs: { oid: lfs, size: 900 } }])
      if (url.endsWith(`/tree/${commit}`))
        return Response.json([
          { path: "tokenizer.json", size: 5 },
          { path: "tokenizer_config.json", size: 2 },
        ])
      if (url.endsWith("/tokenizer.json")) return new Response("hello")
      if (url.endsWith("/tokenizer_config.json")) return new Response("{}")
      return new Response("", { status: 404 })
    }

    const model = await addCustomTextModel(
      "mine",
      {
        repository: "someone/model-onnx",
        onnx: "onnx/model.onnx",
        dims: 768,
        pooling: "mean",
        prefix: { query: "query: ", passage: "passage: " },
      },
      { env, fetch },
    )

    expect(model).toMatchObject({ id: "mine", custom: true, licence: "mit", dims: 768 })
    expect(model.files).toEqual([
      {
        name: "onnx/model.onnx",
        url: `https://huggingface.co/someone/model-onnx/resolve/${commit}/onnx/model.onnx`,
        sha256: lfs,
        bytes: 900,
      },
      expect.objectContaining({ name: "tokenizer.json", sha256: createHash("sha256").update("hello").digest("hex") }),
      expect.objectContaining({ name: "tokenizer_config.json", bytes: 2 }),
    ])
    expect(textModel("mine", env).files).toEqual(model.files)
    expect(readSharedSection(textModelsFile(env), "text_models")).toMatchObject({ custom: [{ id: "mine" }] })
    expect(asked.some((url) => url.includes("/resolve/main/"))).toBe(false)
  })
})

/** A model's files at their pinned sizes, which is what the installed check reads. */
const place = (id: string, env: NodeJS.ProcessEnv) => {
  for (const [file, path] of placedText(textModel(id), textModelsDirectory(env))) {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, "")
    truncateSync(path, file.bytes)
  }
}

describe("EmbeddingGemma as the default", () => {
  it("keeps e5-small, the default before, on a machine that has only it, and moves once Gemma is downloaded", async () => {
    const { env } = await machine([])
    place("e5-small", env)
    expect(chosenTextModel(env)).toEqual({ id: "e5-small", from: "default" })
    place("embeddinggemma", env)
    expect(isTextModelInstalled(textModel("embeddinggemma"), textModelsDirectory(env))).toBe(true)
    expect(chosenTextModel(env)).toEqual({ id: "embeddinggemma", from: "default" })
  })

  it("**searches with e5-small's vectors while Gemma's are fewer**, then with Gemma's; a chosen model always", async () => {
    const { env, store } = await machine([])
    place("e5-small", env)
    place("embeddinggemma", env)
    const save = (id: string, hashes: string[]) => {
      const { dims } = textModel(id)
      return store.vectors.saveVectors(
        vectorModelKey(textModel(id)),
        dims,
        hashes.map((hash) => ({ hash, vector: new Float32Array(dims) })),
      )
    }
    await save("e5-small", ["a", "b", "c"])
    await save("embeddinggemma", ["a"])
    expect(await meaningModel(store, env)).toBe("e5-small")

    await save("embeddinggemma", ["b", "c"])
    expect(await meaningModel(store, env)).toBe("embeddinggemma")

    await save("embeddinggemma", [])
    writeSharedSection(textModelsFile(env), "text_models", { use: "e5-small" })
    expect(await meaningModel(store, env)).toBe("e5-small")
  })
})
