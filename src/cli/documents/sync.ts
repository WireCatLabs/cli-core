import { CliError } from "@wirecat/cli-base"
import { annotate, sharedCommand } from "@wirecat/cli-base/commands"
import type { Command } from "commander"
import { honoursDryRun } from "../dry-run-guard.js"
import { FETCH, LOCAL_READ } from "../effects.js"
import { type Body, itemOf } from "../envelope.js"
import { type DocumentWords, examples, positive, wordsOf } from "./words.js"

export interface DocumentSyncArgs {
  limit: number
  rescan?: boolean
  /** Also index pending text for meaning search, with a model already downloaded. */
  embed?: boolean
}

export interface DocumentSyncCommands {
  words: DocumentWords
  output(body: Body): void
  /** Writes a line for the person, not the answer. */
  diagnostic(text: string): void
  /** The selected profile, as `sync again` names it. */
  profile(): string
  /** The most entries one sync reads under the chosen folders, as `sync --help` says. */
  maxEntries: number
  /**
   * Syncs the selected profile into the shared store under the lock the CLI's writes take. `errors` are the failed
   * operations still pending; `pending` counts every operation left for the next sync.
   */
  sync(args: DocumentSyncArgs): Promise<{ errors: unknown[]; pending: number }>
  /** What `status` answers: the last sync, imported documents and pending work, from local files only. */
  status(): object | Promise<object>
}

const addDocumentSyncCommandsDefinition = (program: Command, helpers: DocumentSyncCommands) => {
  const { output } = helpers
  const wording = wordsOf(helpers.words)
  const { prefix, text } = wording
  const sync = examples(
    annotate(program.command("sync"), { effects: FETCH })
      .summary("import what changed in the chosen folders, and finish an unfinished sync")
      .description(
        "import what changed in the chosen folders, and finish an unfinished sync; " +
          `one sync reads at most ${helpers.maxEntries} entries under the chosen folders, and as many changes`,
      ),
    [`${prefix} sync`, `${prefix} sync --rescan --limit 500`],
  )
    .option("--limit <n>", text.syncLimit, positive, 200)
    .option("--rescan", "read every chosen folder again instead of only what changed")
    .option("--embed", "also index pending text for meaning search, with a model already downloaded")
    .action(async (args: DocumentSyncArgs) => {
      const result = await helpers.sync(args)
      output(
        itemOf(result, {
          meta: result.errors.length
            ? {
                complete: false,
                issues: [{ code: "provider_error" as const, reason: "sync.partial", source: wording.source }],
              }
            : {},
        }),
      )
      if (result.errors.length || result.pending)
        helpers.diagnostic(
          `${result.pending} source operations remain; run ${wording.app} ${helpers.profile()} sync again\n`,
        )
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
