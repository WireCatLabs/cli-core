import type { ConversationEligibility } from "../contracts/conversation-eligibility-types.js"

export type { ConversationEligibility } from "../contracts/conversation-eligibility-types.js"

import type { QueryExecution } from "../../search/lucene/resolved.js"
import { queryMessagePks } from "./lucene.js"
import type { StoreContext } from "./open.js"

export const conversationEligibility = async (
  context: StoreContext,
  execution: QueryExecution,
): Promise<ConversationEligibility> => {
  if (!execution.accounts.length) return { conversations: [], chats: [] }
  const pks = JSON.stringify(await queryMessagePks(context, execution))
  const conversations = context.database
    .prepare(`SELECT DISTINCT cv.id AS id FROM conversation_messages cm
    JOIN conversations cv ON cv.id=cm.conversation_id
    JOIN conversation_state cs ON cs.chat_id=cv.chat_id AND cs.current_build=cv.build
    WHERE cm.message_id IN (SELECT value FROM json_each(?))`)
    .all(pks)
    .map(({ id }) => String(id))
  const chats = context.database
    .prepare(`SELECT DISTINCT ac.provider, ac.external_id AS account, ch.external_id AS chat
    FROM messages m JOIN chats ch ON ch.id=m.chat_id JOIN accounts ac ON ac.id=m.account_id
    WHERE m.id IN (SELECT value FROM json_each(?))`)
    .all(pks)
    .map((row) => ({
      account: { provider: String(row.provider), account: String(row.account) },
      chat: String(row.chat),
    }))
  return { conversations, chats }
}
