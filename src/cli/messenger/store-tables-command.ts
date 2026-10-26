import { existsSync } from "node:fs"
import { CliError } from "@wirecat/cli-base"
import { annotate } from "@wirecat/cli-base/commands"
import { type QueryRegistry, queryFieldsOf } from "@wirecat/cli-base/query"
import { Command } from "commander"
import { storeTable } from "../../entities/store-table.js"
import { storePath } from "../../store/path.js"
import { readStoreTables, type TableKind } from "../../store/store.js"
import { environmentOf, outputFor } from "../context.js"
import { LOCAL_READ } from "../effects.js"
import { listOf, renderAnswer } from "../envelope.js"
import { type QueryWords, queryTerms, typedQuery, withQuery } from "../list-query.js"
import type { Messenger } from "./context.js"

const PATH = "store tables list"

export const STORE_TABLES_QUERY: QueryRegistry = {
  entity: "store_table",
  backend: "native",
  fields: queryFieldsOf(storeTable, {
    native: ["name", "kind"],
    examples: { name: "name:messages", kind: "kind:data" },
  }).map((field) =>
    field.native
      ? { ...field, operators: field.operators.filter((operator) => operator === "term" || operator === "phrase") }
      : field,
  ),
}

const filterOf = (words: QueryWords) => {
  const terms = queryTerms(words, STORE_TABLES_QUERY, PATH)
  const name = terms.get("name")
  const kind = terms.get("kind") as TableKind | undefined
  return { ...(name === undefined ? {} : { name }), ...(kind === undefined ? {} : { kind }) }
}

export const storeTablesCommand = (messenger: Messenger): Command => {
  const tables = new Command("tables").description("the tables of the local archive")
  withQuery(
    annotate(tables.command("list"), {
      effects: LOCAL_READ,
      examples: [
        `${messenger.app.command} store tables list`,
        `${messenger.app.command} store tables list kind:data`,
        `${messenger.app.command} store tables list --full --json`,
      ],
    }),
    STORE_TABLES_QUERY,
  )
    .summary("every table of the local archive, with its kind and row count")
    .description(
      "every table of the local archive: its kind (data, search index, part of a search index, internal) and its " +
        "rows, a search index's rows not counted; --full adds each table's size on disk, which reads the whole file " +
        "(about ten seconds for 3 GB); changes nothing",
    )
    .action(async function (this: Command, words: string[]) {
      const filter = filterOf(words)
      const { full } = this.optsWithGlobals<{ full?: boolean }>()
      const path = storePath(environmentOf(this).env ?? process.env)
      if (!existsSync(path)) throw new CliError("not_found", `no store at ${path}`)
      const items = await readStoreTables(path, { filter, sizes: full === true })
      renderAnswer(
        this,
        outputFor(this),
        listOf(PATH, {
          items,
          limit: Math.max(1, items.length),
          has_more: false,
          args: words.length ? { query: typedQuery(words) } : {},
        }),
      )
    })
  return tables
}
