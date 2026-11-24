import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CliError, isCliError } from "@wirecat/cli-base"
import { describe, expect, it } from "vitest"
import { runBudget } from "../../background/budget.js"
import type { DocumentSource, SourceChange, SourceFile, SourceState, SourceWalk } from "../../documents/model.js"
import { openStore } from "../../store/index.js"
import { searchNotesQuery } from "../notes-search.js"
import { documentIngestion } from "./ingestion.js"
import type { SyncOptions } from "./ports.js"
import { type SyncResult, syncDocuments } from "./sync.js"

/**
 * A synthetic page tree: every page holds sub-pages, so every node is a folder
 * and a document, as a Notion workspace is.
 */
const page = (id: string, parent: string | undefined, version = "1"): SourceFile => ({
  id,
  name: id,
  parents: parent ? [parent] : [],
  mime: "application/x-page",
  url: `https://example.invalid/${id}`,
  trashed: false,
  canDownload: true,
  version,
})

/** `hubs` pages under the root, each with `sections` sections of `leaves` pages. */
const pageTree = (hubs: number, sections: number, leaves: number) => {
  const nodes = new Map<string, SourceFile>([["root", page("root", undefined)]])
  for (let h = 0; h < hubs; h++) {
    nodes.set(`h${h}`, page(`h${h}`, "root"))
    for (let s = 0; s < sections; s++) {
      nodes.set(`h${h}s${s}`, page(`h${h}s${s}`, `h${h}`))
      for (let l = 0; l < leaves; l++) nodes.set(`h${h}s${s}l${l}`, page(`h${h}s${s}l${l}`, `h${h}s${s}`))
    }
  }
  return nodes
}

/**
 * Keeps only the fields the engine's types name, as a CLI that validates its state files with a strict schema does
 * (drive's valibot `v.object`): a field the engine added on top would be lost on the next read.
 */
const strictWalk = (walk: SourceWalk): SourceWalk => ({
  scope: walk.scope,
  cursor: walk.cursor,
  stack: walk.stack.map(({ id, ancestry, folder, listing }) => ({
    id,
    ancestry,
    ...(folder ? { folder } : {}),
    ...(listing ? { listing } : {}),
  })),
  visited: walk.visited,
  folders: walk.folders,
  files: walk.files,
  discovered: walk.discovered,
  ...(walk.deleted ? { deleted: walk.deleted } : {}),
})

const treeSync = (nodes: Map<string, SourceFile>) => {
  const byParent = () => {
    const children = new Map<string, SourceFile[]>()
    for (const node of nodes.values())
      for (const parent of node.parents) children.set(parent, [...(children.get(parent) ?? []), node])
    return children
  }
  let index = byParent()
  let changes: SourceChange[] = []
  let state: SourceState = { version: 1, principal: "alpha", scope: "", folders: {}, documents: {}, skipped: [] }
  let walk: SourceWalk | undefined
  const listed: string[] = []
  const removed: string[] = []
  const flaky = new Set<string>()
  const source: DocumentSource = {
    identity: async () => "alpha",
    metadata: async (id) => {
      const node = nodes.get(id)
      if (!node) throw new CliError("not_found", "object_not_found")
      return node
    },
    children: async (id) => {
      // As Notion answers a page deleted or unshared since it was found, or a listing that fails once.
      if (!nodes.has(id) || flaky.delete(id)) throw new CliError("not_found", "object_not_found")
      listed.push(id)
      return index.get(id) ?? []
    },
    startToken: async () => "start",
    changes: async (cursor) => {
      const items = changes
      changes = []
      return { items, cursor: `${cursor}+` }
    },
    content: async (id) => ({
      metadata: nodes.get(id) as SourceFile,
      text: `words of ${id} ${nodes.get(id)?.version}`,
      markdown: "",
      tabs: [],
    }),
    bytes: async () => new Uint8Array(),
  }
  const options: SyncOptions<SourceFile> = {
    source,
    index: {
      save: async (_principal, content) => content.metadata.id,
      remove: async (_principal, id) => {
        removed.push(id)
      },
      openPictures: async () => {
        throw new Error("no pictures")
      },
    },
    principal: "alpha",
    roots: ["root"],
    textLimit: 200_000,
    max: 1_000_000,
    maxEntries: 10_000,
    storeVersion: "tree-1",
    isFolder: () => true,
    isDocument: () => true,
    skipReason: () => undefined,
    retryable: () => false,
    errorOf: (error) => (isCliError(error) ? error : new CliError("provider_error", "synthetic failure")),
    assertHeld: () => {},
    state: {
      read: () => structuredClone(state),
      // Kept as given, not copied: a copy of 25 000 documents at every saved batch would be most of the test's time.
      save: (next) => {
        state = next
      },
      readWalk: (scope) => (walk?.scope === scope ? structuredClone(walk) : undefined),
      saveWalk: (next) => {
        walk = strictWalk(structuredClone(next))
      },
      removeWalk: () => {
        walk = undefined
      },
      saveSnapshot: () => {},
      removeSnapshot: () => {},
    },
  }
  return {
    options,
    listed,
    removed,
    state: () => state,
    walk: () => walk,
    /** Changes a node and names it in the next change feed, as the source would. */
    change: (...files: SourceFile[]) => {
      for (const file of files) nodes.set(file.id, file)
      index = byParent()
      changes = files.map((file) => ({ id: file.id, removed: false, file }))
    },
    /** The next listing of each of these answers 404 once, though the folder is still there. */
    failOnce: (...ids: string[]) => {
      for (const id of ids) flaky.add(id)
    },
    /** Deletes nodes the feed does not name yet. */
    remove: (...ids: string[]) => {
      for (const id of ids) nodes.delete(id)
      index = byParent()
    },
    /** Adds nodes the feed does not name, such as the sub-pages of a page moved in from outside the scope. */
    add: (...files: SourceFile[]) => {
      for (const file of files) nodes.set(file.id, file)
      index = byParent()
    },
  }
}

