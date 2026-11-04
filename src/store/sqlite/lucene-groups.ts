/** `_direction`: the same groups, each split by `outgoing`, for counts of received and sent mail. */
export type QueryGrouping = "chat" | "sender" | "time" | "sender_direction" | "time_direction"
export interface QueryGroup {
  provider?: string
  account?: string
  id: string | null
  name: string | null
  outgoing?: boolean
  count: number
}
/** How `countQuery` groups the matches: the GROUP BY key and the columns each group reads. */
export const GROUPS: Record<QueryGrouping, { key: string; select: string }> = {
  chat: {
    key: "m.chat_id",
    select: "ac.provider AS provider, ac.external_id AS account, c.external_id AS id, c.title AS name",
  },
  sender: {
    key: "coalesce(m.sender_identity_id, -m.account_id)",
    select:
      "ac.provider AS provider, ac.external_id AS account, i.external_id AS id, i.name AS name, max(m.outgoing) AS outgoing",
  },
  // Quarter hours, so a calendar day or hour in any zone (+05:30, +05:45) is a whole number of buckets.
  time: { key: "m.sent_at / 900000", select: "CAST(min(m.sent_at / 900000) * 900000 AS TEXT) AS id, NULL AS name" },
  sender_direction: {
    key: "coalesce(m.sender_identity_id, -m.account_id), coalesce(m.outgoing, 0)",
    select:
      "ac.provider AS provider, ac.external_id AS account, i.external_id AS id, i.name AS name, coalesce(m.outgoing, 0) AS outgoing",
  },
  time_direction: {
    key: "m.sent_at / 900000, coalesce(m.outgoing, 0)",
    select: "CAST(min(m.sent_at / 900000) * 900000 AS TEXT) AS id, NULL AS name, coalesce(m.outgoing, 0) AS outgoing",
  },
}
