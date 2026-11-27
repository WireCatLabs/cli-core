import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ENRICHMENT_POSITION } from "./sqlite/enrichments.js"
import { noteSearchOver } from "./sqlite/note-search.js"
import type { StoreContext } from "./sqlite/open.js"
import { openStoreContext } from "./sqlite/open-store.js"
import { saveVectors } from "./sqlite/vectors.js"

const answered = vi.hoisted(() => ({ count: 0 }))
vi.mock("./sqlite/vector-index.js", async (original) => {
  const real = await original<typeof import("./sqlite/vector-index.js")>()
  return {
    ...real,
    searchIndex: (...args: Parameters<typeof real.searchIndex>) => {
      const found = real.searchIndex(...args)
      if (found) answered.count++
      return found
    },
  }
})

// Finding mentions in the large store's 5.4 million words took half of this file's time (2026-11-27); no test here
// reads a mention.
vi.mock("./sqlite/mention-drain.js", async (original) => ({
  ...(await original<typeof import("./sqlite/mention-drain.js")>()),
  drainMentions: () => 0,
}))

const MODEL = "local:invented:8"
const DIMS = 8

const opened: StoreContext[] = []
afterEach(() => {
  for (const context of opened.splice(0)) context.database.close()
})

const random = (seed: number) => () => {
  seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648
  return seed / 2_147_483_648 - 0.5
}
const next = random(11)
const unit = () => {
  const vector = Float32Array.from({ length: DIMS }, next)
  const norm = Math.hypot(...vector)
  return vector.map((value) => value / norm)
}

/**
 * Documents of two accounts — some deleted, one out of its catalog, some copies of one text — and loose notes. The
 * store chunks them first; then each gets chunks and vectors of the test's own, so the index has many to rank.
 */
const seed = async () => {
  const context = await openStoreContext({
    path: join(mkdtempSync(join(tmpdir(), "note-vectors-")), "w.db"),
    now: () => 1,
  })
  opened.push(context)
  const { database } = context
  const id = (sql: string, ...values: (string | number | null)[]) => Number(database.prepare(sql).get(...values)?.id)
  const accounts = [1, 2].map((n) =>
    id(
      "INSERT INTO accounts (provider, external_id, created_at, updated_at) VALUES ('files', ?, 1, 1) RETURNING id",
      `a${n}`,
    ),
  )
  const documents = Array.from({ length: 300 }, (_, n) =>
    id(
      `INSERT INTO documents (account_id, external_id, kind, title, body, metadata, deleted_at, created_at, updated_at)
        VALUES (?, ?, 'file', ?, 'x', ?, ?, 1, 1) RETURNING id`,
      accounts[n % 3 === 0 ? 1 : 0] as number,
      `d${n}`,
      `doc ${n}`,
      n === 7 ? '{"catalog":{"active":0}}' : null,
      n % 29 === 0 ? 5 : null,
    ),
  )
  const notes = Array.from({ length: 60 }, (_, n) =>
    id(
      `INSERT INTO notes (notable_type, notable_id, title, body, deleted_at, created_at, updated_at)
        VALUES ('account', 1, ?, 'x', ?, 1, 1) RETURNING id`,
      `note ${n}`,
      n % 13 === 0 ? 5 : null,
    ),
  )
  await noteSearchOver(context).chunksToEmbed(MODEL, { limit: 1 })

  database.exec("BEGIN")
  database.exec("DELETE FROM chunks WHERE chunkable_type IN ('document', 'note')")
  const vectors = new Map<string, Float32Array>()
  const chunk = (type: string, owner: number, position: number, account: number | null, hash: string) => {
    if (!vectors.has(hash)) vectors.set(hash, unit())
    database
      .prepare(
        `INSERT INTO chunks (chunkable_type, chunkable_id, position, start_offset, end_offset, content_hash, account_id,
          occurred_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1, 1)`,
      )
      .run(type, owner, position, position * 10, position * 10 + 9, hash, account)
  }
  // Every tenth document is a copy of the first: the same text, the same vector, a tie.
  for (const [n, document] of documents.entries())
    for (let position = 0; position < 4; position++)
      chunk(
        "document",
        document,
        position,
        accounts[n % 3 === 0 ? 1 : 0] as number,
        n % 10 === 0 ? `copy-${position}` : `d${n}-${position}`,
      )
  for (const [n, note] of notes.entries())
    for (let position = 0; position < 2; position++) chunk("note", note, position, null, `n${n}-${position}`)
  saveVectors(
    context,
    MODEL,
    DIMS,
    [...vectors].filter((_, n) => n % 17 !== 5).map(([hash, vector]) => ({ hash, vector })),
  )
  database.exec("COMMIT")
  return { context, accounts }
}

