import { CliError } from "@wirecat/cli-base"
import { describe, expect, it } from "vitest"
import type { ApiCommandInput } from "../../bot/api.js"
import type { ServiceApiManifest } from "../../service-api-manifest.js"
import { documentSourceContract } from "../testing/index.js"
import { parseDocumentManifest } from "./manifest.js"
import { documentSourceFromManifest } from "./source.js"

interface Row {
  id: string
  title: string
  parent: string | null
  kind: "folder" | "page"
  edited: string
  trashed?: boolean
  text?: string
}

const operation = (id: string, effect = "read", pagination?: unknown) => ({ id, command: id, effect, pagination })
const api = {
  operations: [
    operation("get-self"),
    operation("get-item"),
    operation("list-children", "read", {
      style: "cursor",
      cursor: { in: "query", name: "cursor" },
      next: "next_cursor",
      hasMore: "has_more",
      items: "results",
    }),
    operation("search-edited", "read", {
      style: "cursor",
      cursor: { in: "body", name: "start" },
      next: "next_cursor",
      hasMore: "has_more",
      items: "results",
    }),
    operation("get-markdown"),
    operation("list-deleted", "read", {
      style: "cursor",
      cursor: { in: "body", name: "after" },
      next: "next_cursor",
      hasMore: "has_more",
      items: "results",
    }),
    operation("delete-item", "delete"),
  ],
} as unknown as ServiceApiManifest

const MAP = {
  id: "id",
  name: "title",
  parent: "parent",
  modifiedAt: "edited",
  trashed: "trashed",
  url: "url",
  folder: { path: "kind", is: "folder", mime: { folder: "inode/directory", file: "text/markdown" } },
}
const MANIFEST = {
  provider: "pages",
  identity: { operation: "get-self", id: ["workspace.id", "user.id"] },
  get: { operation: "get-item", path: { id: "{id}" }, map: MAP },
  children: { operation: "list-children", path: { id: "{id}" }, query: { size: 2 } },
  changes: { operation: "search-edited", body: { since: "{since}" }, since: "iso", time: "edited", overlapMs: 0 },
  content: { operation: "get-markdown", path: { id: "{id}" }, markdown: "markdown" },
}

/** A pages API in memory: two answers a page, edits listed by time, 403 or 404 for a denied row. */
const pagesApi = () => {
  let clock = Date.UTC(2026, 10, 1)
  const tick = () => {
    clock += 60_000
    return new Date(clock).toISOString()
  }
  const rows = new Map<string, Row>()
  const denied = new Map<string, 403 | 404>()
  const deletions: { entity: { id: string }; at: string }[] = []
  const feed: { refuse?: CliError; refuseAfter?: number; everyTime?: boolean } = {}
  // As Linear's trash: the row is gone from every listing and its edit time stays, only the log names it.
  const erase = (id: string) => {
    rows.delete(id)
    deletions.push({ entity: { id }, at: tick() })
  }
  const put = (row: Omit<Row, "edited">) => rows.set(row.id, { ...row, edited: tick() })
  put({ id: "root", title: "Root", parent: null, kind: "folder" })
  put({ id: "nested", title: "Nested", parent: "root", kind: "folder" })
  put({ id: "deep", title: "Deep", parent: "nested", kind: "folder" })
  put({ id: "a", title: "Alpha", parent: "nested", kind: "page", text: "quarterly budget" })
  put({ id: "b", title: "Beta", parent: "root", kind: "page", text: "planning review" })
  put({ id: "c", title: "Gamma", parent: "root", kind: "page", text: "launch notes" })
  const shown = (row: Row) => ({ ...row, url: `https://pages.example/${row.id}` })
  const one = (id: unknown) => {
    const status = denied.get(String(id))
    if (status === 403) throw new CliError("permission_error", "not shared")
    const row = status === 404 ? undefined : rows.get(String(id))
    if (!row || row.trashed) throw new CliError("not_found", "no such page")
    return row
  }
  const paged = (all: Row[], start: unknown) => {
    const from = start === undefined ? 0 : Number(start)
    const end = from + 2
    return {
      results: all.slice(from, end).map(shown),
      has_more: end < all.length,
      next_cursor: end < all.length ? String(end) : null,
    }
  }
  const call = async (id: string, input: ApiCommandInput): Promise<unknown> => {
    const body = input.body ? (JSON.parse(input.body) as Record<string, unknown>) : {}
    switch (id) {
      case "get-self":
        return { workspace: { id: "w1" }, user: { id: "u1" } }
      case "get-item":
        return shown(one(input.path.id))
      case "list-children":
        one(input.path.id)
        return paged(
          [...rows.values()].filter((row) => row.parent === input.path.id && !row.trashed),
          input.query.cursor,
        )
      case "search-edited":
        return paged(
          [...rows.values()].filter((row) => Date.parse(row.edited) >= Date.parse(String(body.since))),
          body.start,
        )
      case "list-deleted":
        if (feed.refuse && Number(body.after ?? 0) >= (feed.refuseAfter ?? 0)) throw feed.refuse
        return paged(
          deletions.filter((one) => feed.everyTime || Date.parse(one.at) >= Date.parse(String(body.since))) as never,
          body.after,
        )
      case "get-markdown":
        return { markdown: `# ${one(input.path.id).title}\n\n${one(input.path.id).text ?? ""}` }
      default:
        throw new Error(`no fake for ${id}`)
    }
  }
  return { rows, denied, feed, put, erase, call, now: () => clock }
}

