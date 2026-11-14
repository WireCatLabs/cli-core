import { CliError } from "@wirecat/cli-base"
import { annotate, sharedCommand } from "@wirecat/cli-base/commands"
import { parseLucene, validateQuery } from "@wirecat/cli-base/query"
import type { Command } from "commander"
import { CATALOG_QUERY, type CatalogEntry, type CatalogQuery } from "../../store/index.js"
import { LOCAL_READ, LOCAL_WRITE } from "../effects.js"
import { type Body, itemOf, listOf } from "../envelope.js"
import type { DocumentKnowledgePort } from "./knowledge.js"
import { bindQuery, documentQueries, tagRow, termsOf } from "./queries.js"
import { allOf, type DocumentWords, examples, nonnegative, positive, wordsOf } from "./words.js"

/** The selected profile's catalog in the shared store, as the CLI binds it to its account. */
export interface DocumentCatalog {
  import(principal: string): Promise<{ entries: number; retired: number }>
  get(principal: string, id: string): Promise<CatalogEntry | undefined>
  list(principal: string, query?: CatalogQuery): Promise<{ items: CatalogEntry[]; hasMore: boolean }>
}

export interface DocumentCatalogStores {
  catalog?: DocumentCatalog
  knowledge?: Pick<DocumentKnowledgePort, "tags">
}

export interface DocumentCatalogCommands {
  words: DocumentWords
  output(body: Body): void
  /**
   * Opens the selected profile's store for one command. `write` is true for `catalog import` and tag changes: the CLI
   * then holds the lock its sync takes, and checks it is still held before and after `fn`.
   */
  run<T>(fn: (stores: DocumentCatalogStores, principal: string) => Promise<T>, write: boolean): Promise<T>
  /** The provider's id of a file or folder the user names by id or URL. */
  id(input: string): string
  /** The chosen folders: what `catalog tree` shows without a folder. */
  roots(): string[]
}

export interface CatalogTree {
  item: Pick<CatalogEntry, "ref" | "name" | "kind" | "url" | "content"> & { id: string }
  children: CatalogTree[]
  truncated: boolean
}

/** Reads one profile's catalog for `catalog tree`: an entry by its external id, and a folder's children. */
export interface CatalogTreeSource {
  get(externalId: string): Promise<CatalogEntry | undefined>
  /**
   * The entries whose parents name this one, paged through the store with no cap on the total; at most `max` when
   * given, which is all a branch below the depth needs to say it was cut.
   */
  children(externalId: string, max?: number): Promise<CatalogEntry[]>
}

/**
 * Reads the account's whole catalog once, page by page. A `parent` filter scans every entry, so asking per folder
 * costs the square of the entries.
 */
export const catalogSource = async (list: DocumentCatalog["list"], principal: string): Promise<CatalogTreeSource> => {
  const entries = new Map<string, CatalogEntry>()
  const children = new Map<string, CatalogEntry[]>()
  for (let offset = 0; ; offset += 1000) {
    const page = await list(principal, { limit: 1000, offset })
    for (const entry of page.items) {
      entries.set(entry.externalId, entry)
      for (const parent of entry.parents) {
        const siblings = children.get(parent)
        if (siblings) siblings.push(entry)
        else children.set(parent, [entry])
      }
    }
    if (!page.hasMore) break
  }
  return {
    get: async (externalId) => entries.get(externalId),
    children: async (externalId, max) => (children.get(externalId) ?? []).slice(0, max),
  }
}

