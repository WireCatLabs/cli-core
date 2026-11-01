import type { EmailInput } from "../store/index.js"
import { addressOf } from "./attachments.js"
import type { ParsedMail } from "./parse.js"
import type { Listed } from "./source.js"

/** What one read email stores of itself, whichever run read it; where it is filed is the caller's. */
export const parsedEmail = (
  mail: ParsedMail,
  item: Listed,
  header: Record<string, string | boolean>,
  address: string,
): Omit<EmailInput, "mailboxes"> => ({
  externalId: item.messageId,
  subject: mail.subject,
  from: mail.from === null ? null : addressOf(mail.from),
  to: mail.to.map(addressOf),
  cc: mail.cc.map(addressOf),
  bcc: mail.bcc.map(addressOf),
  sentAt: null,
  receivedAt: Date.parse(item.receivedAt),
  bodyText: mail.text || null,
  size: item.size ?? null,
  ...(Object.keys(header).length ? { headers: header } : {}),
  outgoing: mail.from === null ? null : mail.from.email === address,
})