const DELETIONS = { operation: "list-deleted", body: { since: "{since}" }, since: "iso", time: "at", id: "entity.id" }

const sourceOver = (fake: ReturnType<typeof pagesApi>) =>
  documentSourceFromManifest(MANIFEST, { api, call: fake.call, now: fake.now })
const isFolder = (file: { mime: string }) => file.mime === "inode/directory"

describe("documents source contract over a source from a manifest", () => {
  for (const c of documentSourceContract(() => {
    const fake = pagesApi()
    const source = sourceOver(fake)
    return {
      source,
      root: "root",
      isFolder,
      missing: "gone",
      change: async () => {
        fake.put({ id: "d", title: "Delta", parent: "root", kind: "page", text: "new" })
      },
      remove: async () => {
        const row = fake.rows.get("c") as Row
        fake.rows.set("c", { ...row, trashed: true, edited: new Date(fake.now() + 60_000).toISOString() })
        return "c"
      },
      addNested: async () => {
        fake.put({ id: "e", title: "Epsilon", parent: "deep", kind: "page", text: "deep text" })
        return { file: "e", folder: "deep" }
      },
      faults: {
        deny: (status) => {
          fake.denied.set("b", status)
          return "b"
        },
        skewed: () => sourceOver(fake),
        sameToken: () => sourceOver(fake),
      },
    }
  }))
    it(c.name, c.run)
})

