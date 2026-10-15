import { CliError } from "@wirecat/cli-base"
import type { MessengerTraits } from "../ports/traits.js"
import type { AccountKey, MessageStore } from "../store/store.js"
import { type EvidencePacket, prepareEvidencePacket } from "./evidence.js"
import { storedChatId } from "./message-resolution.js"

export interface EvidenceReadQuery {
  chat: string
  limit: number
  before?: string
}

export interface StoredEvidencePacket extends EvidencePacket {
  nextBeforeId: string | null
}

/** Reads only the authorised account's store, retaining the newest whole-message prefix. */
export const readEvidencePacket = async (
  store: MessageStore,
  account: AccountKey,
  { chat, limit, before }: EvidenceReadQuery,
  messenger: Partial<Pick<MessengerTraits, "savedChatId">> = {},
): Promise<StoredEvidencePacket> => {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    throw new CliError("validation_error", "evidence message limit must be an integer from 1 to 100")
  if (before !== undefined && !before.trim())
    throw new CliError("validation_error", "evidence before id must not be empty")

  const chatId = await storedChatId(messenger, chat, store, account)
  const page = await store.messages(account, chatId, { limit, ...(before === undefined ? {} : { before }) })
  const items = page.items.toReversed()
  const packet = prepareEvidencePacket({
    kind: "chats",
    source: { ...account, chat: chatId },
    page: { ...page, items },
    limits: { messages: limit },
  })
  const older = page.hasMore || packet.coverage.omitted > 0
  const last = items[packet.items.length - 1]
  return { ...packet, nextBeforeId: older && last ? last.id : null }
}
