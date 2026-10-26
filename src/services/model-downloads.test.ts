import { mkdirSync, mkdtempSync, truncateSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { placedText, textModelsDirectory } from "../embeddings/embed.js"
import { textModel } from "../embeddings/models.js"
import { imageModel, imageModelsDirectory, placedImage } from "../images/picture/models.js"
import { downloadImageModel, downloadTextModel } from "./model-downloads.js"

let dims = { text: 0, image: 0 }
const fetched: string[] = []

vi.mock("../embeddings/embed.js", async (original) => ({
  ...(await original<typeof import("../embeddings/embed.js")>()),
  openEmbedder: async () => ({
    embed: async () => [new Float32Array(dims.text)],
    close: async () => {},
  }),
}))
vi.mock("../images/picture/embedder.js", () => ({
  openPictureEmbedder: async () => ({
    embedQuery: async () => new Float32Array(dims.image),
    close: async () => {},
  }),
}))
vi.mock("../speech/install.js", async (original) => ({
  ...(await original<typeof import("../speech/install.js")>()),
  installFiles: async (files: [{ name: string; bytes: number }, string][]) => {
    for (const [file, path] of files) {
      fetched.push(file.name)
      sized(path, file.bytes)
    }
  },
}))

const runtime = vi.hoisted(() => ({ fails: false, calls: 0 }))
vi.mock("../embeddings/onnx-runtime.js", () => ({
  installNativeRuntime: async () => {
    runtime.calls++
    if (runtime.fails) throw new Error("HTTP 503")
    return undefined
  },
}))

/** A sparse file at the pinned size — what the installed check reads — without writing hundreds of MB. */
const sized = (path: string, bytes: number) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, "")
  truncateSync(path, bytes)
}

const freshEnv = () => ({ WIRECAT_STATE_DIR: mkdtempSync(join(tmpdir(), "model-downloads-")) })

beforeEach(() => {
  fetched.length = 0
  runtime.fails = false
  runtime.calls = 0
  dims = { text: textModel("e5-small").dims, image: imageModel("clip-b32").dims }
})

describe("downloadTextModel", () => {
  it("downloads a missing model into the shared folder, then fetches nothing it already has", async () => {
    const env = freshEnv()
    const progress = vi.fn()
    const { model, directory } = await downloadTextModel("e5-small", { env, progress })

    expect([model.id, directory]).toEqual(["e5-small", textModelsDirectory(env)])
    expect(fetched).toEqual(model.files.map((file) => file.name))
    expect(progress).toHaveBeenCalledWith(expect.stringContaining("from Hugging Face"))

    fetched.length = 0
    await downloadTextModel("e5-small", { env })
    expect(fetched).toEqual([])
  })

  it("also fetches the native ONNX Runtime, and still installs the model when that fails", async () => {
    runtime.fails = true
    const progress = vi.fn()

    const { model } = await downloadTextModel("e5-small", { env: freshEnv(), progress })

    expect(model.id).toBe("e5-small")
    expect(runtime.calls).toBe(1)
    expect(progress).toHaveBeenCalledWith("ONNX Runtime not installed (HTTP 503); models run through WebAssembly")
  })

  it("refuses a model with its own terms until they are accepted, before fetching anything", async () => {
    await expect(downloadTextModel("embeddinggemma", { env: freshEnv() })).rejects.toThrow("--accept-terms")
    expect(fetched).toEqual([])
  })

  it("fails a model that loads but gives vectors of the wrong size", async () => {
    const env = freshEnv()
    for (const [file, path] of placedText(textModel("e5-small"), textModelsDirectory(env))) sized(path, file.bytes)
    dims.text = 3
    await expect(downloadTextModel("e5-small", { env })).rejects.toThrow("wrong size")
  })
})

describe("downloadImageModel", () => {
  it("downloads a missing picture model, and checks the one already there", async () => {
    const env = freshEnv()
    const { model, directory } = await downloadImageModel("clip-b32", { env })

    expect([model.id, directory]).toEqual(["clip-b32", imageModelsDirectory(env)])
    expect(fetched).toEqual(model.files.map((file) => file.name))

    dims.image = 3
    await expect(downloadImageModel("clip-b32", { env })).rejects.toThrow("wrong size")
  })

  it("leaves a placed model as it is", async () => {
    const env = freshEnv()
    for (const [file, path] of placedImage(imageModel("clip-b32"), imageModelsDirectory(env))) sized(path, file.bytes)
    await downloadImageModel("clip-b32", { env })
    expect(fetched).toEqual([])
  })
})
