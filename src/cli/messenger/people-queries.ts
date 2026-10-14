import type { QueryRegistry } from "@wirecat/cli-base/query"
import { queryFieldsOf } from "@wirecat/cli-base/query"
import { contact, pollVote } from "../../entities/index.js"

/** The store matches `name:` against the name, the local alias and the @username at once; nothing else is filtered. */
export const CONTACTS_QUERY: QueryRegistry = {
  entity: "contact",
  backend: "native",
  fields: queryFieldsOf(contact, { native: ["name"], text: ["name"], examples: { name: "name:ana*" } }),
}

/** The messenger keeps the voters of one answer; one answer id at a time. */
export const VOTERS_QUERY: QueryRegistry = {
  entity: "poll_vote",
  backend: "native",
  fields: queryFieldsOf(pollVote, { native: ["answers"], examples: { answers: "answers:0" } }),
}
