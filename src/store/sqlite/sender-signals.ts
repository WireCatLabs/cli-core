import { isNoReplyAddress } from "../../domain/addresses.js"
import type { CacheDatabase } from "../driver.js"
import { SMALL_GROUP_MEMBERS } from "./person-ties.js"

/**
 * How a sender's messages reached the owner: written to them or a few people, in a large group or a discussion list,
 * or sent to many readers who cannot answer in place.
 */
export const REACHES = ["direct", "group", "broadcast"] as const
export type Reach = (typeof REACHES)[number]

/** What the mail of one sender shows about who writes and how it reached the owner. */
export type SenderSignal =
  | "auto-submitted"
  | "null-return-path"
  | "no-reply"
  | "one-click-unsubscribe"
  | "feedback-id"
  | "bulk-mail"
  | "discussion-list"
  | "many-recipients"
  | "undisclosed-recipients"

/** One email a sender sent the owner, as the store keeps it (`mailHeadersOf`, the mailboxes, the recipients). */
export interface SentMail {
  autoSubmitted: boolean
  nullReturnPath: boolean
  oneClick: boolean
  feedbackId: boolean
  /** In the bulk box: List-Id, List-Unsubscribe or `Precedence: bulk`. */
  bulk: boolean
  /** A List-Id at least `DISCUSSION_SENDERS` addresses send to. */
  discussionList: boolean
  /** To and Cc together; `null` when the store holds no recipients for it (mail recorded as an envelope). */
  recipients: number | null
}

/** A list three people write to is a discussion; one sender, even under `+tag` addresses, is a newsletter. */
export const DISCUSSION_SENDERS = 3

const reachOfOne = (mail: SentMail): { reach: Reach; signal?: SenderSignal } => {
  if (mail.discussionList) return { reach: "group", signal: "discussion-list" }
  if (mail.oneClick) return { reach: "broadcast", signal: "one-click-unsubscribe" }
  if (mail.feedbackId) return { reach: "broadcast", signal: "feedback-id" }
  if (mail.bulk) return { reach: "broadcast", signal: "bulk-mail" }
  // The owner missing from a To or Cc that names others proves nothing: an alias the store does not know looks so.
  if (mail.recipients === 0) return { reach: "broadcast", signal: "undisclosed-recipients" }
  if (mail.recipients !== null && mail.recipients > SMALL_GROUP_MEMBERS)
    return { reach: "group", signal: "many-recipients" }
  return { reach: "direct" }
}

/** More than half of their mail: one misfiled letter decides nothing. */
const most = (mail: readonly SentMail[], holds: (one: SentMail) => boolean) =>
  mail.filter(holds).length * 2 > mail.length

/**
 * A sender's signals and reach, worked out from their mail alone. Reach is the one most of their mail reached the
 * owner by, the wider on a tie. Mail the owner wrote them, or a private chat both wrote in, makes it `direct`
 * whatever their other mail shows; with no mail, a one-to-one chat or a small group does. `null`: nothing says.
 */
export const senderSignalsOf = (
  mail: readonly SentMail[],
  { addresses, ownerWrote, chatted }: { addresses: readonly string[]; ownerWrote: boolean; chatted: boolean },
): { signals: SenderSignal[]; reach: Reach | null } => {
  const signals = new Set<SenderSignal>()
  if (mail.length > 0 && most(mail, (one) => one.autoSubmitted)) signals.add("auto-submitted")
  if (mail.length > 0 && most(mail, (one) => one.nullReturnPath)) signals.add("null-return-path")
  if (addresses.some(isNoReplyAddress)) signals.add("no-reply")
  const votes = new Map<Reach, number>()
  for (const one of mail) {
    const { reach, signal } = reachOfOne(one)
    votes.set(reach, (votes.get(reach) ?? 0) + 1)
    if (signal !== undefined) signals.add(signal)
  }
  const voted = [...REACHES].reverse().reduce<Reach | null>((best, reach) => {
    const n = votes.get(reach) ?? 0
    return n > 0 && (best === null || n > (votes.get(best) ?? 0)) ? reach : best
  }, null)
  const reach = ownerWrote ? "direct" : (voted ?? (chatted ? "direct" : null))
  return { signals: [...signals], reach }
}

const LIST_ID = "coalesce(json_extract(e.headers, '$.\"list-id\"'), json_extract(e.metadata, '$.listId'))"

/** `bob+news@x` and `bob@x` are one sender. */
const senderKey = (address: string) => address.toLowerCase().replace(/\+[^@]*@/, "@")

/**
 * The mail each of these people sent the owner, as `senderSignalsOf` reads it. Asked for a page of people only: it
 * reads every stored email's List-Id once to tell a discussion list from a newsletter.
 */
export const sentMailOf = (database: CacheDatabase, people: readonly number[]): Map<number, SentMail[]> => {
  const found = new Map<number, SentMail[]>()
  if (people.length === 0) return found
  const rows = database
    .prepare(
      "SELECT l.person_id AS person, " +
        `${LIST_ID} AS list, json_extract(e.headers, '$."auto-submitted"') IS NOT NULL AS auto, ` +
        "json_extract(e.headers, '$.\"null-return-path\"') IS 1 AS null_return, " +
        "json_extract(e.headers, '$.\"list-unsubscribe-post\"') IS 1 AS one_click, " +
        "json_extract(e.headers, '$.\"feedback-id\"') IS 1 AS feedback, " +
        "EXISTS (SELECT 1 FROM email_mailboxes m JOIN mailboxes b ON b.id = m.mailbox_id " +
        "WHERE m.email_id = e.id AND b.kind = 'bulk') AS bulk, " +
        "CASE WHEN json_extract(e.metadata, '$.rule') IS NOT NULL THEN NULL ELSE " +
        "(SELECT count(*) FROM email_recipients r WHERE r.email_id = e.id AND r.role IN ('to', 'cc')) END AS recipients " +
        "FROM emails e JOIN identity_links l ON l.identity_id = e.from_identity_id " +
        "WHERE e.outgoing IS NOT 1 AND e.deleted_at IS NULL AND l.person_id IN (SELECT value FROM json_each(?))",
    )
    .all(JSON.stringify(people))
  const lists = [...new Set(rows.flatMap((row) => (typeof row.list === "string" ? [row.list] : [])))]
  const senders = new Map<string, Set<string>>()
  if (lists.length > 0)
    for (const row of database
      .prepare(
        `SELECT DISTINCT ${LIST_ID} AS list, e.from_address AS address FROM emails e ` +
          `WHERE e.from_address IS NOT NULL AND ${LIST_ID} IN (SELECT value FROM json_each(?))`,
      )
      .all(JSON.stringify(lists))) {
      const list = String(row.list)
      const held = senders.get(list) ?? new Set<string>()
      held.add(senderKey(String(row.address)))
      senders.set(list, held)
    }
  for (const row of rows) {
    const person = Number(row.person)
    const held = found.get(person) ?? []
    held.push({
      autoSubmitted: Number(row.auto) === 1,
      nullReturnPath: Number(row.null_return) === 1,
      oneClick: Number(row.one_click) === 1,
      feedbackId: Number(row.feedback) === 1,
      bulk: Number(row.bulk) === 1,
      discussionList: typeof row.list === "string" && (senders.get(row.list)?.size ?? 0) >= DISCUSSION_SENDERS,
      recipients: row.recipients == null ? null : Number(row.recipients),
    })
    found.set(person, held)
  }
  return found
}