/** The tree's source, listing a folder `size` children a page at a time; `pages` names each page asked for. */
const paged = (tree: ReturnType<typeof treeSync>, size: number) => {
  const pages: string[] = []
  const stale = new Set<string>()
  const base = tree.options.source as DocumentSource
  const source: DocumentSource = {
    ...base,
    childrenPage: async (id, cursor) => {
      pages.push(`${id}@${cursor ?? 0}`)
      if (cursor !== undefined && stale.delete(id)) throw new CliError("not_found", "object_not_found")
      const all = await base.children(id)
      const from = Number(cursor ?? 0)
      const end = from + size
      return { files: all.slice(from, end), ...(end < all.length ? { cursor: String(end) } : {}) }
    },
  }
  /** The next later page of each of these answers 404 once, as a cursor the provider dropped does. */
  const expire = (...ids: string[]) => {
    for (const id of ids) stale.add(id)
  }
  return { source, pages, expire }
}

const requests = (most: number) => {
  let left = most
  return { take: () => (left-- > 0 ? null : ("requests" as const)) }
}

const untilComplete = async (sync: () => Promise<SyncResult>, most = 100) => {
  const runs: SyncResult[] = []
  for (let run = 0; run < most; run++) {
    runs.push(await sync())
    if (runs.at(-1)?.complete) return runs
  }
  throw new Error("the sync never completed")
}

