import type { ServiceDeps } from "./deps.js"
import type { MessagesService } from "./message-contracts.js"
import { messagesReadService } from "./messages-read.js"
import { messagesSearchService } from "./messages-search-service.js"
import { messagesWriteService } from "./messages-write.js"

export * from "./message-contracts.js"
export { chatAmong, chatIdIn, readChatId, scopeOf, senderAmong, storedChatId } from "./message-resolution.js"
export {
  MAX_SEARCH_OFFSET,
  SEARCH_FILL_MS,
  searchStore,
  statsStore,
  validateSearchDialect,
} from "./messages-search-service.js"
export { DELETE_AT_ONCE } from "./messages-write.js"

export const messagesService = (deps: ServiceDeps): MessagesService => ({
  ...messagesReadService(deps),
  ...messagesWriteService(deps),
  ...messagesSearchService(deps),
})
