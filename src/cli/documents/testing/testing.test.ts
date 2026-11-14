import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CliError, isCliError } from "@wirecat/cli-base"
import { annotate, overrideSharedContract } from "@wirecat/cli-base/commands"
import { Command } from "commander"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  catalogFiles,
  documentIngestion,
  documentKnowledge,
  type Mirror,
  type SourceContent,
  type SourceFile,
  type SourceState,
  syncDocuments,
} from "../../../documents.js"
import { type CatalogEntry, type MessageStore, openStore } from "../../../store/index.js"
import type { Body } from "../../envelope.js"
import {
  addDocumentCommands,
  type CatalogTreeSource,
  catalogSource,
  catalogTree,
  type DocumentKnowledgePort,
  type DocumentWords,
} from "../index.js"
import {
  documentCommandsContract,
  documentSourceContract,
  FAKE_FOLDER,
  type FakeDocumentSource,
  fakeDocumentSource,
  fakeFile,
} from "./index.js"

const engine = vi.hoisted(() => ({ sync: vi.fn() }))
vi.mock("../../../documents.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../../documents.js")>()
  return { ...real, syncMirrors: engine.sync }
})

const stores: MessageStore[] = []
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close()
})

const WORDS: DocumentWords = {
  app: "box",
  remote: "box",
  provider: "Box",
  source: "synthetic-box",
}
const PRINCIPAL = "alpha"
const isFolder = (file: SourceFile) => file.mime === FAKE_FOLDER
const must = <T>(value: T | undefined): T => {
  if (value === undefined) throw new Error("missing synthetic fixture")
  return value
}