describe("a sync of a tree larger than one call's bound", () => {
  it("walks 25 000 pages over several calls with no total ceiling, listing each page once", async () => {
    const nodes = pageTree(50, 10, 49)
    const tree = treeSync(nodes)
    const options = { ...tree.options, maxEntries: 2_000, max: 5_000 }
    const runs = await untilComplete(() => syncDocuments(options))
    expect(nodes.size).toBe(25_051)
    expect(runs.length).toBeGreaterThan(10)
    for (const run of runs.slice(0, -1)) expect(run.complete).toBe(false)
    expect(runs.filter((run) => run.stopped === "entries").length).toBeGreaterThan(10)
    expect(runs.reduce((sum, run) => sum + run.saved, 0)).toBe(25_051)
    expect(tree.listed).toHaveLength(25_051)
    expect(new Set(tree.listed).size).toBe(25_051)
    expect(Object.keys(tree.state().documents)).toHaveLength(25_051)
    expect(tree.state().cursor).toBe("start")
    expect(tree.walk()).toBeUndefined()

    // An edit to a hub with 500 pages below it lists only its own children; the feed names the pages that changed.
    tree.listed.length = 0
    tree.change(page("h7", "root", "2"), page("h7s3l5", "h7s3", "2"))
    expect(await syncDocuments(options)).toMatchObject({ complete: true, saved: 2, removed: 0 })
    expect(tree.listed).toEqual(["h7", "h7s3l5"])

    // A page moved in from outside the scope is new here: it and every page below it are walked.
    tree.listed.length = 0
    const moved = [page("away", "root", "2")]
    for (let i = 0; i < 30; i++) moved.push(page(`away${i}`, "away"))
    tree.add(...moved.slice(1))
    tree.change(moved[0] as SourceFile)
    expect(await syncDocuments(options)).toMatchObject({ complete: true, saved: 31 })
    expect(tree.listed).toHaveLength(31)
  }, 60_000)

  it("goes on with a round of changes a call cut short, though the walk file keeps only the engine's fields", async () => {
    const tree = treeSync(pageTree(1, 2, 3))
    await untilComplete(() => syncDocuments(tree.options))
    const moved = [page("away", "root", "2")]
    for (let i = 0; i < 6; i++) moved.push(page(`away${i}`, "away"), page(`away${i}x`, `away${i}`))
    tree.add(...moved.slice(1))
    tree.change(moved[0] as SourceFile)
    tree.listed.length = 0
    const runs = await untilComplete(() => syncDocuments({ ...tree.options, maxEntries: 4 }))
    expect(runs.length).toBeGreaterThan(1)
    expect(Object.keys(tree.state().documents)).toEqual(expect.arrayContaining(moved.map(({ id }) => id)))
    expect(new Set(tree.listed).size).toBe(tree.listed.length)
    expect(tree.state().cursor).toBe("start+")
  })

  it("keeps a rescan going over the next syncs, and a second --rescan starts it over", async () => {
    const tree = treeSync(pageTree(4, 3, 3))
    await untilComplete(() => syncDocuments(tree.options))
    tree.listed.length = 0
    const options = { ...tree.options, maxEntries: 10 }
    expect(await syncDocuments({ ...options, rescan: true })).toMatchObject({ complete: false })
    expect(tree.state().cursor).toBeUndefined()
    expect(await syncDocuments(options)).toMatchObject({ complete: false })
    const walked = tree.listed.length
    tree.listed.length = 0
    expect(await syncDocuments({ ...options, rescan: true })).toMatchObject({ complete: false })
    await untilComplete(() => syncDocuments(options))
    expect(walked).toBeGreaterThan(0)
    expect(tree.listed).toHaveLength(53)
    expect(new Set(tree.listed).size).toBe(53)
    expect(tree.state().cursor).toBe("start")
  })

  it("drops a page deleted while it waits on the saved walk, and goes on with the rest", async () => {
    const nodes = pageTree(2, 2, 2)
    const tree = treeSync(nodes)
    expect(await syncDocuments({ ...tree.options, maxEntries: 3 })).toMatchObject({ complete: false })
    const gone = tree.walk()?.stack.at(-1)?.id as string
    tree.remove(...[...nodes.keys()].filter((id) => id.startsWith(gone)))
    const runs = await untilComplete(() => syncDocuments({ ...tree.options, maxEntries: 3 }))
    expect(runs.at(-1)).toMatchObject({ complete: true, errors: [] })
    expect(Object.keys(tree.state().documents)).toEqual(expect.arrayContaining([...nodes.keys()]))
    expect(Object.keys(tree.state().documents)).not.toContain(gone)
  })

  it("drops a page deleted under a known one in a round of changes, with what was below it", async () => {
    const nodes = pageTree(1, 2, 3)
    const tree = treeSync(nodes)
    await untilComplete(() => syncDocuments(tree.options))
    const moved = [page("away", "root", "2"), page("away0", "away"), page("away1", "away")]
    tree.add(...moved.slice(1))
    tree.change(moved[0] as SourceFile)
    expect(await syncDocuments({ ...tree.options, maxEntries: 2 })).toMatchObject({ complete: false })
    tree.remove("away1")
    await untilComplete(() => syncDocuments({ ...tree.options, maxEntries: 2 }))
    expect(tree.state().documents.away0).toBeDefined()
    expect(tree.state().documents.away1).toBeUndefined()
  })

  it("keeps a held folder whose listing answers 404 once in a round of changes, and lists it again next time", async () => {
    const tree = treeSync(pageTree(1, 2, 3))
    await untilComplete(() => syncDocuments(tree.options))
    tree.change(page("h0s0", "h0", "2"))
    tree.failOnce("h0s0")
    await expect(syncDocuments(tree.options)).rejects.toThrow("object_not_found")
    expect(await syncDocuments(tree.options)).toMatchObject({ complete: true, removed: 0 })
    expect(Object.keys(tree.state().documents)).toHaveLength(10)
  })

  it("keeps a folder whose listing answers 404 once in a first pass, and walks it in the next sync", async () => {
    const tree = treeSync(pageTree(1, 2, 3))
    tree.failOnce("h0s1")
    await expect(syncDocuments(tree.options)).rejects.toThrow("object_not_found")
    await untilComplete(() => syncDocuments(tree.options))
    expect(Object.keys(tree.state().documents)).toEqual(expect.arrayContaining(["h0s1", "h0s1l0", "h0s0l0"]))
    expect(Object.keys(tree.state().documents)).toHaveLength(10)
  })

  it("drops a folder the source has trashed when its listing answers 404", async () => {
    const tree = treeSync(pageTree(1, 2, 3))
    await untilComplete(() => syncDocuments(tree.options))
    tree.change(page("h0", "root", "2"))
    tree.add({ ...page("h0s0", "h0"), trashed: true })
    tree.failOnce("h0s0")
    await untilComplete(() => syncDocuments({ ...tree.options, rescan: true }))
    expect(Object.keys(tree.state().documents)).not.toContain("h0s0l0")
    expect(Object.keys(tree.state().documents)).toContain("h0s1l0")
  })

  it("saves a dropped batch at once, so a walk cut short does not remove its files again", async () => {
    const tree = treeSync(pageTree(2, 3, 3))
    await syncDocuments({ ...tree.options, max: 2 })
    expect(tree.state().pending?.jobs.length).toBeGreaterThan(10)
    tree.removed.length = 0
    const options = { ...tree.options, roots: ["h0"], maxEntries: 3 }
    expect(await syncDocuments(options)).toMatchObject({ complete: false })
    const once = tree.removed.length
    expect(once).toBeGreaterThan(10)
    await syncDocuments(options)
    await syncDocuments(options)
    expect(tree.removed).toHaveLength(once)
  })

  it("finds a file in a held sub-folder only when the feed names that folder too", async () => {
    const tree = treeSync(pageTree(1, 2, 3))
    await untilComplete(() => syncDocuments(tree.options))
    tree.add(page("hidden", "h0s0"))
    tree.change(page("h0", "root", "2"))
    await syncDocuments(tree.options)
    expect(tree.state().documents.hidden).toBeUndefined()
    tree.change(page("h0s0", "h0", "2"))
    await syncDocuments(tree.options)
    expect(tree.state().documents.hidden).toBeDefined()
  })

  it("does not index words after a stop or past the run's deadline", async () => {
    const tree = treeSync(pageTree(1, 1, 1))
    const settled: boolean[] = []
    const index = {
      ...tree.options.index,
      settle: async ({ until }: { until: () => boolean }) => {
        settled.push(until())
      },
    }
    let left = 4
    const budget = {
      take: () => (left-- > 0 ? null : ("deadline" as const)),
      get stopped() {
        return left < 0 ? ("deadline" as const) : null
      },
    }
    expect(await syncDocuments({ ...tree.options, budget, index })).toMatchObject({ stopped: "deadline" })
    expect(settled).toEqual([])
    const near = { endsAt: Date.now() + 3_000, ms: 45_000 }
    expect(await syncDocuments({ ...tree.options, index, deadline: near })).toMatchObject({ complete: true })
    expect(settled).toEqual([])
    const far = { endsAt: Date.now() + 120_000, ms: 120_000 }
    await syncDocuments({ ...tree.options, index, deadline: far, rescan: true })
    expect(settled).toEqual([false])
  })

  it("makes one request in every call of a run shorter than the deadline's margin, and ends", async () => {
    const tree = treeSync(pageTree(1, 2, 2))
    const base = tree.options.source as DocumentSource
    let requests = 0
    // The start token and the root's own metadata are requests too, each in a call of its own.
    const source: DocumentSource = {
      ...base,
      startToken: () => {
        requests++
        return base.startToken()
      },
      metadata: (id) => {
        requests++
        return base.metadata(id)
      },
      children: (id) => {
        requests++
        return base.children(id)
      },
      content: (id, limit) => {
        requests++
        return base.content(id, limit)
      },
    }
    const perCall: number[] = []
    const runs = await untilComplete(async () => {
      const deadline = { endsAt: Date.now() + 3_000, ms: 3_000 }
      const before = requests
      const run = await syncDocuments({ ...tree.options, source, deadline, budget: runBudget({ deadline }) })
      perCall.push(requests - before)
      return run
    })
    expect(runs.length).toBeGreaterThan(1)
    expect(perCall.every((count) => count === 1)).toBe(true)
    expect(Object.keys(tree.state().documents)).toHaveLength(8)
    const late = { endsAt: Date.now() + 1_000, ms: 3_000 }
    const fresh = treeSync(pageTree(1, 1, 1))
    expect(
      await syncDocuments({ ...fresh.options, deadline: late, budget: runBudget({ deadline: late }) }),
    ).toMatchObject({ complete: false, stopped: "deadline", walk: { listed: 0 } })
  })

  it("lets only a call's first request past the deadline's margin: the start token, and nothing after it", async () => {
    const tree = treeSync(pageTree(0, 0, 0))
    const base = tree.options.source as DocumentSource
    let clock = 0
    const calls: string[] = []
    const source: DocumentSource = {
      ...base,
      startToken: async () => {
        calls.push("start")
        clock += 1_400
        return base.startToken()
      },
      children: async (id) => {
        calls.push("list")
        clock += 1_400
        return base.children(id)
      },
      content: async (id, limit) => {
        calls.push("read")
        clock += 3_000
        return base.content(id, limit)
      },
    }
    const deadline = { endsAt: 4_000, ms: 4_000 }
    const now = () => clock
    const result = await syncDocuments({ ...tree.options, source, now, deadline, budget: runBudget({ deadline, now }) })
    expect(calls).toEqual(["start"])
    expect(result).toMatchObject({ stopped: "deadline", complete: false })
  })

  it("judges the deadline by the budget's clock, not by a sync's fixed now", async () => {
    const late = { endsAt: Date.now() + 1_000, ms: 3_000 }
    const tree = treeSync(pageTree(1, 1, 1))
    const past = () => Date.parse("2026-01-01T00:00:00Z")
    expect(
      await syncDocuments({ ...tree.options, now: past, deadline: late, budget: runBudget({ deadline: late }) }),
    ).toMatchObject({ complete: false, stopped: "deadline", walk: { listed: 0 } })
  })

  it("stops a walk at the next folder once the run is cancelled, with no budget, and goes on in the next call", async () => {
    const tree = treeSync(pageTree(2, 2, 2))
    const stop = new AbortController()
    const children = tree.options.source?.children as (id: string) => Promise<SourceFile[]>
    const source = {
      ...(tree.options.source as DocumentSource),
      children: async (id: string) => {
        if (tree.listed.length === 2) stop.abort()
        return children(id)
      },
    }
    expect(await syncDocuments({ ...tree.options, source, signal: stop.signal })).toMatchObject({
      complete: false,
      stopped: "cancelled",
      walk: { listed: 3 },
    })
    expect(await syncDocuments(tree.options)).toMatchObject({ complete: true, saved: 15 })
    expect(new Set(tree.listed).size).toBe(15)
  })

  it("lists a folder a page per step and goes on mid-folder in the next call, each page once and no file lost", async () => {
    const tree = treeSync(pageTree(1, 3, 30))
    const { source, pages } = paged(tree, 7)
    // Six: the start token and the root's metadata take one each beside the four listings.
    const first = await syncDocuments({ ...tree.options, source, budget: requests(6) })
    expect(first).toMatchObject({ complete: false, stopped: "requests", walk: { listed: 4 } })
    expect(tree.walk()?.stack.at(-1)).toMatchObject({ id: "h0s0", listing: "14" })
    const runs = await untilComplete(() => syncDocuments({ ...tree.options, source, budget: requests(4) }))
    expect([first, ...runs].reduce((sum, run) => sum + (run.saved ?? 0), 0)).toBe(95)
    expect(Object.keys(tree.state().documents)).toHaveLength(95)
    expect(new Set(pages).size).toBe(pages.length)
    expect(pages.filter((name) => name.startsWith("h0s1@"))).toEqual([
      "h0s1@0",
      "h0s1@7",
      "h0s1@14",
      "h0s1@21",
      "h0s1@28",
    ])
  })

  it("lists a folder again from its first page when a later page answers 404, and drops nothing", async () => {
    const tree = treeSync(pageTree(1, 1, 20))
    const { source, pages, expire } = paged(tree, 7)
    expire("h0s0")
    const runs = await untilComplete(() => syncDocuments({ ...tree.options, source, budget: requests(3) }))
    expect(runs.at(-1)?.removed ?? 0).toBe(0)
    expect(Object.keys(tree.state().documents)).toHaveLength(23)
    expect(pages.filter((name) => name.startsWith("h0s0@"))).toEqual([
      "h0s0@0",
      "h0s0@7",
      "h0s0@0",
      "h0s0@7",
      "h0s0@14",
    ])
  })

  it("skips a page the sign-in may not read, as a gone one, so the pass completes and the next sync reads changes", async () => {
    const tree = treeSync(pageTree(1, 1, 2))
    const base = tree.options.source as DocumentSource
    const source: DocumentSource = {
      ...base,
      content: (id, limit) =>
        id === "h0s0l1"
          ? Promise.reject(new CliError("permission_error", "restricted_resource"))
          : base.content(id, limit),
    }
    const first = await syncDocuments({ ...tree.options, source })
    expect(first).toMatchObject({
      complete: true,
      pending: 0,
      skipped: [{ id: "h0s0l1", reason: "restricted_resource" }],
    })
    expect(tree.state().cursor).toBe("start")
    tree.change(page("h0s0l0", "h0s0", "2"))
    expect(await syncDocuments({ ...tree.options, source })).toMatchObject({ complete: true, saved: 1 })
  })

  it("takes the start token and the root's metadata from the budget, so a 45 s run of slow reads ends with time left", async () => {
    const tree = treeSync(pageTree(2, 2, 2))
    const base = tree.options.source as DocumentSource
    let clock = 0
    const slow =
      <A extends unknown[], R>(read: (...args: A) => Promise<R>) =>
      (...args: A) => {
        clock += 15_000
        return read(...args)
      }
    const source: DocumentSource = {
      ...base,
      startToken: slow(base.startToken),
      metadata: slow(base.metadata),
      children: slow(base.children),
      content: slow(base.content),
    }
    const now = () => clock
    for (let run = 0; run < 100; run++) {
      const deadline = { endsAt: clock + 45_000, ms: 45_000 }
      const result = await syncDocuments({
        ...tree.options,
        source,
        now,
        deadline,
        budget: runBudget({ deadline, now }),
      })
      expect(clock).toBeLessThan(deadline.endsAt)
      if (result.complete) return
    }
    throw new Error("the sync never completed")
  })

  it("stops when its request budget says so and goes on in the next call", async () => {
    const tree = treeSync(pageTree(2, 2, 2))
    let left = 5
    const budget = { take: () => (left-- > 0 ? null : ("requests" as const)) }
    expect(await syncDocuments({ ...tree.options, budget })).toMatchObject({
      complete: false,
      stopped: "requests",
      walk: { listed: 3 },
    })
    expect(await syncDocuments(tree.options)).toMatchObject({ complete: true, saved: 15 })
    expect(tree.listed).toHaveLength(15)
  })

  it("indexes the saved text, so a reader that cannot write finds it by its words", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "sync-settle-")), "store.db")
    const store = await openStore({ path })
    const tree = treeSync(pageTree(1, 1, 1))
    const ingest = documentIngestion(store, {
      collectionName: (account) => `tree:${account}`,
      externalId: (id) => `${id}.md`,
      catalogInput: (item: SourceFile) => ({ externalId: `${item.id}.md`, name: item.name, parents: [], kind: "file" }),
      frontMatter: () => ({ source: "tree" }),
    })
    await syncDocuments({ ...tree.options, index: { ...ingest, openPictures: tree.options.index.openPictures } })
    const folder = (await ingest.collection("alpha", false))?.id as string
    await store.close()
    const reader = await openStore({ path, readOnly: true })
    try {
      expect(await reader.notes.indexWritten()).toBe(0)
      const found = await searchNotesQuery(reader, { text: "words", limit: 10, timezone: "UTC", folderIds: [folder] })
      expect(found.items).toHaveLength(4)
    } finally {
      await reader.close()
    }
  })
})

