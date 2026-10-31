import { CliError } from "@wirecat/cli-base"
import { annotate } from "@wirecat/cli-base/commands"
import { Command } from "commander"
import type { AppIdentity } from "../../ports/app.js"
import { findRun, listRuns, readEvents, runsDirFor } from "../../runs/run.js"
import { environmentOf, outputFor } from "../context.js"
import { LOCAL_READ, NO_EFFECTS } from "../effects.js"
import { itemOf, listOf, renderAnswer, snakeKeys } from "../envelope.js"
import { typedQuery, withQuery } from "../list-query.js"
import { positiveCount } from "../paging.js"
import { lineOf } from "../steps.js"
import { RUNS_QUERY, runListFilter } from "./query.js"

/** Reading the log is not itself worth recording, so **nothing here starts a run**. */
export const runsCommand = (app: AppIdentity): Command => {
  const command = new Command("runs").description("recorded runs — what this tool did, and when")
  const dir = (from: Command) => runsDirFor(app, environmentOf(from).env ?? process.env)
  const runOrRefuse = (from: Command, id: string) => {
    const found = findRun(dir(from), id)
    if (!found) throw new CliError("not_found", `no recorded run "${id}" — \`${lineOf(from, "runs list")}\` shows them`)
    return found
  }

  withQuery(
    annotate(command.command("list"), {
      examples: [`${app.command} runs list --limit 10`],
      effects: LOCAL_READ,
    }),
    RUNS_QUERY,
  )
    .description("recorded runs, newest first")
    .option("--limit <n>", "how many to show", positiveCount("--limit"), 20)
    .option("--page <n>", "which page, starting at 1", positiveCount("--page"), 1)
    .action(function (this: Command, words: string[]) {
      const filter = runListFilter(words)
      const { limit, page } = this.opts<{ limit: number; page: number }>()
      const output = outputFor(this)
      const { renderer } = output
      const runs = listRuns(dir(this), { atLeast: page * limit + 1, filter })
      const shown = runs.slice((page - 1) * limit, page * limit)
      renderAnswer(
        this,
        output,
        listOf("runs list", {
          items: shown.map(snakeKeys),
          limit,
          page,
          has_more: runs.length > page * limit,
          args: words.length ? { query: typedQuery(words) } : {},
        }),
      )
      if (runs.length === 0)
        renderer.note(
          "nothing recorded — a command that does its work is kept unless the config says `record: false` (then only " +
            "failures) or it ran with `--no-record`",
        )
    })

  annotate(command.command("show"), {
    examples: [`${app.command} runs show run-101`],
    effects: LOCAL_READ,
    output: { entity: "run", view: "details" },
  })
    .argument("<run-id>", `an id from \`${app.command} runs list\``)
    .description("one run: what it was, how it ended, and every event it logged")
    .option("--problems", "only failed responses, warnings and crashes")
    .action(function (this: Command, id: string) {
      const output = outputFor(this)
      const { renderer } = output
      const found = runOrRefuse(this, id)
      const events = readEvents(found.dir).map(readable)
      const { problems } = this.opts<{ problems?: boolean }>()
      const shown = problems ? events.filter(notable) : events
      // Events are log records as written; only the run's own fields are renamed here.
      renderAnswer(
        this,
        output,
        itemOf({
          ...(snakeKeys(found.metadata) as object),
          directory: found.dir,
          event_count: events.length,
          events: shown,
        }),
      )
      if (shown.length < events.length)
        renderer.note(
          `${events.length - shown.length} other events — \`${lineOf(this, `runs show ${id}`)}\` shows them all`,
        )
    })

  annotate(command.command("path"), {
    examples: [`${app.command} runs path run-101`],
    effects: NO_EFFECTS,
    output: { entity: "run_location" },
  })
    .argument("<run-id>", `an id from \`${app.command} runs list\``)
    .description("the directory holding one run")
    .action(function (this: Command, id: string) {
      renderAnswer(this, outputFor(this), itemOf({ path: runOrRefuse(this, id).dir }))
    })

  return command
}

/** What went wrong, and nothing that went right. */
const notable = (event: Record<string, unknown>): boolean =>
  event.outcome === "error" || event.event === "client.warning" || event.event === "command.crashed"

/** Drops what the logger puts on every line and `show` already prints once above the events. */
const readable = ({ level, run_id, runId, command, profile, ...event }: Record<string, unknown>) => event
