import { CliError } from "@wirecat/cli-base"
import { annotate, sharedCommand } from "@wirecat/cli-base/commands"
import type { Command } from "commander"
import type { Deadline, RunBudget } from "../../background/budget.js"
import { environmentOf, runBudgetOf } from "../context.js"
import { honoursDryRun } from "../dry-run-guard.js"
import { FETCH, LOCAL_READ } from "../effects.js"
import { type Body, itemOf } from "../envelope.js"
import { type DocumentWords, examples, positive, wordsOf } from "./words.js"

export interface DocumentSyncArgs {
  limit: number
  rescan?: boolean
  /** Also index pending text for meaning search, with a model already downloaded. */
  embed?: boolean
  /** Sized to the run's deadline; pass it to `syncDocuments` so a sync stops in time and says how to go on. */
  budget?: RunBudget
  /** The run's hard limit; pass it to `syncDocuments` so its last step, the word index, ends before it. */
  deadline?: Deadline
}

export interface DocumentSyncAnswer {
  errors: unknown[]
  pending: number
  /** `false` while the pass is unfinished: a folder walk or operations are left for the next sync. */
  complete?: boolean
  walk?: { folders_left: number; listed: number }
  saved?: number
  names_only?: number
  removed?: number
  unchanged?: number
}

export interface DocumentSyncCommands {
  words: DocumentWords
  output(body: Body): void
  /** Writes a line for the person, not the answer. */
  diagnostic(text: string): void
  /** The selected profile, as `sync again` names it. */
  profile(): string
  /** The entries one sync walks under the chosen folders before it stops and saves, as `sync --help` says. */
  maxEntries: number
  /**
   * Syncs the selected profile into the shared store under the lock the CLI's writes take. `errors` are the failed
   * operations still pending; `pending` counts every operation left for the next sync.
   */
  sync(args: DocumentSyncArgs): Promise<DocumentSyncAnswer>
  /** What `status` answers: the last sync, imported documents and pending work, from local files only. */
  status(): object | Promise<object>
}

const addDocumentSyncCommandsDefinition = (program: Command, helpers: DocumentSyncCommands) => {
  const { output } = helpers
  const wording = wordsOf(helpers.words)
  const { prefix, text } = wording
  const sync = examples(
    // Cooperative: it stops on its own at its budget, its deadline or a cancel and keeps its work, so it gets a sync's
    // deadline (15 min in a terminal, 45 s over MCP) instead of a one-shot's 30 s.
    annotate(program.command("sync"), { effects: FETCH, cooperative: true, partial: true })
      .summary("import what changed in the chosen folders, and finish an unfinished sync")
      .description(
        "import what changed in the chosen folders, and finish an unfinished sync; " +
          `one sync walks about ${helpers.maxEntries} entries under the chosen folders, saves where it stopped, and ` +
          "the next sync goes on from there",
      ),
    [`${prefix} sync`, `${prefix} sync --rescan --limit 500`],
  )
    .option("--limit <n>", text.syncLimit, positive, 200)
    .option(
      "--rescan",
      "read every chosen folder again instead of only what changed; each --rescan starts the walk over, so run it " +
        "once and continue with a plain sync",
    )
    .option("--embed", "also index pending text for meaning search, with a model already downloaded")
    .action(async (args: DocumentSyncArgs, command: Command) => {
      const deadline = environmentOf(command).deadline?.()
      const result = await helpers.sync({ ...args, budget: runBudgetOf(command), ...(deadline ? { deadline } : {}) })
      const unfinished = result.complete === false || result.pending > 0
      const moved =
        (result.walk?.listed ?? 0) > 0 ||
        [result.saved, result.names_only, result.removed, result.unchanged].some((count) => (count ?? 0) > 0)
      const again = `${wording.app} ${helpers.profile()} sync`
      const timeout = command.optsWithGlobals<{ timeout?: string }>().timeout
      // The same sync again, never --rescan, which would start the pass over; a run that moved nothing gets no step.
      const next =
        unfinished && !result.errors.length && moved
          ? [
              {
                kind: "command" as const,
                step: "sync.run",
                command: "sync",
                args: {
                  limit: args.limit,
                  ...(timeout === undefined ? {} : { timeout }),
                  ...(args.embed ? { embed: true } : {}),
                },
                why: "the sync stopped before the end of its pass; running it again goes on from there",
                safe_to_auto_execute: true,
              },
            ]
          : []
      output(
        itemOf(result, {
          meta: result.errors.length
            ? {
                complete: false,
                issues: [{ code: "provider_error" as const, reason: "sync.partial", source: wording.source }],
              }
            : unfinished
              ? { complete: false }
              : {},
          next,
        }),
      )
      if (result.walk) helpers.diagnostic(`${result.walk.folders_left} folders remain to list; run ${again} again\n`)
      else if (result.errors.length || result.pending)
        helpers.diagnostic(`${result.pending} source operations remain; run ${again} again\n`)
      if (result.errors.length)
        throw new CliError("provider_error", "sync completed partially; failed operations remain pending", {
          reason: "sync.partial",
        })
    })
  const status = examples(
    annotate(program.command("status"), { effects: LOCAL_READ }).description(
      "show the last sync, imported documents and pending work",
    ),
    [`${prefix} status`],
  ).action(async () => {
    output(itemOf(await helpers.status()))
  })
  return [sync, status]
}

/** `sync` into the shared store and `status` of the local copy, for the selected profile. */
export const addDocumentSyncCommands = honoursDryRun(sharedCommand(addDocumentSyncCommandsDefinition))
