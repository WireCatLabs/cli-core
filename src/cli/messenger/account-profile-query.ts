import { type QueryRegistry, queryFieldsOf } from "@wirecat/cli-base/query"
import { accountProfile } from "../../entities/index.js"

export const ACCOUNT_PROFILES_QUERY: QueryRegistry = {
  entity: "account_profile",
  backend: "native",
  fields: queryFieldsOf(accountProfile, {
    native: ["profile", "current"],
    examples: { profile: "profile:work", current: "current:true" },
  }).map((field) => ({
    ...field,
    operators: field.operators.filter((operator) => operator === "term" || operator === "phrase"),
  })),
}
