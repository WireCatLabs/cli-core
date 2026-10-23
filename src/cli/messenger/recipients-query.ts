import { type QueryRegistry, queryFieldsOf } from "@wirecat/cli-base/query"
import { recipient } from "../../entities/index.js"
import type { RecipientFilter } from "../../sends/recipients.js"
import { type QueryWords, queryTerms } from "../list-query.js"

export const RECIPIENTS_QUERY: QueryRegistry = {
  entity: "recipient",
  backend: "native",
  fields: queryFieldsOf(recipient, {
    native: ["id", "title"],
    examples: { id: "id:7", title: 'title:"Book club"' },
  }).map((field) =>
    field.native
      ? { ...field, operators: field.operators.filter((operator) => operator === "term" || operator === "phrase") }
      : field,
  ),
}

export const recipientFilter = (words: QueryWords): RecipientFilter => {
  const terms = queryTerms(words, RECIPIENTS_QUERY, "recipients list")
  const id = terms.get("id"),
    title = terms.get("title")
  return { ...(id === undefined ? {} : { id }), ...(title === undefined ? {} : { title }) }
}
