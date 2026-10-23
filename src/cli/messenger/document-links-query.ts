import { type QueryRegistry, queryFieldsOf } from "@wirecat/cli-base/query"
import { documentLink } from "../../entities/index.js"

export const DOCUMENT_LINKS_QUERY: QueryRegistry = {
  entity: "document_link",
  backend: "native",
  fields: queryFieldsOf(documentLink, { native: ["ref"], examples: { ref: 'ref:"msg:chat/500/7/1"' } }).map((field) =>
    field.native
      ? { ...field, operators: field.operators.filter((operator) => operator === "term" || operator === "phrase") }
      : field,
  ),
}
