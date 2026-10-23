import { CliError } from "@wirecat/cli-base"
import { annotate } from "@wirecat/cli-base/commands"
import { Command, Option } from "commander"
import type { AppIdentity } from "../../ports/app.js"
import { findRun, listRuns, readEvents, runsDirFor } from "../../runs/run.js"
import { environmentOf, outputFor } from "../context.js"
import { LOCAL_READ, NO_EFFECTS } from "../effects.js"
import { itemOf, listOf, renderAnswer, snakeKeys } from "../envelope.js"
import { positiveCount } from "../paging.js"
import { lineOf } from "../steps.js"
import { type RunSearch, runsFound, searchRuns } from "./search.js"

/** Reading the log is not itself worth recording, so **nothing here starts a run**. */
export const runsCommand = (app: AppIdentity): Command => {
  const command = new Command("runs").description("recorded runs — what this tool did, and when")
  const dir = (from: Command) => runsDirFor(app, environmentOf(from).env ?? process.env)
  const runOrRefuse = (from: Command, id: string) => {
    const found = findRun(dir(from), id)
    if (!found) throw new CliError("not_found", `no recorded run "${id}" — \`${lineOf(from, "runs list")}\` shows them`)
    return found
  }

  annotate(command.command("list"), {
    effects: LOCAL_READ,
    examples: [`${app.command} runs list --limit 10`],
  })
    .description("recorded runs, newest first")
    .option("--limit <n>", "how many to show", positiveCount("--limit"), 20)
    .option("--page <n>", "which page, starting at 1", positiveCount("--page"), 1)
    .action(function (this: Command) {
      const { limit, page } = this.opts<{ limit: number; page: number }>()
      const output = outputFor(this)
      const { renderer } = output
      const runs = listRuns(dir(this), { atLeast: page * limit + 1 })
      const shown = runs.slice((page - 1) * limit, page * limit)
      renderAnswer(
        this,
        output,
        listOf("runs list", { items: shown.map(snakeKeys), limit, page, has_more: runs.length > page * limit }),
      )
      if (runs.length === 0) renderer.note("nothing recorded — a run is kept with `--record`, or when it fails")
    })

  annotate(command.command("show"), { effects: LOCAL_READ, examples: [`${app.command} runs show run-101`] })
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

  annotate(command.command("search"), {
    effects: LOCAL_READ,
    examples: [`${app.command} runs search timeout --limit 10`],
  })
    .description("search recorded diagnostic metadata and events; no message contents")
    .argument("[query]", "case-insensitive literal diagnostic text")
    .addOption(new Option("--status <status>", "run outcome").choices(["success", "failed", "partial", "running"]))
    .option("--error-code <code>", "one stable error code")
    .option("--operation <name>", "one operation, such as messages.download")
    .option("--profile <name>", "one recorded profile")
    .option("--since-time <time>", "runs starting on or after an ISO time or 2h / 1d ago")
    .option("--limit <n>", "matches per page, at most 100", positiveCount("--limit"), 20)
    .option("--page <n>", "result page", positiveCount("--page"), 1)
    .action(function (this: Command, query?: string) {
      const options = this.opts<{
        status?: RunSearch["status"]
        errorCode?: string
        operation?: string
        profile?: string
        sinceTime?: string
        limit: number
        page: number
      }>()
      const found = searchRuns(dir(this), {
        ...options,
        since: options.sinceTime,
        ...(query === undefined ? {} : { query }),
      })
      renderAnswer(
        this,
        outputFor(this),
        runsFound(found, {
          query,
          status: options.status,
          error_code: options.errorCode,
          operation: options.operation,
          profile: options.profile,
          since_time: options.sinceTime,
        }),
      )
    })

  annotate(command.command("path"), { effects: NO_EFFECTS, examples: [`${app.command} runs path run-101`] })
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