describe("a sync of a source that lists folders in parallel", () => {
  /** The tree's source with `width` listings at once; `most` is the most it saw in flight. */
  const parallel = (tree: ReturnType<typeof treeSync>, width: number, failing = new Set<string>()) => {
    const base = tree.options.source as DocumentSource
    let flying = 0
    const seen = { most: 0 }
    const source: DocumentSource = {
      ...base,
      parallelListings: width,
      children: async (id) => {
        flying++
        seen.most = Math.max(seen.most, flying)
        try {
          await new Promise((resolve) => setTimeout(resolve, 1))
          if (failing.delete(id)) throw new CliError("provider_error", "synthetic outage")
          return await base.children(id)
        } finally {
          flying--
        }
      },
    }
    return { source, seen }
  }

  it("lists up to that many folders at once and saves what a walk one folder at a time saves", async () => {
    const one = treeSync(pageTree(5, 3, 4))
    await syncDocuments(one.options)
    const tree = treeSync(pageTree(5, 3, 4))
    const { source, seen } = parallel(tree, 4)
    expect(await syncDocuments({ ...tree.options, source })).toMatchObject({ complete: true, removed: 0 })
    expect(seen.most).toBe(4)
    expect(Object.keys(tree.state().documents).sort()).toEqual(Object.keys(one.state().documents).sort())
    expect(new Set(tree.listed).size).toBe(tree.listed.length)
    expect(tree.listed).toHaveLength(one.listed.length)
  })

  it("goes on from a batch its budget cut short, each folder listed once and nothing removed", async () => {
    const tree = treeSync(pageTree(4, 4, 3))
    const { source } = parallel(tree, 4)
    const runs = await untilComplete(() => syncDocuments({ ...tree.options, source, budget: requests(3) }))
    expect(runs.length).toBeGreaterThan(2)
    expect(Object.keys(tree.state().documents)).toHaveLength(1 + 4 + 16 + 48)
    expect(new Set(tree.listed).size).toBe(tree.listed.length)
    expect(tree.removed).toEqual([])
  })

  it("lists one folder at a time when the number is not a whole one above one", async () => {
    for (const width of [Number.NaN, 0, 2.5, Number.POSITIVE_INFINITY]) {
      const tree = treeSync(pageTree(3, 1, 1))
      const { source, seen } = parallel(tree, width)
      expect(await syncDocuments({ ...tree.options, source })).toMatchObject({ complete: true, removed: 0 })
      expect(seen.most).toBe(1)
      expect(Object.keys(tree.state().documents)).toHaveLength(1 + 3 + 3 + 3)
    }
  })

  it("keeps the batch's other listings when one fails, and lists only the failed folder again", async () => {
    const tree = treeSync(pageTree(4, 2, 2))
    const { source } = parallel(tree, 4, new Set(["h2"]))
    await expect(syncDocuments({ ...tree.options, source })).rejects.toMatchObject({ code: "provider_error" })
    expect(tree.walk()?.visited).toEqual(expect.arrayContaining(["root", "h0", "h1", "h3"]))
    expect(tree.walk()?.visited).not.toContain("h2")
    expect(await syncDocuments({ ...tree.options, source })).toMatchObject({ complete: true, removed: 0 })
    expect(Object.keys(tree.state().documents)).toHaveLength(1 + 4 + 8 + 16)
    expect(new Set(tree.listed).size).toBe(tree.listed.length)
  })
})

