import { annotate } from "@wirecat/cli-base/commands"
import { Command } from "commander"
import type { AppIdentity } from "../../ports/app.js"
import { runsDirFor } from "../../runs/run.js"
import { environmentOf, outputFor } from "../context.js"
import { LOCAL_READ } from "../effects.js"
import { renderAnswer } from "../envelope.js"
import { typedQuery, withQuery } from "../list-query.js"
import { positiveCount } from "../paging.js"
import { runsFound, searchRuns } from "./search.js"
import { RUN_SEARCH_QUERY, runSearchFilter } from "./search-query.js"

/** Diagnostic files are independent of linked accounts and never start a recorded run themselves. */
export const runsSearchCommand = (app: AppIdentity): Command =>
  annotate(
    withQuery(
      new Command("runs")
        .summary("search recorded diagnostic metadata and events")
        .description(
          "search recorded diagnostic metadata and events; literal words and field:value terms joined by AND; no message contents",
        )
        .option("--since-time <time>", "runs starting on or after an ISO time or 2h / 1d ago")
        .option("--limit <n>", "matches per page, at most 100", positiveCount("--limit"), 20)
        .option("--page <n>", "result page", positiveCount("--page"), 1),
      RUN_SEARCH_QUERY,
    ),
    {
      effects: LOCAL_READ,
      output: { entity: "run", view: "hit" },
      examples: [`${app.command} search runs timeout status:failed --limit 10`],
    },
  ).action(function (this: Command, words: string[]) {
    const filter = runSearchFilter(words)
    const options = this.opts<{ sinceTime?: string; limit: number; page: number }>()
    const dir = runsDirFor(app, environmentOf(this).env ?? process.env)
    const found = searchRuns(dir, { ...filter, ...options, since: options.sinceTime })
    renderAnswer(this, outputFor(this), runsFound(found, { query: typedQuery(words), since_time: options.sinceTime }))
  })
