import { CliError } from "@wirecat/cli-base"
import { CHANNEL_TAG_RULES_VERSION, classifyChannel } from "../domain/channel-tags.js"
import { capability } from "../ports/messenger.js"
import type { ServiceDeps } from "./deps.js"
import { storedChatId } from "./message-resolution.js"

export const metadataService = (deps: ServiceDeps) => {
  const held = async (reference: string) => {
    const store = await deps.store()
    const account = await deps.account()
    const chatId = await storedChatId(deps.messenger, reference, store, account)
    return { store, account, chatId }
  }
  const refresh = async (reference: string) => {
    if (deps.offline) throw new CliError("validation_error", "metadata refresh needs a connection; omit --offline")
    const { store, account, chatId } = await held(reference)
    const found = (await store.chats(account, {})).items.find((chat) => chat.id === chatId)
    if (!found || (found.kind !== "group" && found.kind !== "channel"))
      throw new CliError("validation_error", "metadata refresh applies to groups and channels")
    const read = async (adapter: Awaited<ReturnType<ServiceDeps["connection"]>>) =>
      capability(adapter, "group", "read group or channel metadata")(chatId)
    const card = deps.withConnection ? await deps.withConnection(read) : await read(await deps.connection())
    return store.saveChatMetadata(account, {
      chatId,
      title: card.title,
      description: card.description,
      username: typeof card.providerMetadata?.username === "string" ? card.providerMetadata.username : null,
    })
  }
  return {
    /** The chats named, or every stored group and channel, that hold no metadata yet; a name the store lacks stays. */
    missing: async (references: string[] = []) => {
      const store = await deps.store()
      const account = await deps.account()
      const chats = references.length
        ? references
        : (await store.chats(account, {})).items
            .filter((chat) => chat.kind === "group" || chat.kind === "channel")
            .map((chat) => chat.id)
      const missing = []
      for (const reference of chats) {
        const chatId = await storedChatId(deps.messenger, reference, store, account).catch(() => undefined)
        if (chatId === undefined || !(await store.chatMetadata(account, chatId))) missing.push(reference)
      }
      return missing
    },
    get: async (reference: string) => {
      const { store, account, chatId } = await held(reference)
      return { chatId, metadata: (await store.chatMetadata(account, chatId)) ?? null }
    },
    refresh,
    auto: async (options: { chats?: string[]; limit?: number; refresh?: boolean; dryRun?: boolean }) => {
      const limit = options.limit ?? 50
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500)
        throw new CliError("validation_error", "--limit takes 1–500")
      if (options.dryRun && options.refresh)
        throw new CliError("validation_error", "dry-run uses cached metadata; omit --refresh-metadata")
      const store = await deps.store()
      const account = await deps.account()
      const chats = options.chats?.length
        ? options.chats
        : (await store.chats(account, {})).items
            .filter((chat) => chat.kind === "group" || chat.kind === "channel")
            .map((chat) => chat.id)
      const items = []
      for (const reference of chats.slice(0, limit)) {
        try {
          const chatId = await storedChatId(deps.messenger, reference, store, account)
          const metadata = options.refresh ? await refresh(chatId) : await store.chatMetadata(account, chatId)
          const chat = (await store.chats(account, {})).items.find((entry) => entry.id === chatId)
          if (!chat || (chat.kind !== "group" && chat.kind !== "channel"))
            throw new CliError("validation_error", "automatic tags apply to groups and channels")
          const input = metadata ?? {
            title: chat.title,
            username: typeof chat.providerMetadata?.username === "string" ? chat.providerMetadata.username : null,
            description: null,
          }
          const tags = classifyChannel(input)
          if (!options.dryRun) await store.replaceAutoTags(account, chatId, CHANNEL_TAG_RULES_VERSION, tags)
          items.push({
            chatId,
            tags,
            algorithm: CHANNEL_TAG_RULES_VERSION,
            fetchedAt: metadata?.fetchedAt ?? null,
            source: metadata ? "metadata" : "stored-chat",
          })
        } catch (error) {
          if (!(error instanceof CliError)) throw error
          items.push({ chatId: reference, error: { code: error.code, message: error.message } })
        }
      }
      return { items, hasMore: chats.length > limit, dryRun: options.dryRun ?? false }
    },
  }
}