describe("a documents source from a manifest", () => {
  it("names the account by every identity path, pages a folder, and maps each row", async () => {
    const source = sourceOver(pagesApi())
    expect(await source.identity()).toBe("w1:u1")
    const first = await source.childrenPage?.("root")
    expect(first?.files.map((file) => file.id)).toEqual(["nested", "b"])
    expect(first?.cursor).toBe("2")
    expect((await source.children("root")).map((file) => [file.id, file.mime, file.parents])).toEqual([
      ["nested", "inode/directory", ["root"]],
      ["b", "text/markdown", ["root"]],
      ["c", "text/markdown", ["root"]],
    ])
  })

  it("lists what changed since the token, the removed as removed, and moves the token on", async () => {
    const fake = pagesApi()
    const source = sourceOver(fake)
    const token = await (source.startToken as () => Promise<string>)()
    fake.put({ id: "d", title: "Delta", parent: "root", kind: "page" })
    fake.rows.set("b", { ...(fake.rows.get("b") as Row), trashed: true, edited: new Date(fake.now()).toISOString() })
    const round = await (source.changes as NonNullable<typeof source.changes>)(token)
    // The token's own minute is listed again, as an overlap of 0 still includes it.
    expect(round.items.map((item) => [item.id, item.removed])).toEqual(
      expect.arrayContaining([
        ["d", false],
        ["b", true],
      ]),
    )
    expect(round.items.map((item) => item.id)).not.toContain("a")
    expect(Number(round.cursor)).toBeGreaterThanOrEqual(Number(token))
  })

  it("asks to read a saved document again while its metadata lacks the field named", () => {
    const fake = pagesApi()
    const source = documentSourceFromManifest(
      { ...MANIFEST, reread: { missing: "authors" } },
      {
        api,
        call: fake.call,
        hooks: ({ base }) => ({ content: (...args) => (base.content as NonNullable<typeof base.content>)(...args) }),
      },
    )
    const saved = (providerMetadata: unknown) =>
      ({ metadata: { id: "a", providerMetadata }, hash: "h", reference: "r", tabs: 0 }) as never
    expect(source.reread?.(saved({}))).toBe(true)
    expect(source.reread?.(saved({ authors: "names" }))).toBe(false)
  })

  it("refuses a reread the manifest's own content could never satisfy", () => {
    expect(() =>
      documentSourceFromManifest({ ...MANIFEST, reread: { missing: "authors" } }, { api, call: pagesApi().call }),
    ).toThrow(/reread needs content from a hook/)
  })

  it("goes on from the newest row read when a round of changes runs past its pages", async () => {
    const fake = pagesApi()
    const source = sourceOver(fake)
    const token = await (source.startToken as () => Promise<string>)()
    for (let n = 0; n < 220; n++) fake.put({ id: `p${n}`, title: `P${n}`, parent: "root", kind: "page" })
    const round = await (source.changes as NonNullable<typeof source.changes>)(token)
    expect(round.items).toHaveLength(200)
    const newest = fake.rows.get(String(round.items.at(-1)?.id)) as Row
    expect(Number(round.cursor)).toBe(Date.parse(newest.edited))
    const rest = await (source.changes as NonNullable<typeof source.changes>)(round.cursor)
    expect(rest.items.map((item) => item.id)).toContain("p219")
  })

  it("asks for the account again after a failed read", async () => {
    const fake = pagesApi()
    let fail = true
    const source = documentSourceFromManifest(MANIFEST, {
      api,
      call: async (id, input) => {
        if (id === "get-self" && fail) {
          fail = false
          throw new CliError("network_error", "offline")
        }
        return fake.call(id, input)
      },
    })
    await expect(source.identity()).rejects.toThrow("offline")
    expect(await source.identity()).toBe("w1:u1")
  })

  it("lets a hook replace a method and send its own named call", async () => {
    const fake = pagesApi()
    const source = documentSourceFromManifest(
      { ...MANIFEST, reads: { self: { operation: "get-self" } } },
      {
        api,
        call: fake.call,
        hooks: ({ read, base }) => ({
          identity: async () => `hooked:${String(((await read("self")) as { user: { id: string } }).user.id)}`,
          metadata: async (id) => ({ ...(await (base.metadata as NonNullable<typeof base.metadata>)(id)), name: "X" }),
        }),
      },
    )
    expect(await source.identity()).toBe("hooked:u1")
    expect((await source.metadata("a")).name).toBe("X")
  })
})