/** A documents CLI in miniature: the fake provider, a temporary store and the shared commands over them. */
const reference = async (source: FakeDocumentSource = fakeDocumentSource(PRINCIPAL)) => {
  const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "documents-commands-")), "store.db") })
  stores.push(store)
  let state: SourceState = { version: 1, principal: PRINCIPAL, scope: "", folders: {}, documents: {}, skipped: [] }
  const snapshots = new Map<string, SourceContent>()
  const roots = ["root"]
  let mirrors: Mirror[] = []
  const printed: Body[] = []
  const ingest = documentIngestion(store, {
    collectionName: (account) => `synthetic-box:${account}`,
    externalId: (id) => `${id}.md`,
    catalogInput: (file: SourceFile) => ({
      externalId: `${file.id}.md`,
      name: file.name,
      parents: file.parents.map((id) => `${id}.md`),
      kind: isFolder(file) ? "folder" : "file",
      url: file.url,
      mime: file.mime,
    }),
    frontMatter: (content) => ({ source: "synthetic-box", sourceUrl: content.metadata.url }),
  })
  const collection = async () => (await ingest.collection(PRINCIPAL, false))?.id
  const shared = documentKnowledge(store, collection)
  const knowledge: DocumentKnowledgePort = {
    ...shared,
    context: async (principal, ref) => ({ document: await shared.document(principal, ref) }),
    people: async () => ({ items: [] }),
    linkPerson: async () => {
      throw new CliError("not_found", "the synthetic provider shows no accounts")
    },
  }
  const refOf = (input: string) => {
    if (/^document:\d+$/.test(input)) return input
    const doc = state.documents[input]
    if (!doc)
      throw new CliError("not_found", "this source is not imported in the selected profile", {
        reason: "document.not-imported",
      })
    return doc.reference
  }
  const imported = (input: string) => {
    const ref = refOf(input)
    const [id, doc] = Object.entries(state.documents).find(([, one]) => one.reference === ref) ?? []
    const snapshot = id ? snapshots.get(id) : undefined
    if (!id || !doc || !snapshot) throw new CliError("not_found", "no local copy", { reason: "document.not-imported" })
    return { id, ref, hash: doc.hash, snapshot }
  }
  const program = new Command("box").exitOverride()
  addDocumentCommands<unknown>(program, {
    words: WORDS,
    output: (body) => printed.push(body),
    folders: {
      add: async (input) => {
        const file = await source.metadata(input)
        if (!isFolder(file)) throw new CliError("validation_error", "source is not an accessible folder")
        if (!roots.includes(file.id)) roots.push(file.id)
        return { id: file.id, name: file.name }
      },
      list: (filter) => roots.filter((id) => filter.id === undefined || filter.id === id).map((id) => ({ id })),
      remove: (input) => {
        roots.splice(roots.indexOf(input), 1)
        return input
      },
    },
    sync: {
      diagnostic: () => {},
      profile: () => "personal",
      maxEntries: 10000,
      sync: async ({ limit, rescan }) =>
        syncDocuments({
          source,
          index: { ...ingest, openPictures: async () => ({ save: async () => "saved", close: async () => {} }) },
          principal: PRINCIPAL,
          roots,
          textLimit: 200000,
          max: limit,
          maxEntries: 10000,
          storeVersion: "fixture-1",
          isFolder,
          skipReason: () => undefined,
          retryable: () => false,
          errorOf: (error) => (isCliError(error) ? error : new CliError("provider_error", "synthetic request failed")),
          assertHeld: () => {},
          // Two days before the tests run, so every answer carries the old-copy warning.
          now: () => Date.now() - 2 * 24 * 60 * 60 * 1000,
          ...(rescan ? { rescan } : {}),
          state: {
            read: () => structuredClone(state),
            save: (next) => {
              state = structuredClone(next)
            },
            readWalk: () => undefined,
            saveWalk: () => {},
            removeWalk: () => {},
            saveSnapshot: (content) => {
              snapshots.set(content.metadata.id, content)
            },
            removeSnapshot: (id) => {
              snapshots.delete(id)
            },
          },
        }),
      status: () => ({ documents: Object.keys(state.documents).length, last_sync: state.lastSync ?? null }),
    },
    documents: {
      list: async (query, page) => {
        const found = await shared.documents(PRINCIPAL, query, page)
        return {
          items: found.items.map((note) => ({ id: (note.path ?? "").replace(/\.md$/, ""), reference: note.ref })),
          hasMore: found.hasMore,
        }
      },
      document: (input) => {
        const { id, snapshot } = imported(input)
        return { id, metadata: snapshot.metadata, snapshot }
      },
      lastSync: () => state.lastSync,
    },
    search: {
      search: async (query) => ({
        items: [...snapshots.values()]
          .filter((content) => content.text.includes(query))
          .map((content) => ({ id: content.metadata.id })),
      }),
      imported: () => ({ profile: "personal", chosen: roots.length > 0, documents: snapshots.size }),
    },
    catalog: {
      run: async (fn) =>
        fn(
          {
            catalog: {
              import: async (principal) => ingest.catalog.import(principal, catalogFiles(state, roots)),
              get: (principal, id) => ingest.catalog.get(principal, id),
              list: (principal, query) => ingest.catalog.list(principal, query),
            },
            knowledge,
          },
          PRINCIPAL,
        ),
      id: (input) => input,
      roots: () => roots,
    },
    knowledge: {
      run: async (input, fn) => fn(knowledge, PRINCIPAL, refOf(input)),
      document: imported,
      complete: () => async () => {
        throw new CliError("configuration_error", "no model in this test")
      },
      author: () => "owner",
      decider: () => "owner",
    },
    mirrors: {
      print: () => {},
      profile: () => "personal",
      mirrors: () => structuredClone(mirrors),
      save: (next) => {
        mirrors = structuredClone(next)
      },
      parent: async (input) => {
        const file = await source.metadata(input)
        return { id: file.id, name: file.name }
      },
      kindOf: (path) => (path.endsWith(".md") ? "doc" : undefined),
      stateOf: (mirror) => ({
        read: () => ({
          version: 1,
          principal: PRINCIPAL,
          root: mirror.path,
          target: mirror.folder,
          folders: {},
          entries: {},
          pending: {},
        }),
        save: () => {},
      }),
      connect: async () => ({
        sync: {} as never,
        startToken: async () => "cursor-0",
        changes: async () => ({ cursor: "cursor-1", items: [] }),
      }),
      endsOnStop: () => undefined,
    },
  })
  const run = async (argv: string[]) => {
    printed.length = 0
    try {
      await program.parseAsync(argv, { from: "user" })
      return { exit: 0, stdout: printed.map((body) => JSON.stringify(body)).join("\n"), printed }
    } catch (error) {
      return { exit: 1, stdout: "", printed, error }
    }
  }
  return { program, run, store, source, printed, state: () => state, collection }
}

