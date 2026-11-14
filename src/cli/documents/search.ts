import { annotate, sharedCommand } from "@wirecat/cli-base/commands"
import type { Command } from "commander"
import { honoursDryRun } from "../dry-run-guard.js"
import { LOCAL_READ } from "../effects.js"
import { type Body, itemOf } from "../envelope.js"
import { type DocumentWords, examples, positive, wordsOf } from "./words.js"

export interface DocumentSearchOptions {
  limit: number
  offset: number
  exact: boolean
}

export interface DocumentSearchCommands {
  words: DocumentWords
  output(body: Body): void
  /** Searches the selected profile's imported documents, by meaning too when they are indexed. */
  search(query: string, options: DocumentSearchOptions): Promise<object>
  /**
   * What the selected profile has imported. An empty answer over an empty import reads to an agent as "no such
   * document", so the answer then says what to run.
   */
  imported(): { profile: string; chosen: boolean; documents: number }
}

const notImported = (app: string, { profile, chosen, documents }: ReturnType<DocumentSearchCommands["imported"]>) => {
  if (documents > 0) return undefined
  return !chosen
    ? `profile ${profile} has no folders selected, so nothing is imported to search — ` +
        `${app} ${profile} folders add FOLDER_ID, then ${app} ${profile} sync`
    : `profile ${profile} has imported no documents yet — ${app} ${profile} sync`
}

const addDocumentSearchCommandDefinition = (program: Command, helpers: DocumentSearchCommands) => {
  const wording = wordsOf(helpers.words)
  const { prefix } = wording
  return examples(
    annotate(program.command("search"), { effects: LOCAL_READ })
      .argument("<query>", "words to look for, and fields such as tag: and date: that every hit must match")
      .description("search imported documents by words, and by meaning when indexed"),
    [`${prefix} search budget`, `${prefix} search "quarterly plan" --exact --limit 5`],
  )
    .option("--limit <n>", "how many results to return", positive, 20)
    .option("--page <n>", "which page to return", positive, 1)
    .option("--exact", "match the words exactly: no word forms, no meaning")
    .action(async (query: string, { page, ...args }: { limit: number; page: number; exact?: boolean }) => {
      const result = await helpers.search(query, {
        ...args,
        offset: (page - 1) * args.limit,
        exact: args.exact ?? false,
      })
      const hint = notImported(wording.app, helpers.imported())
      helpers.output(itemOf(hint ? { ...result, not_imported: hint } : result))
    })
}

/** `search` over the selected profile's imported documents; a documents CLI has no messenger `search` group. */
export const addDocumentSearchCommand = honoursDryRun(sharedCommand(addDocumentSearchCommandDefinition))
