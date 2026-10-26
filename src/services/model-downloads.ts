import { CliError } from "@wirecat/cli-base"
import { isTextModelInstalled, placedText, textModelsDirectory } from "../embeddings/embed.js"
import { type RerankModel, rerankModel, type TextModel, textModel } from "../embeddings/models.js"
import {
  type ImageModel,
  imageModel,
  imageModelsDirectory,
  isImageModelInstalled,
  placedImage,
} from "../images/picture/models.js"
import { installFiles, megabytes } from "../speech/install.js"

export interface ModelDownloadOptions {
  env: NodeJS.ProcessEnv
  /** One line at a time: the size before the download, its progress, then the check. */
  progress?: (line: string) => void
}

export interface DownloadedModel<M> {
  model: M
  directory: string
}

const bytesOf = (model: { files: readonly { bytes: number }[] }) =>
  model.files.reduce((sum, file) => sum + file.bytes, 0)

/**
 * The text embedding model into the shared models folder, checked against the sha256 this version expects and
 * loaded once on a word. Nothing is downloaded when it is already there; it is still loaded.
 */
export const downloadTextModel = async (
  id: string,
  { env, progress = () => {}, acceptTerms = false }: ModelDownloadOptions & { acceptTerms?: boolean },
): Promise<DownloadedModel<TextModel>> => {
  const model = textModel(id)
  if (model.terms && !acceptTerms) {
    throw new CliError(
      "validation_error",
      `${model.id} comes under the ${model.licence} (${model.terms}): read them, then run this again with --accept-terms`,
    )
  }
  const directory = textModelsDirectory(env)
  if (!isTextModelInstalled(model, directory)) {
    progress(`${model.id}: ${megabytes(bytesOf(model))} from Hugging Face`)
    await installFiles(placedText(model, directory), { progress })
  }
  progress(`${model.id}: loading it once to check it works`)
  const { openEmbedder } = await import("../embeddings/embed.js")
  const embedder = await openEmbedder(model, directory)
  try {
    const [vector] = await embedder.embed(["check"], "query")
    if (vector?.length !== model.dims)
      throw new CliError("invalid_response", `${model.id} gave a vector of the wrong size`)
  } finally {
    await embedder.close()
  }
  return { model, directory }
}

/** A reranker, the same way as {@link downloadTextModel}, into the same folder. */
export const downloadRerankModel = async (
  id: string,
  { env, progress = () => {} }: ModelDownloadOptions,
): Promise<DownloadedModel<RerankModel>> => {
  const model = rerankModel(id)
  const directory = textModelsDirectory(env)
  if (!isTextModelInstalled(model, directory)) {
    progress(`${model.id}: ${megabytes(bytesOf(model))} from Hugging Face`)
    await installFiles(placedText(model, directory), { progress })
  }
  progress(`${model.id}: loading it once to check it works`)
  const { openReranker } = await import("../embeddings/rerank.js")
  const reranker = await openReranker(model, directory)
  try {
    await reranker.score("check", ["check"])
  } finally {
    await reranker.close()
  }
  return { model, directory }
}

/** The picture model, the same way as {@link downloadTextModel}. */
export const downloadImageModel = async (
  id: string,
  { env, progress = () => {} }: ModelDownloadOptions,
): Promise<DownloadedModel<ImageModel>> => {
  const model = imageModel(id)
  const directory = imageModelsDirectory(env)
  if (!isImageModelInstalled(model, directory)) {
    progress(`${model.id}: ${megabytes(bytesOf(model))} from Hugging Face`)
    await installFiles(placedImage(model, directory), { progress })
  }
  progress(`${model.id}: loading it once to check it works`)
  const { openPictureEmbedder } = await import("../images/picture/embedder.js")
  const embedder = await openPictureEmbedder(model, directory)
  try {
    const vector = await embedder.embedQuery("check")
    if (vector.length !== model.dims)
      throw new CliError("invalid_response", `${model.id} gave a vector of the wrong size`)
  } finally {
    await embedder.close()
  }
  return { model, directory }
}