export const catalogTree = async (
  source: CatalogTreeSource,
  roots: string[],
  depth: number,
): Promise<CatalogTree[]> => {
  if (!Number.isSafeInteger(depth) || depth < 0 || depth > 50)
    throw new CliError("validation_error", "tree depth must be between 0 and 50", { reason: "catalog.depth-invalid" })
  const node = async (item: CatalogEntry, level: number, ancestors: Set<string>): Promise<CatalogTree> => {
    if (ancestors.has(item.externalId))
      throw new CliError("invalid_response", "local folder ancestry contains a cycle", { reason: "catalog.cycle" })
    const found = await source.children(item.externalId, level < depth ? undefined : 1)
    const next = new Set([...ancestors, item.externalId])
    const children: CatalogTree[] = []
    if (level < depth) for (const child of found) children.push(await node(child, level + 1, next))
    return {
      item: {
        id: catalogId(item),
        ref: item.ref,
        name: item.name,
        kind: item.kind,
        url: item.url,
        content: item.content,
      },
      children,
      truncated: level >= depth && found.length > 0,
    }
  }
  const trees: CatalogTree[] = []
  for (const id of roots) {
    const entry = await source.get(id)
    if (entry?.kind !== "folder")
      throw new CliError("not_found", "folder is not in the active local catalog; run catalog import or sync", {
        reason: "catalog.not-found",
      })
    trees.push(await node(entry, 0, new Set()))
  }
  return trees
}

export const catalogId = (entry: CatalogEntry): string => entry.externalId.replace(/\.md$/, "")

export const catalogOutput = (entry: CatalogEntry) => ({
  id: catalogId(entry),
  ref: entry.ref,
  kind: entry.kind,
  name: entry.name,
  parents: entry.parents.map((id) => id.replace(/\.md$/, "")),
  url: entry.url,
  mime: entry.mime,
  size: entry.size,
  created_at: entry.createdAt,
  modified_at: entry.modifiedAt,
  observed_at: entry.observedAt,
  description: entry.description,
  actors: entry.actors,
  provider_metadata: entry.metadata,
  active: entry.active,
  content: entry.content,
})

// Keep field selection tied to the provider view, including future additions to that view.
export const CATALOG_FIELDS = Object.keys({
  id: true,
  ref: true,
  kind: true,
  name: true,
  parents: true,
  url: true,
  mime: true,
  size: true,
  created_at: true,
  modified_at: true,
  observed_at: true,
  description: true,
  actors: true,
  provider_metadata: true,
  active: true,
  content: true,
} satisfies Record<keyof ReturnType<typeof catalogOutput>, true>)

