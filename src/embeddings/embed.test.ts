import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it, vi } from "vitest"
import { type Embedder, meanOf, openEmbedder, truncated, unit, warmEmbedders } from "./embed.js"
import type { TextModel } from "./models.js"

describe("embedding arithmetic", () => {
  it("**cuts a long text** to the model's limit, keeping the closing special token", () => {
    expect(truncated([101, 1, 2, 3, 4, 102], 4)).toEqual([101, 1, 2, 102])
    expect(truncated([101, 1, 102], 4)).toEqual([101, 1, 102])
  })

  it("averages the tokens' vectors", () => {
    expect(Array.from(meanOf(Float32Array.from([1, 2, 3, 4]), 2, 2))).toEqual([2, 3])
  })

  it("scales a vector to length one, so a dot product is the cosine", () => {
    expect(Array.from(unit(Float32Array.from([3, 4])))).toEqual([0.6000000238418579, 0.800000011920929])
    expect(Array.from(unit(new Float32Array(2)))).toEqual([0, 0])
  })
})

const tiny: TextModel = {
  id: "tiny",
  title: "a five-word model",
  languages: "test",
  licence: "none",
  dims: 4,
  maxTokens: 3,
  chunksPerSecond: 1,
  pooling: "mean",
  prefix: { query: "fish ", passage: "" },
  onnx: "onnx/model.onnx",
  files: [],
}

const rounded = (vector: Float32Array | undefined) => Array.from(vector ?? []).map((value) => value.toFixed(4))

describe("openEmbedder", () => {
  it("**runs a model through the WebAssembly runtime**: tokens, their mean, length one, the prefix, the limit", async () => {
    const embedder = await openEmbedder(tiny, fileURLToPath(new URL("./fixtures", import.meta.url)), { threads: 1 })
    try {
      const [cat, catDog, cut] = await embedder.embed(["cat", "cat dog", "cat dog fish dog"], "passage")
      expect(rounded(cat)).toEqual(["1.0000", "0.0000", "0.0000", "0.0000"])
      expect(rounded(catDog)).toEqual(["0.7071", "0.7071", "0.0000", "0.0000"])
      expect(rounded(cut)).toEqual(["0.4472", "0.8944", "0.0000", "0.0000"])
      expect(rounded((await embedder.embed(["cat"], "query"))[0])).toEqual(["0.7071", "0.0000", "0.7071", "0.0000"])
    } finally {
      await embedder.close()
    }
  })
})

describe("warmEmbedders", () => {
  afterEach(() => vi.useRealTimers())

  const standIn = () => {
    const counts = { opened: 0, closed: 0 }
    let finish = () => {}
    const open = async (): Promise<Embedder> => {
      counts.opened += 1
      return {
        model: {} as TextModel,
        embed: (texts) =>
          new Promise((resolve) => {
            finish = () => resolve(texts.map(() => new Float32Array(1)))
          }),
        close: async () => {
          counts.closed += 1
        },
      }
    }
    return { counts, open, finish: () => finish() }
  }

  it("**closes a model no search used for the idle time**, waits for one still running, and opens it again", async () => {
    vi.useFakeTimers()
    const { counts, open, finish } = standIn()
    const warm = warmEmbedders({ idleMs: 1_000 })

    const running = (await warm.get("m", open)).embed(["a"], "query")
    await vi.advanceTimersByTimeAsync(1_500)
    expect(counts.closed).toBe(0)
    finish()
    await running

    await vi.advanceTimersByTimeAsync(900)
    expect(await warm.get("m", open)).toBeDefined()
    await vi.advanceTimersByTimeAsync(900)
    expect(counts).toEqual({ opened: 1, closed: 0 })

    await vi.advanceTimersByTimeAsync(200)
    expect(counts).toEqual({ opened: 1, closed: 1 })
    await warm.get("m", open)
    expect(counts.opened).toBe(2)
    await warm.close()
    expect(counts.closed).toBe(2)
  })
})
