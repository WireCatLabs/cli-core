import { type QueryRegistry, queryFieldsOf } from "@wirecat/cli-base/query"
import type { Schedule } from "../../background/schedules.js"
import { scheduledJob, topic } from "../../entities/index.js"
import { type QueryWords, queryTerms } from "../list-query.js"

const termsOnly = (registry: QueryRegistry): QueryRegistry => ({
  ...registry,
  fields: registry.fields.map((field) =>
    field.native
      ? { ...field, operators: field.operators.filter((operator) => operator === "term" || operator === "phrase") }
      : field,
  ),
})
export const SCHEDULES_QUERY = termsOnly({
  entity: "scheduled_job",
  backend: "native",
  fields: queryFieldsOf(scheduledJob, {
    native: ["name", "kind"],
    examples: { name: "name:daily", kind: "kind:command" },
  }),
})
export const scheduleFilter = (words: QueryWords): Partial<Pick<Schedule, "name" | "kind">> => {
  const terms = queryTerms(words, SCHEDULES_QUERY, "schedule list")
  const name = terms.get("name"),
    kind = terms.get("kind")
  return { ...(name === undefined ? {} : { name }), ...(kind === "agent" || kind === "command" ? { kind } : {}) }
}
export const TOPICS_QUERY = termsOnly({
  entity: "topic",
  backend: "native",
  fields: queryFieldsOf(topic, { native: ["title"], examples: { title: 'title:"Book club"' } }),
})
export const topicTitle = (words: QueryWords) => queryTerms(words, TOPICS_QUERY, "topics list").get("title")