describe("documents source contract over the fake provider", () => {
  for (const c of documentSourceContract(() => {
    const source = fakeDocumentSource()
    return { source, root: "root", isFolder, missing: "gone", change: async () => source.put(fakeFile("c"), "new") }
  }))
    it(c.name, c.run)
})

const PAGE = "application/x-synthetic-page"
const isPage = (file: SourceFile) => file.mime === PAGE

describe("documents source contract over pages with sub-pages and no plain file", () => {
  for (const c of documentSourceContract(() => {
    const source = fakeDocumentSource()
    for (const id of ["root", "nested", "a", "b"]) source.files.delete(id)
    source.put(fakeFile("root", [], PAGE))
    source.put(fakeFile("child", ["root"], PAGE), "a page with its own text")
    source.put(fakeFile("grandchild", ["child"], PAGE), "a page below it")
    return { source, root: "root", isFolder: isPage, isDocument: isPage, missing: "gone" }
  }))
    it(c.name, c.run)
})

describe("documents commands contract over a reference CLI", () => {
  for (const c of documentCommandsContract(async () => {
    const cli = await reference()
    return { program: cli.program, words: WORDS, run: cli.run, document: "a", word: "quarterly", mirrors: true }
  }))
    it(c.name, c.run)
})

describe("documents commands contract over a broken CLI", () => {
  it("refuses a CLI that overrides a shared command", async () => {
    const cli = await reference()
    const search = must(cli.program.commands.find((one) => one.name() === "search"))
    overrideSharedContract(search, "a broken CLI", (one) => one.description("something else"))
    const [tree] = documentCommandsContract(() => ({
      program: cli.program,
      words: WORDS,
      run: cli.run,
      document: "a",
      word: "quarterly",
      mirrors: true,
    }))
    await expect(must(tree).run()).rejects.toThrow("overrides no shared contract")
  })
  it("refuses a CLI whose shared command reads where cli-core writes", async () => {
    const cli = await reference()
    const sync = must(cli.program.commands.find((one) => one.name() === "sync"))
    annotate(sync, { effects: { remote: "none", local: "read" } })
    const [tree] = documentCommandsContract(() => ({
      program: cli.program,
      words: WORDS,
      run: cli.run,
      document: "a",
      word: "quarterly",
      mirrors: true,
    }))
    await expect(must(tree).run()).rejects.toThrow("reads and writes what cli-core says")
  })
})

