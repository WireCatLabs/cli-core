import { type QueryRegistry, queryFieldsOf } from "@wirecat/cli-base/query"
import { sendAttempt } from "../../entities/index.js"
import type { SendFilter } from "../../sends/journal.js"
import { type QueryWords, queryTerms } from "../list-query.js"

export const SENDS_QUERY: QueryRegistry = {
  entity: "send_attempt",
  backend: "native",
  fields: queryFieldsOf(sendAttempt, {
    native: ["outcome", "chat_id", "operation_id", "error_code", "key"],
    examples: {
      outcome: "outcome:failed",
      chat_id: "chat_id:7",
      operation_id: "operation_id:op-1",
      error_code: "error_code:timeout",
      key: "key:messages.send",
    },
  }).map((field) =>
    field.native
      ? { ...field, operators: field.operators.filter((operator) => operator === "term" || operator === "phrase") }
      : field,
  ),
}

export const sendFilter = (words: QueryWords, command = "sends list"): SendFilter | undefined => {
  const terms = queryTerms(words, SENDS_QUERY, command)
  if (terms.size === 0) return undefined
  const outcome = sendAttempt.entries.outcome.options.find((value) => value === terms.get("outcome"))
  const chatId = terms.get("chat_id"),
    operationId = terms.get("operation_id"),
    errorCode = terms.get("error_code"),
    key = terms.get("key")
  return {
    ...(outcome === undefined ? {} : { outcome }),
    ...(chatId === undefined ? {} : { chatId }),
    ...(operationId === undefined ? {} : { operationId }),
    ...(errorCode === undefined ? {} : { errorCode }),
    ...(key === undefined ? {} : { key }),
  }
}
