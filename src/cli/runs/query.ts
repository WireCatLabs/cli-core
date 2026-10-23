import { type QueryRegistry, queryFieldsOf } from "@wirecat/cli-base/query"
import { recordedRun } from "../../entities/index.js"
import type { RunListFilter } from "../../runs/run.js"
import { type QueryWords, queryTerms } from "../list-query.js"

export const RUNS_QUERY: QueryRegistry = {
  entity: "run",
  backend: "native",
  fields: queryFieldsOf(recordedRun, {
    native: ["run_id", "command", "profile", "status", "error_code"],
    examples: {
      command: 'command:"messages send"',
      profile: "profile:work",
      status: "status:failed",
      error_code: "error_code:timeout",
    },
  }).map((field) =>
    field.native
      ? {
          ...field,
          operators: field.operators.filter((operator) => operator === "term" || operator === "phrase"),
        }
      : field,
  ),
}

export const runListFilter = (words: QueryWords): RunListFilter => {
  const terms = queryTerms(words, RUNS_QUERY, "runs list")
  const status = recordedRun.entries.status.options.find((value) => value === terms.get("status"))
  return {
    ...(terms.has("run_id") ? { runId: terms.get("run_id") } : {}),
    ...(terms.has("command") ? { command: terms.get("command") } : {}),
    ...(terms.has("profile") ? { profile: terms.get("profile") } : {}),
    ...(status === undefined ? {} : { status }),
    ...(terms.has("error_code") ? { errorCode: terms.get("error_code") } : {}),
  }
}