const bothWays = async <T>(context: StoreContext, search: () => Promise<T>) => {
  const indexed = await search()
  context.database.prepare("UPDATE vector_indexes SET ready = 0").run()
  const scanned = await search()
  context.database.prepare("UPDATE vector_indexes SET ready = 1").run()
  return { indexed, scanned }
}

describe("notes and documents nearest in meaning", () => {
  it("**answer by the vector index exactly what the scan answers**, ties and filters included", async () => {
    const { context, accounts } = await seed()
    const notes = noteSearchOver(context)
    const query = unit()
    const cases: [string, Parameters<typeof notes.nearest>[2]][] = [
      ["everything", { limit: 20 }],
      ["one folder", { limit: 10, folderIds: [String(accounts[1])] }],
      ["one folder with the notes", { limit: 10, folderIds: [String(accounts[1])], withInternal: true }],
      ["files only", { limit: 15, source: "file" }],
      ["notes only", { limit: 8, source: "internal" }],
      ["many", { limit: 150 }],
    ]
    for (const [name, options] of cases) {
      answered.count = 0
      const { indexed, scanned } = await bothWays(context, () => notes.nearest(MODEL, query, options))
      const view = (found: Awaited<ReturnType<typeof notes.nearest>>) =>
        found.map(({ ref, score, range }) => [ref, score.toFixed(6), range.start])
      expect(view(indexed), name).toEqual(view(scanned))
      expect(indexed.length, name).toBeGreaterThan(0)
      expect(answered.count, `${name}: the index answered`).toBeGreaterThan(0)
    }
  })
})

describe("chunksLeft", () => {
  it("counts what chunksToEmbed gives, not an enrichment chunk whose text is gone", async () => {
    const context = await openStoreContext({
      path: join(mkdtempSync(join(tmpdir(), "note-vectors-")), "left.db"),
      now: () => 1,
    })
    opened.push(context)
    const { database } = context
    const note = Number(
      database
        .prepare(
          `INSERT INTO notes (notable_type, notable_id, title, body, created_at, updated_at)
            VALUES ('account', 1, 'cat', 'dog', 1, 1) RETURNING id`,
        )
        .get()?.id,
    )
    const notes = noteSearchOver(context)
    await notes.chunksToEmbed(MODEL, { limit: 1 })
    database
      .prepare(
        `INSERT INTO chunks (chunkable_type, chunkable_id, position, start_offset, end_offset, content_hash, account_id,
          occurred_at, created_at, updated_at) VALUES ('note', ?, ?, 0, 0, 'orphan', NULL, 1, 1, 1)`,
      )
      .run(note, ENRICHMENT_POSITION)
    const given = await notes.chunksToEmbed(MODEL, { limit: 100 })
    expect(given.length).toBeGreaterThan(0)
    expect(await notes.chunksLeft(MODEL)).toBe(given.length)
  })
})

describe("chunksLeft on a large store", () => {
  it("counts in one query, within 25 times a plain count, without building any note's text", async () => {
    const context = await openStoreContext({
      path: join(mkdtempSync(join(tmpdir(), "note-vectors-")), "large.db"),
      now: () => 1,
    })
    opened.push(context)
    const { database } = context
    const insert = database.prepare(
      "INSERT INTO notes (notable_type, notable_id, title, body, created_at, updated_at) VALUES ('account', 1, ?, ?, 1, 1)",
    )
    const words = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho".split(" ")
    database.exec("BEGIN")
    for (let note = 0; note < 6_000; note++)
      insert.run(
        `note ${note}`,
        Array.from(
          { length: 900 },
          (_, at) => `${words[(note * 7 + at * 13) % words.length]}${at % 50 === 0 ? ` ${note}.\n\n` : ""}`,
        ).join(" "),
      )
    database.exec("COMMIT")
    const notes = noteSearchOver(context)
    await notes.chunksToEmbed(MODEL, { limit: 1 })
    let started = performance.now()
    const plain = database
      .prepare(
        `SELECT count(DISTINCT k.content_hash) AS left FROM chunks k
          WHERE NOT EXISTS (SELECT 1 FROM embeddings v WHERE v.model = ? AND v.content_hash = k.content_hash)`,
      )
      .get(MODEL)
    const plainMs = performance.now() - started
    started = performance.now()
    const left = await notes.chunksLeft(MODEL)
    const ms = performance.now() - started
    expect(left).toBe(Number(plain?.left))
    expect(left).toBeGreaterThan(30_000)
    expect(ms).toBeLessThan(Math.max(100, plainMs * 25))
  }, 60_000)
})