describe("a source that asks for a full walk every so often", () => {
  const DAY = 24 * 60 * 60 * 1000
  const START = Date.parse("2026-11-01T00:00:00Z")
  const setUp = (rescanEveryMs?: number) => {
    const tree = treeSync(pageTree(3, 2, 2))
    let clock = START
    const options: SyncOptions<SourceFile> = {
      ...tree.options,
      source: { ...(tree.options.source as DocumentSource), ...(rescanEveryMs ? { rescanEveryMs } : {}) },
      now: () => clock,
    }
    return {
      tree,
      options,
      at: (ms: number) => {
        clock = ms
      },
      /** A page back from the trash: the provider names it in no change and no deletion. */
      restore: () => tree.add(page("back", "root")),
    }
  }

  it("walks in full once the time has passed, over several calls, and brings back what the feed missed", async () => {
    const { tree, options, at, restore } = setUp(7 * DAY)
    await untilComplete(() => syncDocuments(options))
    expect(tree.state().fullWalkAt).toBe(new Date(START).toISOString())
    restore()
    at(START + 6 * DAY)
    expect(await syncDocuments(options)).not.toHaveProperty("rescan")
    expect(tree.state().documents.back).toBeUndefined()

    at(START + 7 * DAY)
    const small = { ...options, maxEntries: 4 }
    const first = await syncDocuments(small)
    expect(first).toMatchObject({
      complete: false,
      rescan: { every_ms: 7 * DAY, last_full_walk: new Date(START).toISOString() },
    })
    expect(first.rescan?.why).toContain("7 days or more ago")
    tree.listed.length = 0
    const second = await syncDocuments(small)
    expect(second).not.toHaveProperty("rescan")
    expect(second.walk?.entries).toBeGreaterThan(first.walk?.entries ?? 0)
    at(START + 7 * DAY + 60_000)
    const rest = await untilComplete(() => syncDocuments(small))
    expect(rest.some((run) => run.rescan)).toBe(false)
    expect(new Set(tree.listed).size).toBe(tree.listed.length)
    expect(tree.state().documents.back).toBeDefined()
    expect(tree.state().fullWalkAt).toBe(new Date(START + 7 * DAY + 60_000).toISOString())

    tree.listed.length = 0
    at(START + 8 * DAY)
    expect(await syncDocuments(options)).not.toHaveProperty("rescan")
  })

  it("walks in full on the first plain sync of a profile synced before the time was recorded", async () => {
    const { tree, options, at, restore } = setUp(7 * DAY)
    await untilComplete(() => syncDocuments(options))
    delete tree.state().fullWalkAt
    restore()
    at(START + DAY)
    const runs = await untilComplete(() => syncDocuments(options))
    expect(runs[0]?.rescan).toMatchObject({ last_full_walk: null })
    expect(runs[0]?.rescan?.why).toContain("no full walk")
    expect(tree.state().documents.back).toBeDefined()
  })

  it("walks in full when the recorded walk is later than now, and refuses a period that is not positive", async () => {
    const { tree, options, at } = setUp(7 * DAY)
    await untilComplete(() => syncDocuments(options))
    at(START - DAY)
    expect((await untilComplete(() => syncDocuments(options)))[0]).toHaveProperty("rescan")
    expect(tree.state().fullWalkAt).toBe(new Date(START - DAY).toISOString())
    const broken = { ...options, source: { ...(options.source as DocumentSource), rescanEveryMs: 0 } }
    await expect(syncDocuments(broken)).rejects.toThrow(/rescanEveryMs must be a positive whole number/)
  })

  it("leaves a source without the setting to its feed, however long ago it walked", async () => {
    const { tree, options, at, restore } = setUp()
    await untilComplete(() => syncDocuments(options))
    restore()
    at(START + 365 * DAY)
    tree.listed.length = 0
    expect(await syncDocuments(options)).not.toHaveProperty("rescan")
    expect(tree.state().documents.back).toBeUndefined()
    expect(tree.state().cursor).toBe("start+")
  })

  it("does not count --rescan as due, and records the walk it finishes", async () => {
    const { tree, options, at } = setUp(7 * DAY)
    await untilComplete(() => syncDocuments(options))
    at(START + 30 * DAY)
    const runs = await untilComplete(() => syncDocuments({ ...options, rescan: true }))
    expect(runs.some((run) => run.rescan)).toBe(false)
    expect(tree.state().fullWalkAt).toBe(new Date(START + 30 * DAY).toISOString())
  })
})
