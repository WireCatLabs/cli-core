import type { Id } from "../domain/models.js"
import { keysOver } from "./keys.js"
import * as conversationQueries from "./sqlite/conversations.js"
import { type MailStore, threadConversation } from "./sqlite/emails.js"
import * as imageChunks from "./sqlite/image-chunks.js"
import * as messageChunks from "./sqlite/message-chunks.js"
import type { StoreContext } from "./sqlite/open.js"
import { write } from "./sqlite/transaction.js"
import type { ChunkToEmbed } from "./sqlite/vectors.js"
import * as vectors from "./sqlite/vectors.js"
import type { AccountKey, ConversationHit, PictureInput, StoredReadiness } from "./types.js"

export interface AccountVectors {
  /** Chunks of the chat's current build with no vector of `model`, by hash after `after` (phase 5). */
  chunksToEmbed(
    key: AccountKey,
    chatId: Id,
    model: string,
    options: { after?: string; limit: number },
  ): Promise<ChunkToEmbed[]>
  /** The chat's live image attachments with the messages around each, and the chunk each already has. */
  imagesToDescribe(
    key: AccountKey,
    chatId: Id,
    window: { messages: number; withinMs: number },
  ): Promise<imageChunks.ImageInput[]>
  /** Makes these the chunks of their images, and drops the chat's image chunks not in `keep` (attachment pks). */
  saveImageChunks(key: AccountKey, chatId: Id, chunks: imageChunks.ImageChunk[], keep: number[]): Promise<void>
  /** The images nearest in meaning to `query` by the text around them, as their message in its conversation. */
  nearestImages(
    key: AccountKey,
    options: { chatId?: Id; model: string; since?: string; limit: number; query: Float32Array },
  ): Promise<ConversationHit[]>
  /** Live image attachments with no picture vector yet, in attachment order after `after`; `chatId` narrows it. */
  picturesToEmbed(key: AccountKey, options: { chatId?: Id; after?: number; limit: number }): Promise<PictureInput[]>
  /** Keeps each picture's vector of `model` and makes its hash the image's picture chunk. */
  savePictures(
    key: AccountKey,
    model: string,
    dims: number,
    pictures: { attachmentPk: number; hash: string; bytes: number; occurredAt: number; vector: Float32Array }[],
  ): Promise<void>
  /** The images nearest to `query` by their picture vector of `model`, best first, as their message. */
  nearestPictures(
    key: AccountKey,
    options: { chatId?: Id; model: string; since?: string; limit: number; query: Float32Array },
  ): Promise<{ chatId: Id; messageId: Id; score: number }[]>
  /** Live messages with text after pk `after`, with the chunk and vector each has; `chatId` narrows it. */
  messagesToEmbed(
    key: AccountKey,
    options: { chatId?: Id; model: string; after: number; limit: number },
  ): Promise<messageChunks.MessageToEmbed[]>
  /** Keeps each message's vector of `model` and makes its hash the message's chunk. */
  saveMessageVectors(
    key: AccountKey,
    model: string,
    dims: number,
    messages: { messagePk: number; hash: string; length: number; occurredAt: number; vector: Float32Array }[],
  ): Promise<void>
  /** Drops the chunks of messages gone, deleted or emptied, and the vectors only they used; how many. */
  dropGoneMessages(key: AccountKey): Promise<number>
  /** Whether any message of the account has a vector of `model`. */
  hasMessageVectors(key: AccountKey, model: string): Promise<boolean>
  /**
   * The messages nearest in meaning to `query` by their own vector of `model`, best first. The one place
   * message vectors are read, so their storage can change behind it.
   */
  nearestMessages(
    key: AccountKey,
    options: { chatId?: Id; model: string; since?: string; before?: string; limit: number; query: Float32Array },
  ): Promise<{ chatId: Id; messageId: Id; score: number }[]>
  /** The current build's distinct chunks, and how many have a vector of `model`. */
  vectorStatus(key: AccountKey, chatId: Id, model: string): Promise<{ chunks: number; embedded: number }>
  /** Drops the chat's vectors, or one model's; a vector another chat's chunk shares stays. */
  clearVectors(key: AccountKey, chatId: Id, model?: string): Promise<number>
  /** The conversations nearest in meaning to `query`, in one chat or every one of the account, best first. */
  nearestConversations(
    key: AccountKey,
    options: {
      chatId?: Id
      model: string
      since?: string
      limit: number
      query: Float32Array
      exclude?: string
      conversations?: string[]
      scope?: "personal" | "work"
      projectId?: string
      personId?: string
      before?: string
    },
  ): Promise<ConversationHit[]>
  /**
   * A conversation of the current build: how many chunks it has, and the vectors of `model` of those whose
   * messages did not change since — none when it is not the account's or not current.
   */
  conversationVectors(key: AccountKey, id: string, model: string): Promise<{ chunks: number; vectors: Float32Array[] }>
  /**
   * How fresh each built chat's conversations and `model`'s vectors are — one chat, or every chat whose
   * conversations were ever built. A chat never built answers `builtAt: null`. `searchableOnly` leaves out the chats
   * the owner hid from searches that do not name them.
   */
  readiness(
    key: AccountKey,
    options: { chatId?: Id; model: string; searchableOnly?: boolean },
  ): Promise<StoredReadiness[]>
  /** Group chats with stored messages whose conversations were never built, the newest message first. */
  unbuiltGroups(key: AccountKey): Promise<Id[]>
  /** Chats in scope embedded with another model and not with `model`, which a search with it cannot see. */
  embeddedOnlyElsewhere(key: AccountKey, options: { chatId?: Id; model: string }): Promise<Id[]>
}

