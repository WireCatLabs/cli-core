import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { openPictureEmbedder } from "./embedder.js"
import { imageModel } from "./models.js"

const fake = vi.hoisted(() => ({
  encode: vi.fn(() => ({ ids: [1, 2, 3, 4, 9] })),
  create: vi.fn(),
  preprocess: vi.fn(async () => new Float32Array([0.25, 0.5])),
  env: { wasm: { numThreads: 0 } },
}))
vi.mock("@huggingface/tokenizers", () => ({
  Tokenizer: class {
    encode = fake.encode
  },
}))
vi.mock("@wirecat/cli-core-onnx", () => ({
  env: fake.env,
  InferenceSession: { create: fake.create },
  Tensor: class {
    constructor(
      public type: string,
      public data: Float32Array | BigInt64Array,
      public dims: number[],
    ) {}
  },
}))
vi.mock("./preprocess.js", () => ({ SIZE: 224, preprocess: fake.preprocess }))

const fixture = () => {
  const directory = mkdtempSync(join(tmpdir(), "picture-embedder-"))
  const model = { ...imageModel("clip-b32"), maxTokens: 3 }
  const root = join(directory, model.id)
  mkdirSync(join(root, "onnx"), { recursive: true })
  writeFileSync(join(root, "tokenizer.json"), "{}")
  writeFileSync(join(root, "tokenizer_config.json"), "{}")
  writeFileSync(join(root, model.text), "text")
  writeFileSync(join(root, model.vision), "vision")
  return { directory, model }
}

beforeEach(() => {
  vi.clearAllMocks()
  fake.env.wasm.numThreads = 0
})

describe("picture embedder runtime contract", () => {
  it("loads only the requested sessions once, preserves terminal tokens, normalizes vectors and releases sessions", async () => {
    const releaseText = vi.fn(async () => {})
    const releaseVision = vi.fn(async () => {})
    const textRun = vi.fn(async (_feeds: Record<string, unknown>) => ({
      text_embeds: { data: new Float32Array([3, 4]) },
    }))
    const visionRun = vi.fn(async (_feeds: Record<string, unknown>) => ({
      image_embeds: { data: new Float32Array([0, 2]) },
    }))
    fake.create.mockImplementation(async (bytes: Uint8Array) =>
      Buffer.from(bytes).toString() === "text"
        ? { inputNames: ["input_ids", "attention_mask"], run: textRun, release: releaseText }
        : { inputNames: ["pixel_values"], run: visionRun, release: releaseVision },
    )
    const { model, directory } = fixture()
    const embedder = await openPictureEmbedder(model, directory, { threads: 2 })
    expect(fake.create).not.toHaveBeenCalled()
    const vector = await embedder.embedQuery("HELLO")
    expect(fake.env.wasm.numThreads).toBe(2)
    expect(vector[0]).toBeCloseTo(0.6)
    expect(vector[1]).toBeCloseTo(0.8)
    expect(fake.encode).toHaveBeenCalledWith("hello")
    expect(textRun.mock.calls[0]?.[0]).toMatchObject({
      input_ids: { type: "int64", data: BigInt64Array.from([1n, 2n, 9n]), dims: [1, 3] },
      attention_mask: { data: BigInt64Array.from([1n, 1n, 1n]) },
    })
    await embedder.embedQuery("SECOND")
    expect(fake.create).toHaveBeenCalledTimes(1)
    const bytes = new Uint8Array([1, 2])
    expect(Array.from(await embedder.embedImage(bytes))).toEqual([0, 1])
    expect(fake.preprocess).toHaveBeenCalledWith(bytes, undefined)
    expect(visionRun.mock.calls[0]?.[0]).toMatchObject({ pixel_values: { type: "float32", dims: [1, 3, 224, 224] } })
    expect(fake.create).toHaveBeenCalledTimes(2)
    await embedder.close()
    expect(releaseText).toHaveBeenCalledOnce()
    expect(releaseVision).toHaveBeenCalledOnce()
  })

  it("omits unsupported attention masks and releases nothing when no inference was requested", async () => {
    const run = vi.fn(async (_feeds: Record<string, unknown>) => ({ text_embeds: { data: new Float32Array([1, 0]) } }))
    const release = vi.fn(async () => {})
    fake.create.mockResolvedValue({ inputNames: ["input_ids"], run, release })
    const { model, directory } = fixture()
    const unused = await openPictureEmbedder(model, directory)
    await unused.close()
    expect(fake.create).not.toHaveBeenCalled()
    const embedder = await openPictureEmbedder(model, directory)
    await embedder.embedQuery("query")
    expect(run.mock.calls[0]?.[0]).not.toHaveProperty("attention_mask")
    await embedder.close()
    expect(release).toHaveBeenCalledOnce()
  })
})
