import { createHash } from "node:crypto"
import { readFile, stat } from "node:fs/promises"
import { setTimeout as sleep } from "node:timers/promises"
import { CliError } from "@wirecat/cli-base"
import { formatLocator } from "../domain/locator.js"
import { type Id, senderIsMe } from "../domain/models.js"
import type { PictureEmbedder } from "../images/picture/embedder.js"
import {
  DEFAULT_IMAGE_MODEL,
  imageModel,
  imageModelsDirectory,
  isImageModelInstalled,
} from "../images/picture/models.js"
import { capability, type RemoteFile } from "../ports/messenger.js"
import type { PictureInput } from "../store/store.js"
import type { ServiceDeps } from "./deps.js"
import { refreshedFiles } from "./file-download.js"
import { storedChatId } from "./message-resolution.js"
import type { MessagesService } from "./messages.js"

/** A bigger file is no photo a chat sends: skipping it costs a vector, reading it costs memory. */
export const PICTURE_MAX_BYTES = 25 * 1024 * 1024
/** On 150 real photos (cli-testing performance/search/images) every match scored ≥ .25; strangers .19 median, .27 at p99. */
export const PICTURE_FLOOR = 0.25
const PAGE = 50
const SAVE_EVERY = 8

export interface PicturesEmbedded {
  model: string
  embedded: number
  /** Not read: too large, no longer fetchable, or no file the adapter gave back for it. */
  skipped: number
  failed: number
  /** Another run finds more: the limit came first. */
  more: boolean
}

export interface PictureHit {
  locator: string
  chatId: Id
  messageId: Id
  timestamp: string
  senderName: string | null
  senderIsMe: boolean
  score: number
}

export interface PictureLane {
  pictures?: PictureHit[]
  /** Why a profile that turned picture search on has no `pictures` list, said as `meaningSkipped` says it. */
  picturesSkipped?: string
  /** The picture model to download, when its absence is why `picturesSkipped` is set. */
  picturesModel?: string
}

export const PICTURES_OFF =
  "picture search is off for this profile — set pictureSearch to true in its config to turn it on"

const missingModel = (id: string) => `the picture model is not downloaded — \`images models download ${id}\` fetches it`