describe("shared documents commands", () => {
  it("names the remote side with the CLI's word and maps it to the engine's remote", async () => {
    const cli = await reference()
    const sync = cli.program.commands
      .find((one) => one.name() === "mirrors")
      ?.commands.find((one) => one.name() === "sync")
    expect(sync?.options.find((option) => option.long === "--keep")?.argChoices).toEqual(["local", "box", "both"])
    await cli.run(["mirrors", "add", mkdtempSync(join(tmpdir(), "documents-mirror-")), "--parent", "root"])
    const refused = await cli.run(["mirrors", "sync", "--replace", "--keep", "box"])
    expect(refused.exit).toBe(1)
    expect((refused.error as Error).message).toContain("cannot be combined with --keep box or both")
    engine.sync.mockResolvedValue({ items: [], issues: [] })
    expect((await cli.run(["mirrors", "sync", "--keep", "box"])).exit).toBe(0)
    expect(engine.sync).toHaveBeenCalledWith(
      expect.objectContaining({ keep: "remote", remote: "box", recreate: false }),
    )
  })

  it("mirrors add keeps one mirror per folder pair, and list narrows it by id", async () => {
    const cli = await reference()
    const folder = mkdtempSync(join(tmpdir(), "documents-mirror-"))
    expect((await cli.run(["mirrors", "add", folder, "--parent", "root"])).printed[0]).toMatchObject({
      item: { folder: "root", folder_name: "root", added: true },
    })
    await cli.run(["mirrors", "add", folder, "--parent", "root"])
    const listed = (await cli.run(["mirrors", "list"])).printed[0] as { items: Mirror[] }
    expect(listed.items).toHaveLength(1)
    const id = listed.items[0]?.id as string
    expect(((await cli.run(["mirrors", "list", `id:${id}`])).printed[0] as { items: Mirror[] }).items).toHaveLength(1)
    expect((await cli.run(["mirrors", "remove", id])).printed[0]).toMatchObject({ item: { id, removed: true } })
    expect((await cli.run(["mirrors", "remove", id])).error).toMatchObject({ details: { reason: "mirror.not-found" } })
  })

  it("search over an empty import says what to run, with the CLI's own name", async () => {
    const cli = await reference()
    const answer = await cli.run(["search", "budget"])
    expect(answer.printed[0]).toMatchObject({
      item: { not_imported: "profile personal has imported no documents yet — box personal sync" },
    })
  })

  it("a partial sync answers the issue under the CLI's store provider, then fails", async () => {
    const source = fakeDocumentSource(PRINCIPAL)
    const content = source.content
    source.content = async (id, max) => {
      if (id === "b") throw new CliError("provider_error", "synthetic outage")
      return content(id, max)
    }
    const cli = await reference(source)
    const answer = await cli.run(["sync"])
    expect(answer.exit).toBe(1)
    expect(answer.printed[0]?.meta).toMatchObject({
      complete: false,
      issues: [{ code: "provider_error", reason: "sync.partial", source: "synthetic-box" }],
    })
    expect(answer.error).toMatchObject({ details: { reason: "sync.partial" } })
  })

  it("catalog tree shows the chosen folders and their files after an import", async () => {
    const cli = await reference()
    await cli.run(["sync"])
    await cli.run(["catalog", "import"])
    const tree = (await cli.run(["catalog", "tree"])).printed[0] as { items: { item: { id: string } }[] }
    expect(JSON.stringify(tree.items)).toContain('"id":"a"')
    expect((await cli.run(["catalog", "show", "nested"])).printed[0]).toMatchObject({
      item: { id: "nested", kind: "folder" },
    })
  })

  it("an old local copy says so and names the sync step", async () => {
    const cli = await reference()
    await cli.run(["sync"])
    const shown = (await cli.run(["documents", "show", "a"])).printed[0] as Body & { missing?: unknown }
    expect(shown).toMatchObject({ meta: { complete: false }, missing: [{ field: "synced_at", step: "sync.run" }] })
  })
})

