import { CliError } from "@wirecat/cli-base"
import { type Predicate, type QueryRegistry, queryError, queryFieldsOf } from "@wirecat/cli-base/query"
import { contact, pollVote, reaction } from "../../entities/index.js"
import { levelFor } from "../../sends/permissions.js"

const notesText = (node: Predicate) => {
  if (/[*?]/.test(node.value.replace(/^\*+|\*+$/g, "")))
    queryError(
      "query.unsupported-operator",
      node.span,
      'notes: matches text in a note: notes:valencia or notes:"met in"',
    )
}

/**
 * The store matches `name:` against the name, the local alias and the @username at once, and `notes:` against
 * the owner's private notes about them; nothing else is filtered.
 */
export const CONTACTS_QUERY: QueryRegistry = {
  entity: "contact",
  backend: "native",
  fields: queryFieldsOf(contact, {
    native: ["name", "notes"],
    text: ["name"],
    relations: {
      notes: { type: "txt", example: "notes:valencia", relation: "text in one of your private notes about them" },
    },
    examples: { name: "name:ana*" },
    validate: { notes: notesText },
  }),
}

/** Reading notes by their text is reading them: `contacts.notes.list` gates `notes:` as it gates `--with-notes`. */
export const notesAllowed = (permissions: Parameters<typeof levelFor>[0], notes: Predicate | undefined) => {
  if (notes && levelFor(permissions, "contacts.notes.list").level === "deny")
    throw new CliError("permission_error", "profile denies contacts.notes.list")
}

/** The messenger keeps the voters of one answer; one answer id at a time. */
export const VOTERS_QUERY: QueryRegistry = {
  entity: "poll_vote",
  backend: "native",
  fields: queryFieldsOf(pollVote, { native: ["answers"], examples: { answers: "answers:0" } }),
}

/** Telegram keeps the people who chose one reaction; one emoji at a time. */
export const REACTORS_QUERY: QueryRegistry = {
  entity: "reaction",
  backend: "native",
  fields: queryFieldsOf(reaction, { native: ["reaction"], examples: { reaction: "reaction:🔥" } }),
}
