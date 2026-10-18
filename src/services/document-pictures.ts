import { createHash } from "node:crypto"
import { CliError } from "@wirecat/cli-base"
import type { PictureEmbedder } from "../images/picture/embedder.js"
import {
  DEFAULT_IMAGE_MODEL,
  imageModel,
  imageModelsDirectory,
  isImageModelInstalled,
} from "../images/picture/models.js"
import type { MessageStore } from "../store/store.js"

export interface PictureOptions {
  /** An open embedder to reuse across many pictures; opened for this one call and closed after when absent. */
  embedder?: PictureEmbedder
  env?: NodeJS.ProcessEnv
  /** The tool's command, named in the hint when the model is missing. */
  command?: string
}

export type DocumentTarget = { ref: string; documentId?: never } | { documentId: string | number; ref?: never }

const refOf = (target: DocumentTarget): string => target.ref ?? `document:${target.documentId}`

/** Opens the picture model, or says which command downloads it. Close the result when done. */
export const openPictureEmbedderFor = async ({ env, command }: PictureOptions = {}): Promise<PictureEmbedder> => {
  const model = imageModel(DEFAULT_IMAGE_MODEL)
  const directory = imageModelsDirectory(env)
  if (!isImageModelInstalled(model, directory))
    throw new CliError(
      "not_found",
      `the picture model is not downloaded — ${
        command === undefined
          ? "install it with a WireCat CLI that has `images models download` (tg, max or wa); they share the model folder"
          : `\`${command} images models download ${model.id}\` fetches it`
      }`,
      { reason: "model.not-downloaded", model: model.id },
    )
  const { openPictureEmbedder } = await import("../images/picture/embedder.js")
  return openPictureEmbedder(model, directory)
}

/**
 * Gives a document the vector of its picture. The same bytes as last time cost nothing: only the sha256 is
 * compared. Other bytes replace the vector. Nothing of the file is kept. Resolves `unchanged` or `saved`.
 */
export const savePicture = async (
  store: MessageStore,
  target: DocumentTarget,
  bytes: Uint8Array,
  options: PictureOptions = {},
): Promise<"saved" | "unchanged"> => {
  const ref = refOf(target)
  const model = imageModel(DEFAULT_IMAGE_MODEL)
  const hash = createHash("sha256").update(bytes).digest("hex")
  if ((await store.notes.pictureHash(ref, model.key)) === hash) return "unchanged"
  const embedder = options.embedder ?? (await openPictureEmbedderFor(options))
  try {
    const vector = await embedder.embedImage(bytes)
    await store.notes.savePicture(ref, { model: model.key, dims: model.dims, hash, bytes: bytes.length, vector })
  } finally {
    if (!options.embedder) await embedder.close()
  }
  return "saved"
}

/** Drops a document's picture, for a file that is no longer an image or no longer wanted; false when it had none. */
export const removePicture = (store: MessageStore, target: DocumentTarget): Promise<boolean> =>
  store.notes.removePicture(refOf(target))