describe("catalog tree", () => {
  const entry = (id: string, parents: string[], kind: CatalogEntry["kind"] = "folder") =>
    ({
      externalId: `${id}.md`,
      ref: `document:${id}`,
      name: id,
      kind,
      parents: parents.map((p) => `${p}.md`),
    }) as CatalogEntry
  const over = (entries: CatalogEntry[]): CatalogTreeSource => ({
    get: async (externalId) => entries.find((one) => one.externalId === externalId),
    children: async (externalId, { limit, offset }) => {
      const found = entries.filter((one) => one.parents.includes(externalId))
      return { items: found.slice(offset, offset + limit), hasMore: found.length > offset + limit }
    },
  })
  const fileRows = (count: number, parent: string) =>
    Array.from({ length: count }, (_, i) => ({
      externalId: `${parent}-${i}.md`,
      name: `${parent}-${i}`,
      parents: [`${parent}.md`],
      kind: "file" as const,
      url: `https://example.invalid/${parent}-${i}`,
    }))
  const upsert = async (
    cli: Awaited<ReturnType<typeof reference>>,
    rows: Parameters<MessageStore["catalog"]["upsert"]>[1],
  ) => {
    const collection = must(await cli.collection())
    for (let start = 0; start < rows.length; start += 200)
      await cli.store.catalog.upsert(collection, rows.slice(start, start + 200))
    return collection
  }

  it("walks the chosen folders to the depth, marks the branches it cut and refuses cycles, gaps and bad depths", async () => {
    const tree = await catalogTree(
      over([entry("root", []), entry("a", ["root"]), entry("b", ["root"], "file"), entry("c", ["a"])]),
      ["root.md"],
      1,
    )
    expect(tree[0]?.children.map((child) => [child.item.id, child.truncated])).toEqual([
      ["a", true],
      ["b", false],
    ])
    await expect(catalogTree(over([entry("root", ["a"]), entry("a", ["root"])]), ["root.md"], 5)).rejects.toThrow(
      "cycle",
    )
    await expect(catalogTree(over([]), ["absent.md"], 5)).rejects.toMatchObject({
      details: { reason: "catalog.not-found" },
    })
    await expect(catalogTree(over([entry("leaf", [], "file")]), ["leaf.md"], 5)).rejects.toMatchObject({
      details: { reason: "catalog.not-found" },
    })
    await expect(catalogTree(over([]), [], 51)).rejects.toMatchObject({ details: { reason: "catalog.depth-invalid" } })
  })

  it("takes a page with sub-pages as a root, whatever its kind", async () => {
    const tree = await catalogTree(
      over([entry("page", [], "file"), entry("sub", ["page"], "file"), entry("subsub", ["sub"], "file")]),
      ["page.md"],
      5,
    )
    expect(tree[0]?.children[0]?.item.id).toBe("sub")
    expect(tree[0]?.children[0]?.children[0]?.item.id).toBe("subsub")
  })

  it("shows an entry in two folders once in full and marks the second place as a repeat", async () => {
    const tree = await catalogTree(
      over([
        entry("root", []),
        entry("x", ["root"]),
        entry("y", ["root"]),
        entry("shared", ["x", "y"]),
        entry("deep", ["shared"], "file"),
      ]),
      ["root.md"],
      5,
    )
    const [x, y] = tree[0]?.children ?? []
    expect(x?.children[0]).toMatchObject({ item: { id: "shared" }, children: [{ item: { id: "deep" } }] })
    expect(y?.children[0]).toMatchObject({ item: { id: "shared" }, children: [], repeated: true })
  })

  it("refuses a tree over its entry limit and names how to narrow it", async () => {
    await expect(
      catalogTree(
        over([entry("root", []), entry("a", ["root"]), entry("b", ["root"]), entry("c", ["root"])]),
        ["root.md"],
        1,
        3,
      ),
    ).rejects.toMatchObject({
      message: expect.stringMatching(/smaller FOLDER or lower --depth/),
      details: { reason: "catalog.tree-limit" },
    })
  })

  it("reads only the folder it shows out of an account of 12 000 entries", async () => {
    const cli = await reference()
    await cli.run(["sync"])
    const collection = await upsert(cli, [
      ...fileRows(12_000, "big"),
      { externalId: "big.md", name: "big", parents: [], kind: "folder" },
      { externalId: "small.md", name: "small", parents: [], kind: "folder" },
      ...fileRows(3, "small"),
    ])
    let read = 0
    const source = catalogSource(
      {
        get: (_principal, id) => cli.store.catalog.get(collection, `${id}.md`),
        list: async (_principal, query) => {
          const page = await cli.store.catalog.list(collection, { ...query, parent: `${must(query?.parent)}.md` })
          read += page.items.length
          return page
        },
      },
      PRINCIPAL,
    )
    const tree = await catalogTree(source, ["small.md"], 5)
    expect(tree[0]?.children.map((child) => child.item.id)).toEqual(["small-0", "small-1", "small-2"])
    expect(read).toBe(3)
  })

  it("answers catalog.tree-limit for a folder of 12 000 files, which the store now holds", async () => {
    const cli = await reference()
    await cli.run(["sync"])
    await upsert(cli, [
      ...fileRows(12_000, "root"),
      { externalId: "root.md", name: "root", parents: [], kind: "folder" },
    ])
    const answer = await cli.run(["catalog", "tree", "--depth", "1"])
    expect(answer.error).toMatchObject({ details: { reason: "catalog.tree-limit" } })
    expect((await cli.run(["catalog", "tree", "--depth", "0"])).error).toBeUndefined()
  })

  it("marks a cut branch whatever its id holds, asking about the cut branches together", async () => {
    const cli = await reference()
    await cli.run(["sync"])
    const odd = 'é "odd" (id):*'
    await upsert(cli, [
      { externalId: "top.md", name: "top", parents: [], kind: "folder" },
      { externalId: `${odd}.md`, name: "odd", parents: ["top.md"], kind: "file" },
      { externalId: "plain.md", name: "plain", parents: ["top.md"], kind: "folder" },
      { externalId: "below.md", name: "below", parents: [`${odd}.md`], kind: "file" },
    ])
    const answer = await cli.run(["catalog", "tree", "top", "--depth", "1"])
    const children = (answer.printed[0] as { items: { children: { item: { id: string }; truncated: boolean }[] }[] })
      .items[0]?.children
    expect(children?.map((child) => [child.item.id, child.truncated])).toEqual([
      ["plain", false],
      [odd, true],
    ])
  })
})
