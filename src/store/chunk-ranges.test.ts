import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { CHUNK_CHARS, chunkHash, chunkTextOf } from "../conversations/chunks.js"
import type { Message } from "../domain/models.js"
import { conversationsService } from "../services/conversations.js"
import { storeOnlyDeps } from "../services/deps.js"
import { type MessageStore, openStore } from "./store.js"

const app = { command: "memo", appName: "cli-memo", envPrefix: "MEMO", description: "notes", version: "0.0.0" }
const notes = { provider: "notes", account: "/vault" }
const MODEL = "test:4"

const paragraph = (n: number) => `Paragraph ${n} is about the harbour plan and its budget. It goes on a little.`
const longText = Array.from({ length: 60 }, (_, n) => paragraph(n)).join("\n\n")

const note = (id: string, text: string): Message => ({
  id,
  chatId: "Projects",
  senderId: null,
  senderName: null,
  timestamp: "2026-10-01T00:00:00.000Z",
  editedAt: null,
  text,
  outgoing: true,
  attachments: [],
  replyTo: null,
  forwardedFrom: null,
  reactions: null,
})

const unit = (seed: number): Float32Array => {
  const vector = new Float32Array([1, seed, 0, 0])
  const length = Math.hypot(...vector)
  return vector.map((value) => value / length)
}

let store: MessageStore
let path: string

beforeEach(async () => {
  path = join(mkdtempSync(join(tmpdir(), "chunk-ranges-")), "m.db")
  store = await openStore({ path })
  await store.messages.saveMessages(notes, "Projects", [note("long.md", longText), note("short.md", "A short note.")], {
    via: "test",
  })
  await conversationsService(storeOnlyDeps(store, notes, { app })).build("Projects")
})

afterEach(async () => {
  await store.close()
})

describe("a message longer than a chunk", () => {
  it("is stored as overlapping pieces whose text the store reads back exactly", async () => {
    const toEmbed = await store.vectors.chunksToEmbed(notes, "Projects", MODEL, { limit: 100 })
    const pieces = toEmbed.filter(({ lines }) => lines[0]?.id === "long.md")

    expect(pieces.length).toBeGreaterThanOrEqual(Math.ceil(longText.length / CHUNK_CHARS))
    for (const { hash, lines } of pieces) {
      const text = chunkTextOf(lines)
      expect(text.length).toBeLessThanOrEqual(CHUNK_CHARS)
      expect(chunkHash(text)).toBe(hash)
    }
    expect(pieces.map(({ lines }) => lines[0]?.text).join(" ")).toContain("Paragraph 59")
  })

  it("is found by any of its pieces, and stays current", async () => {
    const toEmbed = await store.vectors.chunksToEmbed(notes, "Projects", MODEL, { limit: 100 })
    await store.vectors.saveVectors(
      MODEL,
      4,
      toEmbed.map(({ hash }, index) => ({ hash, vector: unit(index) })),
    )

    const hits = await store.vectors.nearestConversations(notes, { model: MODEL, limit: 5, query: unit(3) })

    expect(hits[0]).toMatchObject({ stale: false, chunk: { firstMessageId: "long.md", lastMessageId: "long.md" } })
    expect(await store.vectors.vectorStatus(notes, "Projects", MODEL)).toEqual({
      chunks: toEmbed.length,
      embedded: toEmbed.length,
    })
  })

  it("loses every piece's vector when the message is deleted", async () => {
    const toEmbed = await store.vectors.chunksToEmbed(notes, "Projects", MODEL, { limit: 100 })
    await store.vectors.saveVectors(
      MODEL,
      4,
      toEmbed.map(({ hash }, index) => ({ hash, vector: unit(index) })),
    )

    await store.messages.markDeleted(notes, ["long.md"], { chatId: "Projects" })

    const hits = await store.vectors.nearestConversations(notes, { model: MODEL, limit: 5, query: unit(3) })
    expect(hits.every(({ chunk }) => chunk.firstMessageId !== "long.md")).toBe(true)
    const left = new DatabaseSync(path, { readOnly: true })
    const pieces = toEmbed.filter(({ lines }) => lines[0]?.id === "long.md").map(({ hash }) => hash)
    expect(pieces.length).toBeGreaterThan(1)
    const kept = left
      .prepare(`SELECT count(*) AS n FROM embeddings WHERE content_hash IN (${pieces.map(() => "?").join(",")})`)
      .get(...pieces) as { n: number }
    left.close()
    expect(kept.n).toBe(0)
  })
})
