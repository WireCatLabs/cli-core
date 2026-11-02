import type { NewestEmail } from "../store/store.js"

/** Whose turn a thread is: the owner owes an answer, waits for one, or neither. */
export type MailTurn = "owed" | "waiting" | null

/** Mail meant for the owner as a person: not sent to many, not a list, not a recorded envelope, not a suspect sender. */
export const isPersonal = (email: NewestEmail): boolean =>
  !email.bulk && !email.list && !email.envelope && !email.demoted

/**
 * **The one place that says what the owner owes in mail** (`review --unanswered`, `--waiting`, `tasks agenda`).
 * Owed: the newest email came in, names the owner in To, and is personal mail (`isPersonal`). No question
 * detection: a direct personal email is owed an answer or a decision. Waiting: the owner wrote last. Mail answered
 * from another client counts, since its copy in Sent or All Mail is synced.
 */
export const mailTurn = (newest: NewestEmail | null): MailTurn => {
  if (newest === null) return null
  if (newest.outgoing) return "waiting"
  return newest.toOwner && isPersonal(newest) ? "owed" : null
}