const local = (command: Command, mutates = false) => annotate(command, { effects: mutates ? LOCAL_WRITE : LOCAL_READ })
const addDocumentCatalogCommandsDefinition = (program: Command, helpers: DocumentCatalogCommands) => {
  const { output } = helpers
  const wording = wordsOf(helpers.words)
  const { prefix, text } = wording
  const queries = documentQueries(wording)
  const view = "catalog"
  const catalog = local(program.command("catalog")).description(text.catalog)
  const run = <T>(
    fn: (index: DocumentCatalogStores & { catalog: DocumentCatalog }, principal: string) => Promise<T>,
    write = false,
  ) =>
    helpers.run(async (index, principal) => {
      if (!index.catalog)
        throw new CliError("configuration_error", "index has no shared catalog adapter", {
          reason: "catalog.unavailable",
        })
      return fn({ ...index, catalog: index.catalog }, principal)
    }, write)

  const entry = async (index: DocumentCatalogStores, principal: string, id: string) => {
    const found = await index.catalog?.get(principal, helpers.id(id))
    if (!found)
      throw new CliError("not_found", "file or folder is not in the active local catalog; run catalog import or sync", {
        reason: "catalog.not-found",
      })
    return found
  }
  examples(
    local(catalog.command("import").description("put cached file and folder metadata into the shared database"), true),
    [`${prefix} catalog import --offline`],
  ).action(async () => output(itemOf(await run((index, principal) => index.catalog.import(principal), true))))
  examples(
    annotate(
      local(catalog.command("show").description("show stored metadata and the stable file or folder reference")),
      {
        output: { entity: "document", view },
      },
    ),
    [`${prefix} catalog show FILE_ID --offline`],
  )
    .argument("<file>", text.catalogArgument)
    .action(async (id: string) =>
      output(itemOf(await run(async (index, principal) => catalogOutput(await entry(index, principal, id))))),
    )
  const list = async (terms: string[], args: { limit: number; page: number }, search: boolean) => {
    const ast = terms.length
      ? validateQuery(parseLucene(terms.join(" "), { defaultField: search ? "text" : "none" }), CATALOG_QUERY)
      : undefined
    const result = await run((index, principal) =>
      index.catalog.list(principal, { ast, limit: args.limit, offset: (args.page - 1) * args.limit }),
    )
    output(
      listOf(`catalog ${search ? "search" : "list"}`, {
        items: result.items.map(catalogOutput),
        limit: args.limit,
        has_more: result.hasMore,
        page: args.page,
        args: { query: terms.length ? terms.join(" ") : undefined },
      }),
    )
  }
  for (const action of ["list", "search"] as const) {
    const command = examples(
      local(
        catalog
          .command(action)
          .description(
            action === "list"
              ? "list cached files and folders using metadata queries"
              : "search cached names, descriptions, types and observed people",
          ),
      ),
      [
        action === "list"
          ? `${prefix} catalog list "parent:FOLDER_ID AND kind:file" --offline`
          : `${prefix} catalog search "budget AND person:Rin*" --offline`,
      ],
    )
      .argument(
        action === "list" ? "[query...]" : "<query...>",
        "metadata query: kind, mime, name, parent, person, tag; AND, OR, NOT",
      )
      .option("--limit <n>", "how many entries to return (at most 1000)", positive, 50)
      .option("--page <n>", "which page to return", positive, 1)
      .action(async (terms: string[], args: { limit: number; page: number }) => list(terms, args, action === "search"))
    annotate(command, { query: CATALOG_QUERY, output: { entity: "document", view } })
  }
  examples(
    local(catalog.command("tree").description("show the cached hierarchy below a folder or all selected roots")),
    [`${prefix} catalog tree --offline`, `${prefix} catalog tree FOLDER_ID --depth 3 --offline`],
  )
    .argument("[folder]", text.treeArgument)
    .option("--depth <n>", "maximum descendant depth, from 0 to 50", nonnegative, 5)
    .action(async (id: string | undefined, args: { depth: number }) =>
      output(
        await run(async (index, principal) => {
          const roots = id ? [helpers.id(id)] : helpers.roots()
          const tree = await catalogTree(
            await catalogSource((owner, query) => index.catalog.list(owner, query), principal),
            roots.map((root) => `${root}.md`),
            args.depth,
          )
          return allOf(tree)
        }),
      ),
    )
  const tags = local(catalog.command("tags")).description("add owner tags to cached files or folders")
  for (const action of ["list", "add", "remove"] as const) {
    const command = examples(
      local(tags.command(action).description(`${action} local tags on a cached file or folder`), action !== "list"),
      [`${prefix} catalog tags ${action} FOLDER_ID${action === "list" ? "" : " project"} --offline`],
    ).argument("<file>", text.catalogArgument)
    if (action === "list") bindQuery(command, queries.tags, tagRow)
    else command.argument("<tags...>", "local tag names")
    command.action(async (id: string, values: string[] = []) => {
      const filter = action === "list" ? termsOf(values, queries.tags, "catalog tags list") : undefined
      return output(
        allOf<unknown>(
          await run(async (index, principal) => {
            const found = await entry(index, principal, id)
            if (!index.knowledge) throw new CliError("configuration_error", "index has no shared knowledge adapter")
            const tags = await index.knowledge.tags(
              principal,
              found.ref,
              action,
              action === "list" ? undefined : values,
              filter,
            )
            return action === "list" ? tags.map((tag) => ({ tag })) : tags
          }, action !== "list"),
        ),
      )
    })
  }
}

/** `catalog import|show|list|search|tree|tags` over the selected profile's files and folders in the shared store. */
export const addDocumentCatalogCommands = sharedCommand(addDocumentCatalogCommandsDefinition)
