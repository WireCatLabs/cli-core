import type { DeclaredSetting } from "../../cli/setting-defaults.js"
import {
  BULK_TRIAGE_DEFAULTS,
  type BulkTriage,
  NEWSLETTER_DEFAULTS,
  NEWSLETTER_SENDERS,
  NEWSLETTER_WORDS,
  ORDER_WORDS,
} from "../newsletter.js"

const listed = (words: readonly string[]) => words.join(", ")

/** The bulk-mail settings a host that mounts `review --holder` writes into its config file's top level (WC-CMD-30). */
export const MAIL_BULK_SETTINGS: readonly DeclaredSetting[] = [
  {
    key: "mail_bulk_excerpts",
    default: BULK_TRIAGE_DEFAULTS.excerpts,
    description:
      "review --holder gives an agent bulk mail that is not surely a newsletter as its subject and first lines; " +
      "false leaves all bulk mail out",
  },
  {
    key: "mail_bulk_excerpts_per_read",
    default: BULK_TRIAGE_DEFAULTS.perRead,
    description: "the most bulk excerpts one review --holder gives; the rest come with the next read",
  },
  {
    key: "mail_bulk_excerpt_chars",
    default: NEWSLETTER_DEFAULTS.excerptChars,
    description: "how many characters of a bulk email's own text an excerpt shows",
  },
  {
    key: "mail_bulk_newsletter_score",
    default: NEWSLETTER_DEFAULTS.threshold,
    description:
      "bulk mail scoring this or more is left out as a newsletter: a newsletter word counts 2 in the subject, 1 in " +
      "the first lines, a newsletter's address 2, an emoji in the subject 1, an unsubscribe link at the top 1, " +
      "an order word in the first lines -2",
  },
  {
    key: "mail_bulk_newsletter_words",
    default: listed(NEWSLETTER_WORDS),
    description: "comma-separated words that say advertising; each matches at the start of a word, any case",
  },
  {
    key: "mail_bulk_newsletter_senders",
    default: listed(NEWSLETTER_SENDERS),
    description: "comma-separated parts of a sender's address (news, digest) or domains (substack.com) of newsletters",
  },
  {
    key: "mail_bulk_order_words",
    default: listed(ORDER_WORDS),
    description:
      "comma-separated words of orders, invoices and requests: one in the subject keeps a bulk email for the agent",
  },
]

const wordsOf = (value: unknown): string[] | undefined =>
  typeof value === "string"
    ? value
        .split(",")
        .map((word) => word.trim())
        .filter(Boolean)
    : undefined

const countOf = (value: unknown, least: number): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= least ? value : undefined

/** `MAIL_BULK_SETTINGS` as the config file gives them; a missing or unusable value is left to the default. */
export const bulkTriageOf = (config: Record<string, unknown>): BulkTriage => {
  const { cues } = BULK_TRIAGE_DEFAULTS
  return {
    excerpts:
      typeof config.mail_bulk_excerpts === "boolean" ? config.mail_bulk_excerpts : BULK_TRIAGE_DEFAULTS.excerpts,
    perRead: countOf(config.mail_bulk_excerpts_per_read, 1) ?? BULK_TRIAGE_DEFAULTS.perRead,
    cues: {
      threshold: countOf(config.mail_bulk_newsletter_score, 1) ?? cues.threshold,
      excerptChars: countOf(config.mail_bulk_excerpt_chars, 40) ?? cues.excerptChars,
      newsletterWords: wordsOf(config.mail_bulk_newsletter_words) ?? cues.newsletterWords,
      newsletterSenders: wordsOf(config.mail_bulk_newsletter_senders) ?? cues.newsletterSenders,
      orderWords: wordsOf(config.mail_bulk_order_words) ?? cues.orderWords,
    },
  }
}