/** What CLIP's text side can use of a Lucene query: the words, without fields, operators and quotes. */
export const plainWords = (query: string): string =>
  query
    .replace(/\b(?:text|content|transcript|filename):("[^"]*"|\S+)/gi, "$1")
    .replace(/\b[a-z_]+:("[^"]*"|\[[^\]]*\]|\{[^}]*\}|\([^)]*\)|\S+)/gi, " ")
    .replace(/\b(?:AND|OR|NOT)\b/g, " ")
    .replace(/[()"+\-~^*?\\[\]{}!|&]/g, " ")
    .replace(/\s+/g, " ")
    .trim()

export const picturesService = (deps: ServiceDeps) => {
  let opened: Promise<PictureEmbedder> | undefined
  const open = async (): Promise<PictureEmbedder> => {
    if (deps.pictureEmbedder) return deps.pictureEmbedder()
    const model = imageModel(DEFAULT_IMAGE_MODEL)
    const directory = imageModelsDirectory(deps.env)
    if (!isImageModelInstalled(model, directory))
      throw new CliError("not_found", missingModel(model.id), { reason: "model.not-downloaded", model: model.id })
    const { openPictureEmbedder } = await import("../images/picture/embedder.js")
    return openPictureEmbedder(model, directory)
  }
  const embedder = () => {
    opened ??= open().catch((error: unknown) => {
      opened = undefined
      throw error
    })
    return opened
  }
  const model = imageModel(DEFAULT_IMAGE_MODEL)

  const bytesOf = async (
    picture: PictureInput,
    files: () => Promise<RemoteFile[]>,
    read: (file: RemoteFile) => Promise<void>,
  ): Promise<Uint8Array | undefined> => {
    if (picture.localPath) {
      try {
        if ((await stat(picture.localPath)).size <= PICTURE_MAX_BYTES) return await readFile(picture.localPath)
      } catch {
        // The saved copy is gone; the messenger still has the picture.
      }
    }
    const images = (await files()).filter(({ kind, mime }) => kind === "photo" || mime?.startsWith("image/"))
    const file =
      images.find(({ position }) => position === picture.position) ??
      (images.every(({ position }) => position === undefined) ? images[0] : undefined)
    if (!file || (file.size !== undefined && file.size > PICTURE_MAX_BYTES)) return undefined
    const parts: Uint8Array[] = []
    let total = 0
    for await (const part of file.bytes()) {
      total += part.length
      if (total > PICTURE_MAX_BYTES) return undefined
      parts.push(part)
    }
    await read(file)
    return Buffer.concat(parts)
  }

  return {
    /**
     * Gives the images no vector yet one, reading each through the messenger's own download and keeping nothing
     * of the file: only the vector and the hash of its bytes. One at a time, with a pause, and nothing is marked
     * read. Run again, it goes on where the last run stopped: an image with a vector is not read twice.
     */
    embed: async ({
      chat,
      limit,
      pauseMs = 250,
      signal,
    }: {
      chat?: string
      limit: number
      pauseMs?: number
      signal?: AbortSignal
    }): Promise<PicturesEmbedded> => {
      if (!deps.pictures) throw new CliError("validation_error", PICTURES_OFF)
      const store = await deps.store()
      const account = await deps.account()
      const chatId =
        chat === undefined ? undefined : await storedChatId(deps.messenger, chat, store, account, { includeLeft: true })
      const use = await embedder()
      const result: PicturesEmbedded = { model: model.key, embedded: 0, skipped: 0, failed: 0, more: false }
      const pending: Parameters<typeof store.vectors.savePictures>[3] = []
      const flush = async () => {
        if (pending.length === 0) return
        await store.vectors.savePictures(account, model.key, model.dims, pending.splice(0))
      }
      let after = 0
      let seen = 0
      try {
        while (seen < limit) {
          const page = await store.vectors.picturesToEmbed(account, {
            ...(chatId === undefined ? {} : { chatId }),
            after,
            limit: Math.min(PAGE, limit - seen),
          })
          if (page.length === 0) break
          let downloaded: { message: Id; files: Promise<RemoteFile[]> } | undefined
          for (const picture of page) {
            if (signal?.aborted) throw new CliError("cancelled", "picture embedding cancelled")
            after = picture.attachmentPk
            seen += 1
            const files = () => {
              if (downloaded?.message !== `${picture.chatId}/${picture.messageId}`) {
                downloaded = {
                  message: `${picture.chatId}/${picture.messageId}`,
                  files: (async () => {
                    const download = capability(await deps.connection(), "download", "download attachments")
                    return (await download(picture.chatId, picture.messageId)).files
                  })(),
                }
              }
              return downloaded.files
            }
            try {
              const bytes = await bytesOf(picture, files, async (file) => {
                const refreshed = refreshedFiles([file])
                if (refreshed.length === 0) return
                // A ref not saved costs only another fetch; the vector is still worth keeping.
                await store.attachments
                  .keepProviderRefs(account, picture.chatId, picture.messageId, refreshed)
                  .catch(() => undefined)
              })
              if (!bytes) {
                result.skipped += 1
                continue
              }
              const vector = await use.embedImage(bytes)
              pending.push({
                attachmentPk: picture.attachmentPk,
                hash: createHash("sha256").update(bytes).digest("hex"),
                bytes: bytes.length,
                occurredAt: picture.sentAt,
                vector,
              })
              result.embedded += 1
              if (pending.length >= SAVE_EVERY) await flush()
            } catch (error) {
              if (error instanceof CliError && error.code === "cancelled") throw error
              result.failed += 1
            }
            if (pauseMs > 0) await sleep(pauseMs, undefined, signal ? { signal } : {}).catch(() => {})
          }
        }
        result.more =
          seen >= limit &&
          (
            await store.vectors.picturesToEmbed(account, {
              after,
              limit: 1,
              ...(chatId === undefined ? {} : { chatId }),
            })
          ).length > 0
      } finally {
        await flush()
        await use.close()
        opened = undefined
      }
      return result
    },

    /** The pictures nearest to what the words describe, as their messages; the lane beside the text hits. */
    lane: async (
      query: string,
      { chat, since, limit = 5 }: { chat?: string; since?: string; limit?: number } = {},
    ): Promise<PictureLane> => {
      if (!deps.pictures) return {}
      const words = plainWords(query)
      if (words === "") return {}
      const store = await deps.store()
      const account = await deps.account()
      const chatId =
        chat === undefined ? undefined : await storedChatId(deps.messenger, chat, store, account, { includeLeft: true })
      let vector: Float32Array
      try {
        const use = await embedder()
        vector = await use.embedQuery(words)
      } catch (error) {
        if (error instanceof CliError && error.code === "not_found")
          return { picturesSkipped: error.message, picturesModel: model.id }
        throw error
      } finally {
        const held = opened
        opened = undefined
        await held?.then((use) => use.close()).catch(() => {})
      }
      const near = await store.vectors.nearestPictures(account, {
        ...(chatId === undefined ? {} : { chatId }),
        ...(since === undefined ? {} : { since }),
        model: model.key,
        limit,
        query: vector,
      })
      const hits = await Promise.all(
        near
          .filter(({ score }) => score >= PICTURE_FLOOR)
          .map(async ({ chatId: chatKey, messageId, score }) => {
            const message = await store.messages.message(account, messageId, { chatId: chatKey })
            if (!message) return []
            return [
              {
                locator: formatLocator({
                  provider: account.provider,
                  account: account.account,
                  chat: chatKey,
                  message: messageId,
                }),
                chatId: chatKey,
                messageId,
                timestamp: message.timestamp,
                senderName: message.senderName,
                senderIsMe: senderIsMe(message, account.account),
                score: Number(score.toFixed(4)),
              },
            ]
          }),
      )
      return { pictures: hits.flat() }
    },
  }
}

export type PicturesService = ReturnType<typeof picturesService>

/**
 * `search` with the picture lane beside its hits. The lane never changes the hits or their order, and a failure
 * in it is a note, not a failed search. Mail, discovery and the second page of a search have none.
 */
export const withPictures = (messages: MessagesService, pictures: PicturesService): MessagesService => ({
  ...messages,
  search: async (request) => {
    const found = await messages.search(request)
    if (request.kind === "mail" || request.discover || request.text === undefined) return found
    if (request.offset) return found
    const chat = request.chat ?? found.coverage?.chat
    const lane = await pictures
      .lane(request.text, chat === undefined ? {} : { chat })
      .catch(
        (error: unknown): PictureLane => ({ picturesSkipped: error instanceof Error ? error.message : String(error) }),
      )
    return { ...found, ...lane }
  },
})