export interface VectorsStore extends AccountVectors {
  saveVectors(model: string, dims: number, vectors: { hash: string; vector: Float32Array }[]): Promise<void>
  /** Which of these chunk hashes already have a vector of `model`. */
  embeddedHashes(model: string, hashes: string[]): Promise<Set<string>>
}

export const accountVectorsOver = (context: StoreContext, mail: () => MailStore): AccountVectors => {
  const { database } = context
  const { findAccountPk, findChatPk, chatKeyOf } = keysOver(context)
  return {
    chunksToEmbed: async (key, chatId, model, options) => {
      const chatKey = chatKeyOf(key, chatId)
      return chatKey === undefined ? [] : vectors.chunksToEmbed(context, chatKey, model, options)
    },

    imagesToDescribe: async (key, chatId, window) => {
      const chatKey = chatKeyOf(key, chatId)
      return chatKey === undefined ? [] : imageChunks.imagesOfChat(context, chatKey, window)
    },

    saveImageChunks: async (key, chatId, chunks, keep) => {
      const accountPk = findAccountPk(key)
      const chatKey = chatKeyOf(key, chatId)
      if (accountPk === undefined || chatKey === undefined) return
      write(database, () => imageChunks.saveImageChunks(context, accountPk, chatKey, chunks, keep))
    },

    nearestImages: async (key, { chatId, model, since, limit, query }) => {
      const accountPk = findAccountPk(key)
      if (accountPk === undefined) return []
      const chatKey = chatId === undefined ? undefined : chatKeyOf(key, chatId)
      if (chatId !== undefined && chatKey === undefined) return []
      const nearest = imageChunks.nearestImages(context, accountPk, {
        ...(chatKey === undefined ? {} : { chatKey }),
        ...(since === undefined ? {} : { since: Date.parse(since) }),
        model,
        limit,
        query,
      })
      const hits: ConversationHit[] = []
      for (const { chatId: chat, messageId, score } of nearest) {
        const chatPk = findChatPk(accountPk, chat)
        const conversation =
          chatPk === undefined ? undefined : conversationQueries.conversationOf(context, chatPk, messageId)
        const summary =
          conversation === undefined
            ? undefined
            : conversationQueries.summariesOf(context, accountPk, [Number(conversation)]).get(Number(conversation))
        if (summary)
          hits.push({
            summary,
            chunk: { firstMessageId: messageId, lastMessageId: messageId },
            score,
            stale: false,
            matchedIn: "context",
          })
      }
      return hits
    },

    picturesToEmbed: async (key, { chatId, after, limit }) => {
      const accountPk = findAccountPk(key)
      if (accountPk === undefined) return []
      const chatKey = chatId === undefined ? undefined : chatKeyOf(key, chatId)
      if (chatId !== undefined && chatKey === undefined) return []
      return imageChunks.picturesToEmbed(context, accountPk, {
        ...(chatKey === undefined ? {} : { chatKey }),
        ...(after === undefined ? {} : { after }),
        limit,
      })
    },

    savePictures: async (key, model, dims, pictures) => {
      const accountPk = findAccountPk(key)
      if (accountPk === undefined) return
      write(database, () => {
        vectors.saveVectors(
          context,
          model,
          dims,
          pictures.map(({ hash, vector }) => ({ hash, vector })),
        )
        imageChunks.savePictureChunks(context, accountPk, pictures)
      })
    },

    nearestPictures: async (key, { chatId, model, since, limit, query }) => {
      const accountPk = findAccountPk(key)
      if (accountPk === undefined) return []
      const chatKey = chatId === undefined ? undefined : chatKeyOf(key, chatId)
      if (chatId !== undefined && chatKey === undefined) return []
      return imageChunks.nearestImages(context, accountPk, {
        ...(chatKey === undefined ? {} : { chatKey }),
        ...(since === undefined ? {} : { since: Date.parse(since) }),
        model,
        limit,
        query,
        position: imageChunks.PICTURE_POSITION,
      })
    },

    messagesToEmbed: async (key, { chatId, model, after, limit }) => {
      const accountPk = findAccountPk(key)
      if (accountPk === undefined) return []
      const chatKey = chatId === undefined ? undefined : chatKeyOf(key, chatId)
      if (chatId !== undefined && chatKey === undefined) return []
      return messageChunks.messagesToEmbed(context, accountPk, {
        ...(chatKey === undefined ? {} : { chatKey }),
        model,
        after,
        limit,
      })
    },

    saveMessageVectors: async (key, model, dims, messages) => {
      const accountPk = findAccountPk(key)
      if (accountPk === undefined) return
      write(database, () => {
        vectors.saveVectors(
          context,
          model,
          dims,
          messages.map(({ hash, vector }) => ({ hash, vector })),
        )
        messageChunks.saveMessageChunks(context, accountPk, messages)
      })
    },

    dropGoneMessages: async (key) => {
      const accountPk = findAccountPk(key)
      if (accountPk === undefined) return 0
      let dropped = 0
      write(database, () => {
        dropped = messageChunks.dropGoneMessageChunks(context, accountPk)
      })
      return dropped
    },

    hasMessageVectors: async (key, model) => {
      const accountPk = findAccountPk(key)
      return accountPk !== undefined && messageChunks.hasMessageVectors(context, accountPk, model)
    },

    nearestMessages: async (key, { chatId, model, since, before, limit, query }) => {
      const accountPk = findAccountPk(key)
      if (accountPk === undefined) return []
      const chatKey = chatId === undefined ? undefined : chatKeyOf(key, chatId)
      if (chatId !== undefined && chatKey === undefined) return []
      return messageChunks.nearestMessages(context, accountPk, {
        ...(chatKey === undefined ? {} : { chatKey }),
        ...(since === undefined ? {} : { since: Date.parse(since) }),
        ...(before === undefined ? {} : { before: Date.parse(before) }),
        model,
        limit,
        query,
      })
    },

    vectorStatus: async (key, chatId, model) => {
      const chatKey = chatKeyOf(key, chatId)
      return chatKey === undefined ? { chunks: 0, embedded: 0 } : vectors.vectorStatus(context, chatKey, model)
    },

    clearVectors: async (key, chatId, model) => {
      const chatKey = chatKeyOf(key, chatId)
      if (chatKey === undefined) return 0
      let cleared = 0
      write(database, () => {
        cleared = vectors.clearVectors(context, chatKey, model)
      })
      return cleared
    },

    nearestConversations: async (
      key,
      { chatId, model, since, limit, query, exclude, conversations, scope, projectId, personId, before },
    ) => {
      const accountPk = findAccountPk(key)
      if (accountPk === undefined) return []
      const chatKey = chatId === undefined ? undefined : chatKeyOf(key, chatId)
      const mailToo =
        key.provider === "email" &&
        conversations === undefined &&
        scope === undefined &&
        projectId === undefined &&
        personId === undefined &&
        before === undefined
      const mailHits = async (): Promise<ConversationHit[]> =>
        mailToo
          ? (
              await mail().nearest(model, query, {
                accountId: accountPk,
                limit,
                ...(chatId === undefined ? {} : { threadExternalId: chatId }),
                ...(since === undefined ? {} : { since: Date.parse(since) }),
              })
            ).map((hit) => ({
              summary: threadConversation(hit, context.now()),
              chunk: { firstMessageId: hit.externalId, lastMessageId: hit.externalId },
              score: hit.score,
              stale: false,
            }))
          : []
      if (chatId !== undefined && chatKey === undefined) return mailHits()
      const nearest = vectors.nearestChunks(context, accountPk, {
        ...(chatKey === undefined ? {} : { chatKey }),
        ...(since === undefined ? {} : { since: Date.parse(since) }),
        ...(exclude === undefined ? {} : { exclude: Number(exclude) }),
        model,
        limit,
        query,
        ...(conversations === undefined ? {} : { conversations }),
        ...(scope === undefined ? {} : { scope }),
        ...(projectId === undefined ? {} : { projectId: Number(projectId) }),
        ...(personId === undefined ? {} : { personId: Number(personId) }),
        ...(before === undefined ? {} : { before: Date.parse(before) }),
      })
      const found = conversationQueries.summariesOf(
        context,
        accountPk,
        nearest.map(({ conversationPk }) => conversationPk),
      )
      const ids = vectors.messageIds(
        context,
        nearest.flatMap(({ firstMessagePk, lastMessagePk }) => [firstMessagePk, lastMessagePk]),
      )
      const messageHits: ConversationHit[] = nearest.flatMap((chunk) => {
        const summary = found.get(chunk.conversationPk)
        const first = ids.get(chunk.firstMessagePk)
        const last = ids.get(chunk.lastMessagePk)
        const freshness = vectors.chunkFreshness(context, chunk)
        return summary && first && last && freshness !== "deleted"
          ? [
              {
                summary,
                chunk: { firstMessageId: first, lastMessageId: last },
                score: chunk.score,
                stale: freshness === "stale",
              },
            ]
          : []
      })
      if (!mailToo) return messageHits
      return [...messageHits, ...(await mailHits())].sort((a, b) => b.score - a.score).slice(0, limit)
    },

    conversationVectors: async (key, id, model) => {
      const accountPk = findAccountPk(key)
      const pk = Number(id)
      if (accountPk === undefined || !conversationQueries.summariesOf(context, accountPk, [pk]).has(pk)) {
        return { chunks: 0, vectors: [] }
      }
      return vectors.conversationVectors(context, pk, model)
    },

    readiness: async (key, { chatId, model, searchableOnly = false }) => {
      const accountPk = findAccountPk(key)
      if (accountPk === undefined) return []
      const chats =
        chatId === undefined
          ? vectors.builtChats(context, accountPk, searchableOnly)
          : [{ chatKey: chatKeyOf(key, chatId), id: chatId }].flatMap(({ chatKey, id }) =>
              chatKey === undefined ? [] : [{ chatKey, id }],
            )
      return chats.map(({ chatKey, id }) => {
        const found = vectors.readiness(context, chatKey, model)
        return found
          ? { chatId: id, ...found, builtAt: new Date(found.builtAt).toISOString() }
          : {
              chatId: id,
              builtAt: null,
              algorithmVersion: null,
              pending: { new: 0, edited: 0, deleted: 0 },
              vectors: { chunks: 0, embedded: 0, current: 0, stale: 0, missing: 0 },
            }
      })
    },

    unbuiltGroups: async (key) => {
      const accountPk = findAccountPk(key)
      return accountPk === undefined ? [] : vectors.unbuiltGroups(context, accountPk)
    },

    embeddedOnlyElsewhere: async (key, { chatId, model }) => {
      const accountPk = findAccountPk(key)
      if (accountPk === undefined) return []
      const chatKey = chatId === undefined ? undefined : chatKeyOf(key, chatId)
      if (chatId !== undefined && chatKey === undefined) return []
      return vectors.embeddedOnlyElsewhere(context, accountPk, { ...(chatKey === undefined ? {} : { chatKey }), model })
    },
  }
}

export const vectorsStoreOver = (context: StoreContext, keyed: AccountVectors): VectorsStore => ({
  ...keyed,
  saveVectors: async (model, dims, rows) => {
    write(context.database, () => vectors.saveVectors(context, model, dims, rows))
  },
  embeddedHashes: async (model, hashes) => imageChunks.embeddedHashes(context, model, hashes),
})
