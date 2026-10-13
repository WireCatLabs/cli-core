import { join } from "node:path"
import { CliError } from "@wirecat/cli-base"
import { filesPresent, sharedModelsDirectory } from "../../speech/install.js"
import type { ModelFile } from "../../speech/models.js"

/**
 * A model that gives a picture and a text query vectors of one space. Measured on 150 Telegram photos and 30
 * English queries (cli-testing `performance/search/images/`): MRR .93, against .39 for the caption alone.
 */
export interface ImageModel {
  id: string
  title: string
  /** The only language the text side understands; a query in another is translated first, by the caller. */
  languages: string
  licence: string
  dims: number
  /** The vectors' key in `embeddings`: `<provider>:<model>:<dims>`, as the text models' (`local:e5-small:384`). */
  key: string
  /** The query's longest length in tokens; a longer one is cut. */
  maxTokens: number
  files: ModelFile[]
  vision: string
  text: string
}

const clip = (name: string) =>
  `https://huggingface.co/Xenova/clip-vit-base-patch32/resolve/d15189d7028b43f1d3e65039190477f6af591c2a/${name}`

export const IMAGE_MODELS: ImageModel[] = [
  {
    id: "clip-b32",
    title: "CLIP ViT-B/32, 8-bit",
    languages: "English only: translate a query before searching",
    licence: "MIT",
    dims: 512,
    key: "local:clip-b32:512",
    maxTokens: 77,
    vision: "onnx/vision_model_quantized.onnx",
    text: "onnx/text_model_quantized.onnx",
    files: [
      {
        name: "onnx/vision_model_quantized.onnx",
        url: clip("onnx/vision_model_quantized.onnx"),
        sha256: "583fd1110a514667812fee7d684952aaf82a99b959760c8d7dca7e0ab9839299",
        bytes: 89_117_001,
      },
      {
        name: "onnx/text_model_quantized.onnx",
        url: clip("onnx/text_model_quantized.onnx"),
        sha256: "73baab855d406190da9faa498cfedf65f15cf309f4cc7385b7b032e6d08e5c3a",
        bytes: 64_504_507,
      },
      {
        name: "tokenizer.json",
        url: clip("tokenizer.json"),
        sha256: "f7f3b7af117d467b58374797691a6438d3e6b9e9cef800dfd5dced7f697a90cd",
        bytes: 2_224_119,
      },
      {
        name: "tokenizer_config.json",
        url: clip("tokenizer_config.json"),
        sha256: "60ba2912bc6344c94bc16bbdec27fa1209409167b6f2fdf3cfe9e65462ea3967",
        bytes: 775,
      },
    ],
  },
]

export const DEFAULT_IMAGE_MODEL = "clip-b32"

export const imageModel = (id: string): ImageModel => {
  const found = IMAGE_MODELS.find((model) => model.id === id)
  if (!found) {
    throw new CliError(
      "validation_error",
      `no image model ${id} — one of: ${IMAGE_MODELS.map((model) => model.id).join(", ")}`,
    )
  }
  return found
}

export const imageModelsDirectory = (env: NodeJS.ProcessEnv = process.env): string =>
  sharedModelsDirectory("image", env)

export const placedImage = (model: ImageModel, directory: string) =>
  model.files.map((file) => [file, join(directory, model.id, file.name)] as [ModelFile, string])

export const isImageModelInstalled = (model: ImageModel, directory: string): boolean =>
  filesPresent(placedImage(model, directory))
