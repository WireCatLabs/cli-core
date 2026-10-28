import type { EmailFacts } from "../store/index.js"
import { BULK } from "./bulk.js"
import { ENVELOPE } from "./rules.js"
import type { Listed } from "./source.js"

export type StoredMail = Listed & { envelope: boolean }

/** A stored email in the shape a Gmail listing has; it has no UID until Gmail is asked. */
export const listedOf = (email: EmailFacts): StoredMail => {
  const labels = email.mailboxes.filter(({ kind }) => kind === "label").map(({ name }) => name)
  if (email.flagged && !labels.includes("Starred")) labels.push("Starred")
  return {
    uid: "",
    messageId: email.externalId,
    threadId: "",
    receivedAt: new Date(email.receivedAt ?? 0).toISOString(),
    labels: labels.sort(),
    seen: email.read,
    flagged: email.flagged,
    ...(email.size === null ? {} : { size: email.size }),
    headers: {
      ...(email.fromAddress === null ? {} : { from: email.fromAddress }),
      ...(email.fromName === null ? {} : { fromName: email.fromName }),
      ...(email.subject === null ? {} : { subject: email.subject }),
      ...(email.listId === null ? {} : { listId: email.listId }),
      to: email.recipients,
      bulk: email.mailboxes.some(({ kind }) => kind === BULK),
      ...(email.replyTo === null ? {} : { replyTo: email.replyTo }),
      ...(email.dkim === null && email.dmarc === null
        ? {}
        : {
            auth: {
              ...(email.dkim === null ? {} : { dkim: email.dkim }),
              ...(email.dmarc === null ? {} : { dmarc: email.dmarc }),
            },
          }),
    },
    envelope: email.mailboxes.some(({ kind }) => kind === ENVELOPE),
  }
}
