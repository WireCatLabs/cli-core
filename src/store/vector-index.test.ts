import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { nearestImages } from "./sqlite/image-chunks.js"
import { nearestMessages } from "./sqlite/message-chunks.js"
import type { StoreContext } from "./sqlite/open.js"
import { openStoreContext } from "./sqlite/open-store.js"
import { fillVectorIndexes, searchIndex, vectorIndexCounts } from "./sqlite/vector-index.js"
import { nearestChunks, saveVectors } from "./sqlite/vectors.js"

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
const next = random(7)
const unit = () => {
  const vector = Float32Array.from({ length: DIMS }, next)
  const norm = Math.hypot(...vector)
  return vector.map((value) => value / norm)
}

const open = async () => {
  const path = join(mkdtempSync(join(tmpdir(), "vector-index-")), "wirecat.db")
  const context = await openStoreContext({ path, now: () => 1000 })
  opened.push(context)
  return context
}

/** Two accounts, a hidden chat, deleted messages, images, and conversations of an old and a current build. */
const seed = (context: StoreContext) => {
  const { database } = context
  database.exec("BEGIN")
  const run = (sql: string, ...values: (string | number | null)[]) => database.prepare(sql).run(...values)
  const id = (sql: string, ...values: (string | number | null)[]) => Number(database.prepare(sql).get(...values)?.id)
  const accounts = [1, 2].map((n) =>
    id(
      "INSERT INTO accounts (provider, external_id, created_at, updated_at) VALUES ('example', ?, 1, 1) RETURNING id",
      `a${n}`,
    ),
  )
  const chats = Array.from({ length: 7 }, (_, n) =>
    id(
      `INSERT INTO chats (account_id, external_id, kind, searchable, created_at, updated_at)
        VALUES (?, ?, 'group', ?, 1, 1) RETURNING id`,
      accounts[n === 6 ? 1 : 0] as number,
      `c${n}`,
      n === 4 ? 0 : 1,
    ),
  )
  const vectors: { hash: string; vector: Float32Array }[] = []
  const chunk = (type: string, owner: number, position: number, account: number, at: number) => {
    const hash = `h-${type}-${owner}-${position}`
    vectors.push({ hash, vector: unit() })
    return id(
      `INSERT INTO chunks (chunkable_type, chunkable_id, position, start_offset, end_offset, content_hash, account_id,
          occurred_at, created_at, updated_at) VALUES (?, ?, ?, 0, 1, ?, ?, ?, 1, 1) RETURNING id`,
      type,
      owner,
      position,
      hash,
      account,
      at,
    )
  }
  const messages: number[] = []
  for (let n = 0; n < 700; n++) {
    const chat = chats[n % 7] as number
    const account = accounts[n % 7 === 6 ? 1 : 0] as number
    const message = id(
      `INSERT INTO messages (chat_id, account_id, external_id, sent_at, text, source, deleted_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'x', 'fixture', ?, 1, 1) RETURNING id`,
      chat,
      account,
      `m${n}`,
      10_000 + n,
      n % 23 === 0 ? 5 : null,
    )
    messages.push(message)
    chunk("message", message, 0, account, 10_000 + n)
    if (n % 5 === 0) {
      const attachment = id(
        `INSERT INTO attachments (attachable_type, attachable_id, position, kind, created_at, updated_at)
          VALUES ('message', ?, 0, 'photo', 1, 1) RETURNING id`,
        message,
      )
      chunk("image", attachment, 0, account, 10_000 + n)
    }
  }
  for (const [n, chat] of chats.entries()) {
    run("INSERT INTO conversation_state (chat_id, enabled_at, current_build) VALUES (?, 1, 2)", chat)
    for (const build of [1, 2])
      for (let c = 0; c < 12; c++) {
        const first = messages[n + 7 * c] as number
        const conversation = id(
          `INSERT INTO conversations (chat_id, first_message_id, build, first_at, last_at, message_count, built_at,
              algorithm_version, created_at, updated_at) VALUES (?, ?, ?, 1, 1, 1, 1, 1, 1, 1) RETURNING id`,
          chat,
          first,
          build,
        )
        for (let position = 0; position < 3; position++) {
          const k = chunk("conversation", conversation, position, accounts[n === 6 ? 1 : 0] as number, 10_000 + c)
          run(
            "INSERT INTO chunk_messages (chunk_id, first_message_id, last_message_id) VALUES (?, ?, ?)",
            k,
            first,
            first,
          )
        }
      }
  }
  // Some chunks never get a vector.
  saveVectors(
    context,
    MODEL,
    DIMS,
    vectors.filter((_, n) => n % 17 !== 3),
  )
  database.exec("COMMIT")
  return { accounts, chats, messages, vectors }
}

