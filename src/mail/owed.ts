import type { NewestEmail } from "../store/store.js"

/** Whose turn a thread is: the owner owes an answer, waits for one, or neither. */
export type MailTurn = "owed" | "waiting" | null

/**
 * **The one place that says what the owner owes in mail** (`review --unanswered`, `--waiting`, `tasks agenda`).
 * Owed: the newest email came in and names the owner in To or Cc. Mail sent to many, lists and envelopes count too
 * (the owner's ruling: look at all mail); each item carries its marks instead, for the reader to sort. No question
 * detection. Waiting: the owner wrote last. Mail answered from another client counts, since its copy in Sent or All
 * Mail is synced.
 */
export const mailTurn = (newest: NewestEmail | null): MailTurn => {
  if (newest === null) return null
  if (newest.outgoing) return "waiting"
  return newest.addressed ? "owed" : null
}