describe("a source's deletions feed", () => {
  const withDeletions = (fake: ReturnType<typeof pagesApi>, options: Record<string, unknown> = {}) => {
    const warnings: { reason: string; message: string }[] = []
    const source = documentSourceFromManifest(
      { ...MANIFEST, deletions: DELETIONS },
      { api, call: fake.call, now: fake.now, warn: (one) => warnings.push(one), ...options },
    )
    return { source, warnings, changes: source.changes as NonNullable<typeof source.changes> }
  }

  it("removes a document the changes never name as deleted, and a later change of it wins", async () => {
    const fake = pagesApi()
    const { source, changes } = withDeletions(fake)
    const token = await (source.startToken as () => Promise<string>)()
    fake.erase("a")
    fake.erase("b")
    for (let n = 0; n < 3; n++) fake.erase(`old${n}`)
    fake.put({ id: "b", title: "Beta again", parent: "root", kind: "page" })
    const round = await changes(token)
    expect(round.items.filter((item) => item.id === "a")).toEqual([{ id: "a", removed: true, gone: "deleted" }])
    expect(round.items.map((item) => item.id)).toEqual(expect.arrayContaining(["old0", "old1", "old2"]))
    expect(round.items.filter((item) => item.id === "b").at(-1)).toMatchObject({ removed: false })
  })

  it("leaves out a deletion older than the round, though the provider lists it", async () => {
    const fake = pagesApi()
    const { changes } = withDeletions(fake)
    fake.feed.everyTime = true
    fake.erase("a")
    const token = String(fake.now() + 60_000)
    expect((await changes(token)).items.map((item) => item.id)).not.toContain("a")
  })

  it("answers the round when the provider refuses the feed, and says deletions were not checked", async () => {
    const fake = pagesApi()
    const { source, changes, warnings } = withDeletions(fake)
    const token = await (source.startToken as () => Promise<string>)()
    fake.erase("a")
    fake.put({ id: "d", title: "Delta", parent: "root", kind: "page" })
    fake.feed.refuse = new CliError("permission_error", "admins only")
    const round = await changes(token)
    expect(round.items.map((item) => item.id)).toContain("d")
    expect(round.items.filter((item) => item.gone)).toEqual([])
    expect(warnings).toEqual([
      {
        code: "permission_error",
        reason: "source.deletions-unchecked",
        message: expect.stringContaining("sync --rescan finds them"),
      },
    ])
  })

  it("keeps the deletions read before a refusal on a later page", async () => {
    const fake = pagesApi()
    const { source, changes, warnings } = withDeletions(fake)
    const token = await (source.startToken as () => Promise<string>)()
    for (const id of ["a", "b", "c"]) fake.erase(id)
    fake.feed.refuse = new CliError("permission_error", "admins only")
    fake.feed.refuseAfter = 2
    expect((await changes(token)).items.map((item) => item.id)).toEqual(["a", "b"])
    expect(warnings.map((one) => one.reason)).toEqual(["source.deletions-unchecked"])
  })

  it("fails the round on any other error, so its token stays and the next round reads them", async () => {
    const fake = pagesApi()
    const { source, changes, warnings } = withDeletions(fake)
    const token = await (source.startToken as () => Promise<string>)()
    fake.feed.refuse = new CliError("network_error", "offline")
    await expect(changes(token)).rejects.toThrow("offline")
    expect(warnings).toEqual([])
  })

  it("reads deletions for a change feed a hook gives", async () => {
    const fake = pagesApi()
    const { source, changes } = withDeletions(fake, {
      hooks: () => ({ startToken: async () => String(fake.now()), changes: async () => ({ items: [], cursor: "9" }) }),
    })
    const token = await (source.startToken as () => Promise<string>)()
    fake.erase("c")
    expect(await changes(token)).toEqual({ items: [{ id: "c", removed: true, gone: "deleted" }], cursor: "9" })
  })

  it("refuses a feed with no change feed or no warn to read it in, and a token that is not a time", async () => {
    const { changes: _changes, ...noChanges } = MANIFEST
    expect(() =>
      documentSourceFromManifest({ ...noChanges, deletions: DELETIONS }, { api, call: pagesApi().call }),
    ).toThrow(/deletions needs a change feed/)
    expect(() =>
      documentSourceFromManifest({ ...MANIFEST, deletions: DELETIONS }, { api, call: pagesApi().call }),
    ).toThrow(/deletions needs the run's warn/)
    await expect(withDeletions(pagesApi()).changes("later")).rejects.toThrow(/not a change token/)
  })
})

describe("parseDocumentManifest", () => {
  const refused = (patch: Record<string, unknown>) => () => parseDocumentManifest({ ...MANIFEST, ...patch }, api)

  it("names an unknown operation and the one it most likely meant", () => {
    expect(refused({ get: { ...MANIFEST.get, operation: "get-iten" } })).toThrow(
      /get\.operation: no operation get-iten in the API; did you mean get-item\?/,
    )
  })

  it("refuses a call that writes, one without the value it needs, and a listing nothing maps", () => {
    expect(refused({ content: { operation: "delete-item", path: { id: "{id}" }, markdown: "x" } })).toThrow(
      /delete-item is a delete, and a source only reads/,
    )
    expect(refused({ get: { ...MANIFEST.get, path: {} } })).toThrow(/get: no "\{id\}"/)
    expect(refused({ deletions: { ...DELETIONS, body: {} } })).toThrow(/deletions: no "\{since\}"/)
    expect(refused({ reads: { children: { operation: "list-children" } } })).toThrow(
      /reads\.children: children is the manifest's own call/,
    )
    const { get: _get, ...noGet } = MANIFEST
    expect(() => parseDocumentManifest(noGet, api)).toThrow(/children: no map/)
  })

  it("refuses a source that leaves a method to no one", () => {
    const { content: _content, ...noContent } = MANIFEST
    expect(() => documentSourceFromManifest(noContent, { api, call: pagesApi().call })).toThrow(/no content/)
  })
})