/** Every search both ways: the index, then the scan the index is measured against. */
const bothWays = <T>(context: StoreContext, search: () => T): { indexed: T; scanned: T } => {
  const indexed = search()
  context.database.prepare("UPDATE vector_indexes SET ready = 0").run()
  const scanned = search()
  context.database.prepare("UPDATE vector_indexes SET ready = 1").run()
  return { indexed, scanned }
}

const searches = (context: StoreContext, account: number, chat: number) => {
  const query = unit()
  const cases: [string, () => unknown][] = [
    ["messages", () => nearestMessages(context, account, { model: MODEL, limit: 20, query })],
    ["messages of one chat", () => nearestMessages(context, account, { model: MODEL, limit: 5, query, chatKey: chat })],
    [
      "messages in a time window",
      () => nearestMessages(context, account, { model: MODEL, limit: 10, query, since: 10_100, before: 10_300 }),
    ],
    ["images", () => nearestImages(context, account, { model: MODEL, limit: 10, query })],
    ["images since", () => nearestImages(context, account, { model: MODEL, limit: 10, query, since: 10_400 })],
    ["conversations", () => nearestChunks(context, account, { model: MODEL, limit: 8, query })],
    [
      "conversations of one chat before",
      () => nearestChunks(context, account, { model: MODEL, limit: 3, query, chatKey: chat, before: 10_006 }),
    ],
  ]
  return cases
}

describe("the vector index", () => {
  it("**answers exactly what the scan answers**, across hidden chats, deleted messages and old builds", async () => {
    const context = await open()
    const { accounts, chats } = seed(context)
    for (const [name, search] of searches(context, accounts[0] as number, chats[1] as number)) {
      const { indexed, scanned } = bothWays(context, search)
      expect(indexed, name).toEqual(scanned)
      expect((indexed as unknown[]).length, name).toBeGreaterThan(0)
    }
  })

  it("is used, not passed over, for a broad search", async () => {
    const context = await open()
    const { accounts } = seed(context)
    const used = searchIndex(
      context.database,
      MODEL,
      { kind: "message", account: accounts[0] as number },
      unit(),
      5,
      (c) => ({
        results: c,
        best: c.slice(0, 5).map(({ id }) => id),
      }),
    )
    expect(used?.length).toBeGreaterThanOrEqual(5)
  })

  it("**stays exact after writes it was not told about**: raw SQL as an older writer would send it", async () => {
    const context = await open()
    const { accounts, chats, messages, vectors } = seed(context)
    const { database } = context
    const run = (sql: string, ...values: (string | number | null)[]) => database.prepare(sql).run(...values)
    // The newest chunk goes and a new one takes its id, with a text that already has a vector.
    const top = Number(database.prepare("SELECT max(id) AS id FROM chunks").get()?.id)
    const reused = database.prepare("SELECT * FROM chunks WHERE id = ?").get(top) as Record<string, number | string>
    run("DELETE FROM chunks WHERE id = ?", top)
    run(
      `INSERT INTO chunks (chunkable_type, chunkable_id, position, start_offset, end_offset, content_hash, account_id,
          occurred_at, created_at, updated_at) VALUES (?, ?, ?, 0, 1, ?, ?, ?, 2, 2)`,
      reused.chunkable_type as string,
      reused.chunkable_id as number,
      reused.position as number,
      vectors[0]?.hash as string,
      reused.account_id as number,
      reused.occurred_at as number,
    )
    expect(Number(database.prepare("SELECT max(id) AS id FROM chunks").get()?.id)).toBe(top)
    // A chat merge moves messages without touching a chunk.
    run("UPDATE messages SET chat_id = ? WHERE chat_id = ?", chats[1] as number, chats[2] as number)
    // A vector dropped, a message deleted, a message's own chunk deleted.
    run("DELETE FROM embeddings WHERE content_hash = ?", vectors[5]?.hash as string)
    run("UPDATE messages SET deleted_at = 9 WHERE id = ?", messages[8] as number)
    run("DELETE FROM chunks WHERE chunkable_type = 'message' AND chunkable_id = ?", messages[15] as number)
    for (const [name, search] of searches(context, accounts[0] as number, chats[1] as number)) {
      const { indexed, scanned } = bothWays(context, search)
      expect(indexed, name).toEqual(scanned)
    }
    for (const { indexed, expected } of vectorIndexCounts(database)) expect(indexed).toBe(expected)
  })

  it("fills the vectors a store held before its index, and then searches by it", async () => {
    const context = await open()
    const { accounts } = seed(context)
    context.database.exec("DELETE FROM vector_indexes; DROP TRIGGER vector_index_1_redo; DROP TABLE vector_index_1")
    expect(fillVectorIndexes(context.database, { batch: 50 })).toEqual([MODEL])
    const [counts] = vectorIndexCounts(context.database)
    expect(counts).toMatchObject({ model: MODEL, ready: true })
    expect(counts?.indexed).toBe(counts?.expected)
    const query = unit()
    const { indexed, scanned } = bothWays(context, () =>
      nearestMessages(context, accounts[0] as number, { model: MODEL, limit: 20, query }),
    )
    expect(indexed).toEqual(scanned)
  })
})

