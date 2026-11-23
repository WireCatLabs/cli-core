import { CliError } from "@wirecat/cli-base"
import { annotate, sharedCommand } from "@wirecat/cli-base/commands"
import type { NextStep } from "@wirecat/cli-base/standards"
import type { Command } from "commander"
import type { Deadline, RunBudget } from "../../background/budget.js"
import { environmentOf, runBudgetOf } from "../context.js"
import { honoursDryRun } from "../dry-run-guard.js"
import { FETCH, LOCAL_READ } from "../effects.js"
import { type Body, itemOf } from "../envelope.js"
import { type DocumentWords, examples, positive, wordsOf } from "./words.js"

/** The documents one sync reads when `--limit` does not say. */
export const DOCUMENT_SYNC_LIMIT = 200

export interface DocumentSyncArgs {
  limit: number
  rescan?: boolean
  /** Also index pending text for meaning search, with a model already downloaded. */
  embed?: boolean
  /** Sized to the run's deadline; pass it to `syncDocuments` so a sync stops in time and says how to go on. */
  budget?: RunBudget
  /** The run's hard limit; pass it to `syncDocuments`, and to `embedNotes` for `--embed`, so both end before it. */
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
  /** What `--embed` did, as `embedNotes` answers it, or what the CLI says instead. */
  embeddings?: unknown
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

/** `embedNotes`' answer says enrichment never had the time to send a batch. */
const enrichmentOutOfTime = (embeddings: unknown): boolean => {
  const enrichment =
    typeof embeddings === "object" && embeddings !== null && "enrichment" in embeddings
      ? (embeddings.enrichment as { reason_id?: unknown; enriched?: unknown } | undefined)
      : undefined
  return enrichment?.reason_id === "enrichment.deadline" && enrichment.enriched === 0
}

/** What a documents sync's answer tells its caller: the envelope's meta, the steps to go on and the lines for the person. */
export interface DocumentSyncPart {
  meta: { complete?: false; issues?: { code: "provider_error"; reason: "sync.partial"; source: string }[] }
  next: NextStep[]
  diagnostics: string[]
}

/**
 * `resume` and `longer` are the arguments of the same sync again and of a longer one, beside the ones each adds:
 * a CLI whose `sync` takes other options than the shared one names its own.
 */
export const documentSyncPart = (
  result: DocumentSyncAnswer,
  words: { again: string; source: string; resume: Record<string, unknown>; longer: Record<string, unknown> },
): DocumentSyncPart => {
  const unfinished = result.complete === false || result.pending > 0
  const moved =
    (result.walk?.listed ?? 0) > 0 ||
    [result.saved, result.names_only, result.removed, result.unchanged].some((count) => (count ?? 0) > 0)
  // The same sync again, never --rescan, which would start the pass over; a run that moved nothing gets no step.
  const resume: NextStep[] =
    unfinished && !result.errors.length && moved
      ? [
          {
            kind: "command",
            step: "sync.run",
            command: "sync",
            args: words.resume,
            why: "the sync stopped before the end of its pass; running it again goes on from there",
            safe_to_auto_execute: true,
          },
        ]
      : []
  // Enrichment starts a batch only when it ends before the deadline; one that never had the time would not move in
  // a run like this one either, so the step asks for a longer run and is not run unasked.
  const longer: NextStep[] = enrichmentOutOfTime(result.embeddings)
    ? [
        {
          kind: "command",
          step: "sync.longer",
          command: "sync",
          args: { ...words.longer, embed: true, timeout: "15m" },
          why:
            "enrichment needs more time than this run had left, so it sent nothing; run this in a terminal, " +
            "where a sync may take 15 minutes",
          safe_to_auto_execute: false,
        },
      ]
    : []
  const diagnostics = result.walk
    ? [`${result.walk.folders_left} folders remain to list; run ${words.again} again\n`]
    : result.errors.length || result.pending
      ? [`${result.pending} source operations remain; run ${words.again} again\n`]
      : []
  return {
    meta: result.errors.length
      ? { complete: false, issues: [{ code: "provider_error", reason: "sync.partial", source: words.source }] }
      : unfinished
        ? { complete: false }
        : {},
    next: [...resume, ...longer],
    diagnostics,
  }
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
    .option("--limit <n>", text.syncLimit, positive, DOCUMENT_SYNC_LIMIT)
    .option(
      "--rescan",
      "read every chosen folder again instead of only what changed; each --rescan starts the walk over, so run it " +
        "once and continue with a plain sync",
    )
    .option("--embed", "also index pending text for meaning search, with a model already downloaded")
    .action(async (args: DocumentSyncArgs, command: Command) => {
      const deadline = environmentOf(command).deadline?.()
      const result = await helpers.sync({ ...args, budget: runBudgetOf(command), ...(deadline ? { deadline } : {}) })
      const timeout = command.optsWithGlobals<{ timeout?: string }>().timeout
      const part = documentSyncPart(result, {
        again: `${wording.app} ${helpers.profile()} sync`,
        source: wording.source,
        resume: {
          limit: args.limit,
          ...(timeout === undefined ? {} : { timeout }),
          ...(args.embed ? { embed: true } : {}),
        },
        longer: { limit: args.limit },
      })
      output(itemOf(result, { meta: part.meta, next: part.next }))
      for (const line of part.diagnostics) helpers.diagnostic(line)
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
