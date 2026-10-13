import { readFileSync } from "node:fs"
import { join } from "node:path"
import { truncated, unit } from "../../embeddings/embed.js"
import type { ImageModel } from "./models.js"
import { type LoadCanvas, preprocess, SIZE } from "./preprocess.js"

export interface PictureEmbedder {
  readonly model: ImageModel
  /** The picture's unit vector: the bytes of a PNG, JPEG, GIF or WebP. */
  embedImage(bytes: Uint8Array): Promise<Float32Array>
  /** The query's unit vector, in the same space as the pictures'. */
  embedQuery(text: string): Promise<Float32Array>
  close(): Promise<void>
}

export const openPictureEmbedder = async (
  model: ImageModel,
  directory: string,
  { threads = 4, canvas }: { threads?: number; canvas?: LoadCanvas } = {},
): Promise<PictureEmbedder> => {
  const [{ Tokenizer }, ort] = await Promise.all([
    import("@huggingface/tokenizers"),
    import("@wirecat/cli-messaging-onnx"),
  ])
  const path = (name: string) => join(directory, model.id, name)
  const tokenizer = new Tokenizer(
    JSON.parse(readFileSync(path("tokenizer.json"), "utf8")),
    JSON.parse(readFileSync(path("tokenizer_config.json"), "utf8")),
  )
  ort.env.wasm.numThreads = threads
  const sessions: { release(): Promise<void> }[] = []
  // A search needs the text side alone and `images embed` the vision side alone: each loads on first use.
  const lazy = (name: string) => {
    let session: ReturnType<typeof ort.InferenceSession.create> | undefined
    return () => {
      session ??= ort.InferenceSession.create(readFileSync(path(name))).then((created) => {
        sessions.push(created)
        return created
      })
      return session
    }
  }
  const vision = lazy(model.vision)
  const text = lazy(model.text)

  return {
    model,
    embedImage: async (bytes) => {
      const pixels = await preprocess(bytes, canvas)
      const output = await (await vision()).run({ pixel_values: new ort.Tensor("float32", pixels, [1, 3, SIZE, SIZE]) })
      return unit(Float32Array.from(output.image_embeds?.data as Float32Array))
    },
    embedQuery: async (query) => {
      const ids = truncated(tokenizer.encode(query.toLowerCase()).ids, model.maxTokens)
      const shape = [1, ids.length]
      const session = await text()
      const feeds: Record<string, InstanceType<typeof ort.Tensor>> = {
        input_ids: new ort.Tensor("int64", BigInt64Array.from(ids, BigInt), shape),
      }
      if (session.inputNames.includes("attention_mask"))
        feeds.attention_mask = new ort.Tensor("int64", new BigInt64Array(ids.length).fill(1n), shape)
      const output = await session.run(feeds)
      return unit(Float32Array.from(output.text_embeds?.data as Float32Array))
    },
    close: async () => {
      await Promise.all(sessions.map((session) => session.release()))
    },
  }
}