/** One visible and one hidden chat; `messages` lists how many messages get which vector, in which chat. */
const crowd = (context: StoreContext, messages: { hidden: boolean; vector: () => Float32Array; hash?: string }[]) => {
  const { database } = context
  const id = (sql: string, ...values: (string | number | null)[]) => Number(database.prepare(sql).get(...values)?.id)
  database.exec("BEGIN")
  const account = id(
    "INSERT INTO accounts (provider, external_id, created_at, updated_at) VALUES ('example', 'a', 1, 1) RETURNING id",
  )
  const [visible, hidden] = [1, 0].map((searchable) =>
    id(
      `INSERT INTO chats (account_id, external_id, kind, searchable, created_at, updated_at)
        VALUES (?, ?, 'group', ?, 1, 1) RETURNING id`,
      account,
      `c${searchable}`,
      searchable,
    ),
  )
  const vectors = new Map<string, Float32Array>()
  for (const [n, { hidden: inHidden, vector, hash = `h${n}` }] of messages.entries()) {
    const message = id(
      `INSERT INTO messages (chat_id, account_id, external_id, sent_at, text, source, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'x', 'fixture', 1, 1) RETURNING id`,
      (inHidden ? hidden : visible) as number,
      account,
      `m${n}`,
      n,
    )
    database
      .prepare(
        `INSERT INTO chunks (chunkable_type, chunkable_id, position, start_offset, end_offset, content_hash, account_id,
          occurred_at, created_at, updated_at) VALUES ('message', ?, 0, 0, 1, ?, ?, ?, 1, 1)`,
      )
      .run(message, hash, account, n)
    if (!vectors.has(hash)) vectors.set(hash, vector())
  }
  saveVectors(
    context,
    MODEL,
    DIMS,
    [...vectors].map(([hash, vector]) => ({ hash, vector })),
  )
  database.exec("COMMIT")
  return account
}

const knnQueries = (context: StoreContext) => {
  const prepare = vi.spyOn(context.database, "prepare")
  return () => prepare.mock.calls.filter(([sql]) => sql.includes("MATCH")).length
}

describe("the vector index at its edges", () => {
  const query = Float32Array.from({ length: DIMS }, (_, n) => (n === 0 ? 1 : 0))
  const close = () => unit().map((value, n) => (n === 0 ? 50 : value) / Math.hypot(50, 1))

  it("**breaks ties as the scan does** when many messages share one text", async () => {
    const context = await open()
    const account = crowd(context, [
      ...Array.from({ length: 300 }, () => ({ hidden: false, vector: () => query, hash: "same" })),
      ...Array.from({ length: 200 }, () => ({ hidden: false, vector: unit })),
    ])
    const { indexed, scanned } = bothWays(context, () =>
      nearestMessages(context, account, { model: MODEL, limit: 20, query }),
    )
    expect(indexed).toEqual(scanned)
    expect(indexed.map(({ messageId }) => messageId)).toEqual(Array.from({ length: 20 }, (_, n) => `m${n}`))
  })

  it("asks for more candidates when the nearest are in a hidden chat", async () => {
    const context = await open()
    const account = crowd(context, [
      ...Array.from({ length: 150 }, () => ({ hidden: true, vector: close })),
      ...Array.from({ length: 100 }, () => ({ hidden: false, vector: unit })),
    ])
    const asked = knnQueries(context)
    const indexed = nearestMessages(context, account, { model: MODEL, limit: 20, query })
    expect(asked()).toBe(2)
    const { scanned } = bothWays(context, () => nearestMessages(context, account, { model: MODEL, limit: 20, query }))
    expect(indexed).toEqual(scanned)
  })

  it("scans when even vec0's most candidates leave too few", async () => {
    const context = await open()
    const account = crowd(context, [
      ...Array.from({ length: 4_200 }, () => ({ hidden: true, vector: close })),
      ...Array.from({ length: 30 }, () => ({ hidden: false, vector: unit })),
    ])
    const asked = knnQueries(context)
    const indexed = nearestMessages(context, account, { model: MODEL, limit: 20, query })
    // k = 100, 400, 1,600, then vec0's most, 4,096.
    expect(asked()).toBe(4)
    const { scanned } = bothWays(context, () => nearestMessages(context, account, { model: MODEL, limit: 20, query }))
    expect(indexed).toEqual(scanned)
    expect(indexed).toHaveLength(20)
  })
})

