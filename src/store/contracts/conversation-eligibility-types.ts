import type { AccountKey } from "./models.js"

export interface ConversationEligibility {
  conversations: string[]
  chats: { account: AccountKey; chat: string }[]
}
