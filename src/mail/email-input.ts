import type { EmailInput } from "../store/index.js"
import { addressOf } from "./attachments.js"
import type { ParsedMail } from "./parse.js"
import type { Listed } from "./source.js"

/** The Date header, or the server's internal date when the header is missing or unreadable. */
export const sentAtOf = (date: string | null, receivedAt: string): number => {
  const sent = date === null ? Number.NaN : Date.parse(date)
  return Number.isNaN(sent) ? Date.parse(receivedAt) : sent
}

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
  sentAt: sentAtOf(mail.date, item.receivedAt),
  receivedAt: Date.parse(item.receivedAt),
  bodyText: mail.text || null,
  size: item.size ?? null,
  ...(Object.keys(header).length ? { headers: header } : {}),
  outgoing: mail.from === null ? null : mail.from.email === address,
})