/** An account, two chats in it, a message in each, and a second account. */
const pair = (context: StoreContext) => {
  const { database } = context
  const id = (sql: string, ...values: (string | number)[]) => Number(database.prepare(sql).get(...values)?.id)
  const [first, second] = ["a", "b"].map((name) =>
    id(
      "INSERT INTO accounts (provider, external_id, created_at, updated_at) VALUES ('example', ?, 1, 1) RETURNING id",
      name,
    ),
  ) as [number, number]
  const [kept, gone] = ["k", "g"].map((name) =>
    id(
      "INSERT INTO chats (account_id, external_id, kind, created_at, updated_at) VALUES (?, ?, 'group', 1, 1) RETURNING id",
      first,
      name,
    ),
  ) as [number, number]
  const message = (chat: number) =>
    id(
      `INSERT INTO messages (chat_id, account_id, external_id, sent_at, text, source, created_at, updated_at)
        VALUES (?, ?, 'm1', 5, 'x', 'fixture', 1, 1) RETURNING id`,
      chat,
      first,
    )
  return { id, first, second, kept, gone, keptMessage: message(kept), goneMessage: message(gone) }
}

const chunkOf = (context: StoreContext, type: string, owner: number, account: number, hash: string) =>
  Number(
    context.database
      .prepare(
        `INSERT INTO chunks (chunkable_type, chunkable_id, position, start_offset, end_offset, content_hash, account_id,
          occurred_at, created_at, updated_at) VALUES (?, ?, 0, 0, 1, ?, ?, 5, 1, 1) RETURNING id`,
      )
      .get(type, owner, hash, account)?.id,
  )

const axis = Float32Array.from({ length: DIMS }, (_, n) => (n === 0 ? 1 : 0))

const inStep = (context: StoreContext) => {
  for (const { missing, extra } of vectorIndexCounts(context.database))
    expect({ missing, extra }).toEqual({ missing: 0, extra: 0 })
}

