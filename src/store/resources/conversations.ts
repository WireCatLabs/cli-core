import { CliError } from "@wirecat/cli-base"
import type { ConversationsStore } from "../contracts/conversations.js"
import type { ConversationHit } from "../contracts/models.js"
import * as batches from "../sqlite/batches.js"
import * as chatQueries from "../sqlite/chats.js"
import { conversationEligibility } from "../sqlite/conversation-eligibility.js"
import * as conversationQueries from "../sqlite/conversations.js"
import { threadConversation } from "../sqlite/emails.js"
import { toMs } from "../sqlite/values.js"
import * as vectors from "../sqlite/vectors.js"
import type { StoreRuntime } from "./runtime.js"

export const conversationsStoreOver = ({
  context,
  inTransaction,
  findAccountPk,
  findChatPk,
  chatKeyOf,
  mailOf,
}: Pick<
  StoreRuntime,
  "context" | "inTransaction" | "findAccountPk" | "findChatPk" | "chatKeyOf" | "mailOf"
>): ConversationsStore => {
  return {
    linkInputs: async (key, chatId, page) => {
      const chatKey = chatKeyOf(key, chatId)
      return chatKey === undefined ? { items: [], next: null } : conversationQueries.linkInputs(context, chatKey, page)
    },

    senderHandles: async (key, chatId) => {
      const chatKey = chatKeyOf(key, chatId)
      return chatKey === undefined ? new Map() : conversationQueries.senderHandles(context, chatKey)
    },

    replaceConversations: async (key, chatId, build) => {
      const chatKey = chatKeyOf(key, chatId)
      if (chatKey === undefined) throw new CliError("not_found", `chat ${chatId} is not in the local copy`)
      await conversationQueries.replaceConversations(context, chatKey, build)
    },

    conversations: async (key, chatId, { limit, after, before }) => {
      const chatKey = chatKeyOf(key, chatId)
      return chatKey === undefined
        ? { items: [], hasMore: false }
        : conversationQueries.conversationPage(context, chatKey, {
            limit,
            ...(after === undefined ? {} : { after: toMs(after) as number }),
            ...(before === undefined ? {} : { before: toMs(before) as number }),
          })
    },

    conversation: async (key, id) => {
      const accountKey = findAccountPk(key)
      const pk = Number(id)
      return accountKey === undefined || !Number.isSafeInteger(pk)
        ? undefined
        : conversationQueries.conversation(context, accountKey, pk)
    },

    conversationOf: async (key, chatId, messageId) => {
      const chatKey = chatKeyOf(key, chatId)
      return chatKey === undefined ? undefined : conversationQueries.conversationOf(context, chatKey, messageId)
    },

    conversationsOfMessages: async (key, refs) => {
      const accountPk = findAccountPk(key)
      if (accountPk === undefined) return refs.map(() => undefined)
      const pks = refs.map(({ chatId, messageId }) => {
        const chatKey = findChatPk(accountPk, chatId)
        const id = chatKey === undefined ? undefined : conversationQueries.conversationOf(context, chatKey, messageId)
        return id === undefined ? undefined : Number(id)
      })
      const found = conversationQueries.summariesOf(
        context,
        accountPk,
        pks.filter((pk) => pk !== undefined),
      )
      return pks.map((pk) => (pk === undefined ? undefined : found.get(pk)))
    },

    links: async (key, chatId, messageId, options) => {
      const chatKey = chatKeyOf(key, chatId)
      return chatKey === undefined ? [] : conversationQueries.linksOf(context, chatKey, messageId, options?.limit)
    },

    replies: async (key, chatId, messageId, limit) => {
      const chatKey = chatKeyOf(key, chatId)
      return chatKey === undefined
        ? { items: [], hasMore: false }
        : conversationQueries.repliesTo(context, chatKey, messageId, limit)
    },

    agentAnswers: async (key, chatId) => {
      const chatKey = chatKeyOf(key, chatId)
      return chatKey === undefined ? new Map() : conversationQueries.agentAnswers(context, chatKey)
    },

    saveAnswers: async (key, batch, answer) => {
      const chatKey = batches.chatOfBatch(batch)
      const accountKey = findAccountPk(key)
      const chat =
        chatKey === undefined || accountKey === undefined ? undefined : chatQueries.chatOf(context, accountKey, chatKey)
      if (chatKey === undefined || chat === undefined) {
        throw new CliError("validation_error", `the answer was not stored: ${batch} is not a batch of this account`)
      }
      let stored = 0
      inTransaction(() => {
        stored = batches.saveAnswers(context, batch, answer)
      })
      return { chat, stored }
    },

    clearAnswers: async (key, chatId, model) => {
      const chatKey = chatKeyOf(key, chatId)
      if (chatKey === undefined) return 0
      let cleared = 0
      inTransaction(() => {
        cleared = batches.clearAnswers(context, chatKey, model)
      })
      return cleared
    },

    batchStatus: async (key, chatId) => {
      const chatKey = chatKeyOf(key, chatId)
      return chatKey === undefined ? { messages: 0, characters: 0 } : batches.batchStatus(context, chatKey)
    },

    nextBatch: async (key, chatId, { size }) => {
      const chatKey = chatKeyOf(key, chatId)
      if (chatKey === undefined) return undefined
      const found = batches.nextBatch(context, chatKey, chatId, size)
      if (!found) return undefined
      const answered = found.messages.filter(({ answer }) => answer)
      const left = batches.batchStatus(context, chatKey)
      return {
        ...found,
        remaining: {
          messages: left.messages - answered.length,
          characters: left.characters - answered.reduce((sum, { text }) => sum + [...text].length, 0),
        },
      }
    },

    chunksToEmbed: async (key, chatId, model, options) => {
      const chatKey = chatKeyOf(key, chatId)
      return chatKey === undefined ? [] : vectors.chunksToEmbed(context, chatKey, model, options)
    },

    saveVectors: async (model, dims, rows) => {
      inTransaction(() => vectors.saveVectors(context, model, dims, rows))
    },

    vectorStatus: async (key, chatId, model) => {
      const chatKey = chatKeyOf(key, chatId)
      return chatKey === undefined ? { chunks: 0, embedded: 0 } : vectors.vectorStatus(context, chatKey, model)
    },

    clearVectors: async (key, chatId, model) => {
      const chatKey = chatKeyOf(key, chatId)
      if (chatKey === undefined) return 0
      let cleared = 0
      inTransaction(() => {
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
              await mailOf().nearest(model, query, {
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

    readiness: async (key, { chatId, model }) => {
      const accountPk = findAccountPk(key)
      if (accountPk === undefined) return []
      const chats =
        chatId === undefined
          ? vectors.builtChats(context, accountPk)
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

    conversationState: async (key, chatId) => {
      const chatKey = chatKeyOf(key, chatId)
      return chatKey === undefined ? undefined : conversationQueries.stateOf(context, chatKey)
    },

    conversationEligibility: async (execution) => conversationEligibility(context, execution),
  }
}
