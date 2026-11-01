import { createHash } from "node:crypto"
import { field, unfold } from "./headers.js"

export interface MailIdsInput {
  /** As the server's envelope gives it; read from `head` when absent. */
  messageId?: string | undefined
  /** Header text holding at least References and In-Reply-To. */
  head: string
  folder: string
  validity: string
  uid: string
}

const digest = (id: string) => `imap:${createHash("sha256").update(id).digest("hex")}`

const firstId = (value: string | undefined) => /<[^<>\s]+>/.exec(value ?? "")?.[0]

/**
 * The ids of an email on any server but Gmail, whose X-GM-MSGID and X-GM-THRID are used as they are. OBJECTID's
 * EMAILID is not used: mail and memo must give one email one id, and a server that turns OBJECTID on later must not
 * store its mail again. The Message-ID is the identity; without one, the UID, which means nothing without
 * UIDVALIDITY. The thread is the first Message-ID of References, the thread's first email (RFC 5322 §3.6.4), else
 * In-Reply-To's parent, so a server without thread ids (Yandex, Mail.ru) still keeps a conversation together.
 */
export const mailIds = ({ messageId, head, folder, validity, uid }: MailIdsInput) => {
  const unfolded = unfold(head)
  const identity = (messageId ?? field(unfolded, "message-id"))?.trim() || `uid:${folder}:${validity}:${uid}`
  const root = firstId(field(unfolded, "references")) ?? firstId(field(unfolded, "in-reply-to"))
  return { messageId: digest(identity), threadId: digest(root ?? identity) }
}