describe("the vector index follows the rows it derives from", () => {
  it("**finds an image a chat merge moved** to the kept chat's message", async () => {
    const context = await open()
    const { first, kept, keptMessage, goneMessage, id } = pair(context)
    const attachment = id(
      `INSERT INTO attachments (attachable_type, attachable_id, position, kind, created_at, updated_at)
        VALUES ('message', ?, 0, 'photo', 1, 1) RETURNING id`,
      goneMessage,
    )
    chunkOf(context, "image", attachment, first, "h1")
    saveVectors(context, MODEL, DIMS, [{ hash: "h1", vector: axis }])
    // What chat-rekey.ts's pointerMover("message") runs for a duplicate pair.
    context.database
      .prepare(
        "UPDATE OR IGNORE attachments SET attachable_id = ? WHERE attachable_type = 'message' AND attachable_id = ?",
      )
      .run(keptMessage, goneMessage)
    const { indexed, scanned } = bothWays(context, () =>
      nearestImages(context, first, { model: MODEL, limit: 5, query: axis, chatKey: kept }),
    )
    expect(indexed).toEqual(scanned)
    expect(indexed).toHaveLength(1)
    inStep(context)
  })

  const conversation = async () => {
    const context = await open()
    const rows = pair(context)
    for (const chat of [rows.kept, rows.gone])
      context.database
        .prepare("INSERT INTO conversation_state (chat_id, enabled_at, current_build) VALUES (?, 1, 1)")
        .run(chat)
    const id = rows.id(
      `INSERT INTO conversations (chat_id, first_message_id, build, first_at, last_at, message_count, built_at,
          algorithm_version, created_at, updated_at) VALUES (?, ?, 1, 1, 1, 1, 1, 1, 1, 1) RETURNING id`,
      rows.gone,
      rows.goneMessage,
    )
    const chunk = chunkOf(context, "conversation", id, rows.first, "hc")
    context.database
      .prepare("INSERT INTO chunk_messages (chunk_id, first_message_id, last_message_id) VALUES (?, ?, ?)")
      .run(chunk, rows.goneMessage, rows.goneMessage)
    saveVectors(context, MODEL, DIMS, [{ hash: "hc", vector: axis }])
    return { context, ...rows, conversation: id }
  }

  it("finds a conversation moved to another chat", async () => {
    const { context, first, kept, conversation: id } = await conversation()
    context.database.prepare("UPDATE conversations SET chat_id = ? WHERE id = ?").run(kept, id)
    const { indexed, scanned } = bothWays(context, () =>
      nearestChunks(context, first, { model: MODEL, limit: 5, query: axis, chatKey: kept }),
    )
    expect(indexed).toEqual(scanned)
    expect(indexed).toHaveLength(1)
    inStep(context)
  })

  it("finds a conversation whose chat moved to another account", async () => {
    const { context, second, gone } = await conversation()
    context.database.prepare("UPDATE chats SET account_id = ? WHERE id = ?").run(second, gone)
    const { indexed, scanned } = bothWays(context, () =>
      nearestChunks(context, second, { model: MODEL, limit: 5, query: axis }),
    )
    expect(indexed).toEqual(scanned)
    expect(indexed).toHaveLength(1)
    inStep(context)
  })

  it("store check's comparison names a row the index holds wrong", async () => {
    const { context, conversation: id, kept } = await conversation()
    context.database.exec("DROP TRIGGER vector_index_conversation_au")
    context.database.prepare("UPDATE conversations SET chat_id = ? WHERE id = ?").run(kept, id)
    expect(vectorIndexCounts(context.database)[0]).toMatchObject({ indexed: 1, expected: 1, missing: 1, extra: 1 })
  })
})

describe("vectors the index ranks as the scan does", () => {
  it("**stores every vector at length one**, so a long one ranks by direction both ways", async () => {
    const context = await open()
    const account = crowd(context, [
      ...Array.from({ length: 299 }, () => ({ hidden: false, vector: unit })),
      {
        hidden: false,
        vector: () => Float32Array.from({ length: DIMS }, (_, n) => (n === 0 ? 1.5 : n === 1 ? 29.96 : 0)),
      },
    ])
    const stored = context.database.prepare("SELECT vector FROM embeddings WHERE content_hash = 'h299'").get()
      ?.vector as Uint8Array
    const vector = new Float32Array(stored.buffer, stored.byteOffset, DIMS)
    expect(Math.hypot(...vector)).toBeCloseTo(1, 6)
    const { indexed, scanned } = bothWays(context, () =>
      nearestMessages(context, account, { model: MODEL, limit: 5, query: axis }),
    )
    expect(indexed).toEqual(scanned)
  })

  it("refuses a non-finite vector", async () => {
    const context = await open()
    const vector = Float32Array.from({ length: DIMS }, () => Number.NaN)
    expect(() => saveVectors(context, MODEL, DIMS, [{ hash: "z", vector }])).toThrow(/finite values/)
  })

  it("ranks zero vectors (a text the model knows nothing of) as the scan does", async () => {
    const context = await open()
    const account = crowd(context, [
      ...Array.from({ length: 150 }, () => ({ hidden: false, vector: () => new Float32Array(DIMS) })),
      ...Array.from({ length: 300 }, () => ({ hidden: false, vector: unit })),
    ])
    for (const limit of [5, 200, 400]) {
      const query = unit()
      const { indexed, scanned } = bothWays(context, () =>
        nearestMessages(context, account, { model: MODEL, limit, query }),
      )
      expect(indexed, `limit ${limit}`).toEqual(scanned)
    }
  })

  for (const noise of [1e-5, 1e-6, 1e-7])
    it(`**answers as the scan does among near-identical vectors** (noise ${noise})`, async () => {
      const context = await open()
      const base = unit()
      const account = crowd(
        context,
        Array.from({ length: 600 }, () => ({
          hidden: false,
          vector: () => base.map((value) => value + next() * noise),
        })),
      )
      for (const limit of [1, 5, 20, 50, 99, 100, 101, 200]) {
        const { indexed, scanned } = bothWays(context, () =>
          nearestMessages(context, account, { model: MODEL, limit, query: base }),
        )
        expect(indexed, `limit ${limit}`).toEqual(scanned)
      }
    })
})
