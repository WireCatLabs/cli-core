import { CliError } from "@wirecat/cli-base"
import { annotate, sharedCommand } from "@wirecat/cli-base/commands"
import { parseLucene, validateQuery } from "@wirecat/cli-base/query"
import type { Command } from "commander"
import { CATALOG_QUERY, type CatalogEntry, type CatalogQuery } from "../../store/index.js"
import { honoursDryRun } from "../dry-run-guard.js"
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
  /** The entry is already in this answer (a file in two folders): its children are shown at its first place. */
  repeated?: true
}

/** How many entries one `catalog tree` answer holds before it asks for a smaller folder or depth. */
export const CATALOG_TREE_LIMIT = 10_000
const CATALOG_PAGE = 1000

/** Reads one profile's catalog for `catalog tree`: an entry by its external id, and one page of its children. */
export interface CatalogTreeSource {
  get(externalId: string): Promise<CatalogEntry | undefined>
  children(
    externalId: string,
    page: { limit: number; offset: number },
  ): Promise<{ items: CatalogEntry[]; hasMore: boolean }>
  /** Which of these entries have children, in one read; the tree asks each one when absent. */
  withChildren?(externalIds: string[]): Promise<Set<string>>
}

const PARENT_BATCH = 200
/** `parent:a OR parent:b …` over ids as they are: the values go into a parsed template, so none needs escaping. */
const anyParent = (ids: string[]): CatalogQuery["ast"] => {
  const ast = parseLucene(Array.from({ length: Math.max(2, ids.length) }, () => "parent:x").join(" OR "), {
    defaultField: "none",
  })
  const clauses = (ast.root as { clauses: { node: { value: string } }[] }).clauses
  clauses.forEach((clause, i) => {
    clause.node.value = ids[Math.min(i, ids.length - 1)] as string
  })
  return validateQuery(ast, CATALOG_QUERY)
}

/** The tree's reads through the CLI's catalog, which takes ids without the `.md` the store's entries carry. */
export const catalogSource = (
  catalog: Pick<DocumentCatalog, "get" | "list">,
  principal: string,
): CatalogTreeSource => ({
  get: (externalId) => catalog.get(principal, catalogId({ externalId })),
  children: (externalId, page) => catalog.list(principal, { parent: catalogId({ externalId }), ...page }),
  // Each read scans the account's catalog, so the branches cut at the depth are asked about 200 at a time.
  withChildren: async (externalIds) => {
    const found = new Set<string>()
    for (let start = 0; start < externalIds.length; start += PARENT_BATCH) {
      const batch = new Set(externalIds.slice(start, start + PARENT_BATCH))
      const ast = anyParent([...batch].map((externalId) => catalogId({ externalId })))
      for (let offset = 0; ; offset += CATALOG_PAGE) {
        const page = await catalog.list(principal, { ast, limit: CATALOG_PAGE, offset })
        for (const item of page.items) for (const parent of item.parents) if (batch.delete(parent)) found.add(parent)
        if (!page.hasMore || batch.size === 0) break
      }
    }
    return found
  },
})

const tooLarge = (limit: number) =>
  new CliError("validation_error", `the tree is over ${limit} entries; name a smaller FOLDER or lower --depth`, {
    reason: "catalog.tree-limit",
  })

/**
 * Builds the tree by reading each shown entry's children from the store, page by page, so what it holds is what it
 * answers. Any entry can have children: a page with sub-pages is a `file`.
 */
export const catalogTree = async (
  source: CatalogTreeSource,
  roots: string[],
  depth: number,
  limit = CATALOG_TREE_LIMIT,
): Promise<CatalogTree[]> => {
  if (!Number.isSafeInteger(depth) || depth < 0 || depth > 50)
    throw new CliError("validation_error", "tree depth must be between 0 and 50", { reason: "catalog.depth-invalid" })
  let nodes = 0
  const seen = new Set<string>()
  const cut: CatalogTree[] = []
  const cutIds: string[] = []
  const hasChildren = async (externalId: string) =>
    (await source.children(externalId, { limit: 1, offset: 0 })).items.length > 0
  const childrenOf = async (externalId: string) => {
    const items: CatalogEntry[] = []
    for (let offset = 0; ; offset += CATALOG_PAGE) {
      const page = await source.children(externalId, { limit: CATALOG_PAGE, offset })
      for (const item of page.items) items.push(item)
      if (nodes + items.length > limit) throw tooLarge(limit)
      if (!page.hasMore) return items
    }
  }
  const node = async (entry: CatalogEntry, level: number, ancestors: Set<string>): Promise<CatalogTree> => {
    if (ancestors.has(entry.externalId))
      throw new CliError("invalid_response", "local folder ancestry contains a cycle", { reason: "catalog.cycle" })
    if (++nodes > limit) throw tooLarge(limit)
    const tree: CatalogTree = {
      item: {
        id: catalogId(entry),
        ref: entry.ref,
        name: entry.name,
        kind: entry.kind,
        url: entry.url,
        content: entry.content,
      },
      children: [],
      truncated: false,
    }
    if (seen.has(entry.externalId)) return { ...tree, repeated: true }
    seen.add(entry.externalId)
    if (level >= depth) {
      cut.push(tree)
      cutIds.push(entry.externalId)
      return tree
    }
    const next = new Set(ancestors).add(entry.externalId)
    for (const child of await childrenOf(entry.externalId)) tree.children.push(await node(child, level + 1, next))
    return tree
  }
  const trees: CatalogTree[] = []
  for (const id of roots) {
    const entry = await source.get(id)
    if (!entry || (entry.kind !== "folder" && !(await hasChildren(entry.externalId))))
      throw new CliError("not_found", "no folder or page with sub-pages by that id in the active local catalog", {
        reason: "catalog.not-found",
      })
    trees.push(await node(entry, 0, new Set()))
  }
  const parents = source.withChildren
    ? await source.withChildren(cutIds)
    : new Set((await Promise.all(cutIds.map(async (id) => ((await hasChildren(id)) ? id : "")))).filter(Boolean))
  cut.forEach((tree, i) => {
    tree.truncated = parents.has(cutIds[i] as string)
  })
  return trees
}

export const catalogId = (entry: Pick<CatalogEntry, "externalId">): string => entry.externalId.replace(/\.md$/, "")

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
  const queries = documentQueries()
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
            catalogSource(index.catalog, principal),
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
export const addDocumentCatalogCommands = honoursDryRun(sharedCommand(addDocumentCatalogCommandsDefinition))
