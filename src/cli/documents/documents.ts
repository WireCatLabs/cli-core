import { writeFileSync } from "node:fs"
import { CliError } from "@wirecat/cli-base"
import { annotate, sharedCommand } from "@wirecat/cli-base/commands"
import type { QueryAst } from "@wirecat/cli-base/query"
import type { Command } from "commander"
import type { SourceContent } from "../../documents.js"
import { IMPORTED_DOCUMENT_QUERY } from "../../store/index.js"
import { honoursDryRun } from "../dry-run-guard.js"
import { LOCAL_READ, LOCAL_WRITE } from "../effects.js"
import { type Body, itemOf, listOf } from "../envelope.js"
import { listQuery, typedQuery, withQuery } from "../list-query.js"
import { ageOf, type DocumentWords, documentsGroup, examples, positive, staleCopy, wordsOf } from "./words.js"

/** An imported document of the selected profile, with its metadata as the CLI prints it. */
export interface ImportedDocument {
  id: string
  metadata: unknown
  snapshot: SourceContent
}

export interface LocalDocumentCommands {
  words: DocumentWords
  output(body: Body): void
  /** The selected profile's imported documents the query matches, one page, as the CLI prints each. */
  list(
    query: QueryAst | undefined,
    page: { limit: number; offset: number },
  ): Promise<{ items: object[]; hasMore: boolean }>
  /** Resolves an id, URL or `document:<n>` ref; one the profile has not imported is the CLI's `not_found`. */
  document(input: string): ImportedDocument
  /** When the selected profile last synced: every answer says how old its copy is. */
  lastSync(): string | undefined
}

const addLocalDocumentCommandsDefinition = (program: Command, helpers: LocalDocumentCommands) => {
  const { output, lastSync } = helpers
  const wording = wordsOf(helpers.words)
  const { prefix, provider, text } = wording
  const documents = documentsGroup(program, wording)
  annotate(
    withQuery(
      examples(annotate(documents.command("list"), { effects: LOCAL_READ }).description(text.documentsList), [
        `${prefix} documents list`,
        `${prefix} documents list tag:budget`,
        `${prefix} documents list person:PERSON_UID --limit 10`,
      ]),
      IMPORTED_DOCUMENT_QUERY,
    ),
    { output: { entity: "document", view: "imported" }, partial: true },
  )
    .option("--limit <n>", "how many documents to return", positive, 50)
    .option("--page <n>", "which page to return", positive, 1)
    .action(async (words: string[], { limit, page }: { limit: number; page: number }) => {
      const query = typedQuery(words)
      const ast = listQuery(query, IMPORTED_DOCUMENT_QUERY, "documents list")
      const found = await helpers.list(ast, { limit, offset: (page - 1) * limit })
      const synced = lastSync()
      const age = ageOf(synced)
      output(
        listOf("documents list", {
          ...staleCopy(provider, synced),
          items: found.items.map((item) => ({ ...item, ...age })),
          limit,
          has_more: found.hasMore,
          page,
          args: { query: query || undefined },
        }),
      )
    })
  examples(
    annotate(documents.command("show"), { effects: LOCAL_READ, partial: true })
      .argument("<document>", text.documentArgument)
      .description("show an imported document's text, tabs and metadata"),
    [`${prefix} documents show DOC_ID`, `${prefix} documents show document:42 --offline`],
  ).action((input: string) => {
    const { metadata, snapshot } = helpers.document(input)
    const synced = lastSync()
    output(
      itemOf(
        {
          metadata,
          ...ageOf(synced),
          text: snapshot.text,
          tabs: snapshot.tabs,
          ...(snapshot.notRead ? { not_read: snapshot.notRead } : {}),
        },
        staleCopy(provider, synced),
      ),
    )
  })
  examples(
    annotate(documents.command("export"), { effects: LOCAL_WRITE, partial: true })
      .argument("<document>", text.documentArgument)
      .description("write an imported document to a new Markdown file"),
    [`${prefix} documents export DOC_ID --output notes.md`],
  )
    .requiredOption("--output <file>", "path of the Markdown file to write; an existing file is refused")
    .action((input: string, args: { output: string }) => {
      const { id, snapshot } = helpers.document(input)
      try {
        writeFileSync(args.output, snapshot.markdown, { flag: "wx", mode: 0o600 })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST")
          throw new CliError("validation_error", "the output file already exists; choose another --output", {
            reason: "export.exists",
            param: "--output",
          })
        throw error
      }
      const synced = lastSync()
      output(itemOf({ id, path: args.output, format: "markdown", ...ageOf(synced) }, staleCopy(provider, synced)))
    })
  return documents
}

/**
 * `documents list|show|export` over the selected profile's local copy, in the `documents` group it returns: the CLI
 * adds its live subcommands (`get`, `create`, …) to that group after these.
 */
export const addLocalDocumentCommands = honoursDryRun(sharedCommand(addLocalDocumentCommandsDefinition))
