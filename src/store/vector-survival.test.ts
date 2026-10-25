import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { chunkHash } from "../conversations/chunks.js"
import type { Message } from "../domain/models.js"
import { sampleMeeting } from "../meetings/testing/index.js"
import { purgeChats } from "./sqlite/chats.js"
import { openSqlite } from "./sqlite/open.js"
import { dropUnusedVectors } from "./sqlite/vector-index.js"
import { purgeVectorHashes } from "./sqlite/vectors.js"
import { openStore } from "./store.js"

const opened: { close(): unknown }[] = []
afterEach(async () => {
  for (const handle of opened.splice(0)) await handle.close()
})
const fixture = async () => {
  const path = join(mkdtempSync(join(tmpdir(), "zm-test-vector-survival-")), "fixture.db")
  const store = await openStore({ path, now: () => 1000 })
  opened.push(store)
  const context = { ...(await openSqlite(path)), now: () => 1000 }
  opened.push(context.database)
  return { store, context }
}

describe("shared vector hash survival", () => {
  it("keeps a live note's semantic result after deleting a message sharing the same vector", async () => {
    const { store } = await fixture()
    const text = "Invented shared message and note evidence"
    const hash = chunkHash(text)
    const account = { provider: "example", account: "invented" }
    const message: Message = {
      id: "one",
      chatId: "room",
      senderId: null,
      senderName: null,
      timestamp: "2026-10-11T00:00:00Z",
      editedAt: null,
      text,
      outgoing: false,
      attachments: [],
      replyTo: null,
      forwardedFrom: null,
      reactions: null,
    }
    await store.messages.saveMessages(account, "room", [message], { via: "fixture" })
    await store.conversations.replaceConversations(account, "room", {
      startedAt: 1000,
      algorithmVersion: 1,
      links: [],
      conversations: [["one"]],
      chunks: [[{ firstId: "one", lastId: "one", hash }]],
    })
    const note = await store.notes.addNote({ text })
    expect((await store.notes.chunksToEmbed("invented-model", { limit: 1 }))[0]?.hash).toBe(hash)
    await store.vectors.saveVectors("invented-model", 2, [{ hash, vector: new Float32Array([1, 0]) }])
    await store.messages.markDeleted(account, ["one"], { chatId: "room" })
    expect((await store.notes.nearest("invented-model", new Float32Array([1, 0]), { limit: 1 }))[0]?.note.id).toBe(
      note.id,
    )
    expect(
      await store.vectors.nearestConversations(account, {
        model: "invented-model",
        query: new Float32Array([1, 0]),
        limit: 1,
      }),
    ).toEqual([])
  })

  for (const corpus of ["note", "document", "meeting_transcript"] as const)
    it(`preserves every model's vector while a ${corpus} chunk still uses the hash`, async () => {
      const { store, context } = await fixture()
      let hash: string
      if (corpus === "note") await store.notes.addNote({ text: "Invented common evidence" })
      if (corpus === "document") {
        const folder = await store.notes.addFolder({ name: "Invented" })
        await store.notes.saveFileNote({
          folderId: folder.id,
          path: "example.md",
          title: "Example",
          text: "Invented common evidence",
        })
      }
      if (corpus === "meeting_transcript") {
        const accountId = await store.accounts.saveAccount(
          { provider: "example", account: "invented" },
          { name: "Invented" },
        )
        const sample = sampleMeeting()
        sample.meeting.accountId = accountId
        const saved = await store.meetings.saveMeeting(sample)
        const transcript = saved.transcripts[0]
        if (!transcript) throw new Error("Missing invented transcript")
        hash = "invented-transcript-chunk-hash"
        context.database
          .prepare(
            "INSERT INTO chunks (chunkable_type, chunkable_id, position, start_offset, end_offset, content_hash, created_at, updated_at) VALUES ('meeting_transcript', ?, 0, 0, 20, ?, 1, 1)",
          )
          .run(transcript.transcript.id, hash)
      } else {
        const [chunk] = await store.notes.chunksToEmbed("invented-model", { limit: 1 })
        if (!chunk) throw new Error("Missing invented note chunk")
        hash = chunk.hash
      }
      for (const model of ["invented-model-one", "invented-model-two"])
        await store.vectors.saveVectors(model, 2, [{ hash, vector: new Float32Array([1, 0]) }])
      const before = context.database
        .prepare("SELECT * FROM embeddings WHERE content_hash = ? ORDER BY model")
        .all(hash)
      purgeVectorHashes(context, [hash])
      expect(
        context.database.prepare("SELECT * FROM embeddings WHERE content_hash = ? ORDER BY model").all(hash),
      ).toEqual(before)
      context.database.prepare("DELETE FROM chunks WHERE chunkable_type = ? AND content_hash = ?").run(corpus, hash)
      purgeVectorHashes(context, [hash])
      expect(context.database.prepare("SELECT count(*) AS n FROM embeddings WHERE content_hash = ?").get(hash)?.n).toBe(
        0,
      )
    })

  it("drops every model's vector of a mail piece no chunk holds any more, and keeps one a chunk still holds", async () => {
    const { store, context } = await fixture()
    const used = "invented-used-hash"
    const unused = "invented-unused-hash"
    context.database
      .prepare(
        "INSERT INTO chunks (chunkable_type, chunkable_id, position, start_offset, end_offset, content_hash, created_at, updated_at) VALUES ('email_thread', 1, 0, 0, 20, ?, 1, 1)",
      )
      .run(used)
    for (const model of ["invented-model-one", "invented-model-two"])
      await store.vectors.saveVectors(model, 2, [
        { hash: used, vector: new Float32Array([1, 0]) },
        { hash: unused, vector: new Float32Array([0, 1]) },
      ])
    dropUnusedVectors(context.database, [used, unused, unused])
    const left = context.database.prepare("SELECT model, content_hash AS hash FROM embeddings ORDER BY model").all()
    expect(left).toEqual([
      { model: "invented-model-one", hash: used },
      { model: "invented-model-two", hash: used },
    ])
  })
})

const MODELS = ["invented-model-one", "invented-model-two"]
const account = { provider: "example", account: "invented" }
const SHARED = "invented-shared-hash"

const messageOf = (id: string, text: string, attachments: Message["attachments"] = []): Message => ({
  id,
  chatId: "room",
  senderId: null,
  senderName: null,
  timestamp: "2026-10-11T00:00:00Z",
  editedAt: null,
  text,
  outgoing: false,
  attachments,
  replyTo: null,
  forwardedFrom: null,
  reactions: null,
})

/** A chunk of another kind that holds `SHARED`, so its vectors must outlive every path below. */
const anchored = async () => {
  const fixed = await fixture()
  fixed.context.database
    .prepare(
      "INSERT INTO chunks (chunkable_type, chunkable_id, position, start_offset, end_offset, content_hash, created_at, updated_at) VALUES ('email_thread', 1, 0, 0, 20, ?, 1, 1)",
    )
    .run(SHARED)
  return fixed
}

const unusedVectors = (context: Awaited<ReturnType<typeof fixture>>["context"]) =>
  Number(
    context.database
      .prepare(
        "SELECT count(*) AS n FROM embeddings v WHERE NOT EXISTS (SELECT 1 FROM chunks k WHERE k.content_hash = v.content_hash)",
      )
      .get()?.n,
  )

const modelsOf = (context: Awaited<ReturnType<typeof fixture>>["context"], hash: string) =>
  context.database
    .prepare("SELECT model FROM embeddings WHERE content_hash = ? ORDER BY model")
    .all(hash)
    .map(({ model }) => String(model))

const messageVectors = async (store: Awaited<ReturnType<typeof fixture>>["store"], hashes: Record<string, string>) => {
  const pks = await store.vectors.messagesToEmbed(account, { model: MODELS[0] as string, after: 0, limit: 10 })
  for (const model of MODELS)
    await store.vectors.saveMessageVectors(
      account,
      model,
      2,
      pks.map(({ messagePk, text }) => ({
        messagePk,
        hash: hashes[text] as string,
        length: text.length,
        occurredAt: 1000,
        vector: new Float32Array([1, 0]),
      })),
    )
  return pks
}

describe("every path that drops chunks leaves no unused vector and keeps a shared one", () => {
  it("a message embedded again with other text", async () => {
    const { store, context } = await anchored()
    await store.messages.saveMessages(account, "room", [messageOf("one", "first"), messageOf("two", "second")], {
      via: "fixture",
    })
    await messageVectors(store, { first: SHARED, second: "invented-own-hash" })
    await messageVectors(store, { first: "invented-new-one", second: "invented-new-two" })
    expect(unusedVectors(context)).toBe(0)
    expect(modelsOf(context, SHARED)).toEqual(MODELS)
    expect(modelsOf(context, "invented-own-hash")).toEqual([])
  })

  it("a deleted message's chunk", async () => {
    const { store, context } = await anchored()
    await store.messages.saveMessages(account, "room", [messageOf("one", "first"), messageOf("two", "second")], {
      via: "fixture",
    })
    await messageVectors(store, { first: SHARED, second: "invented-own-hash" })
    await store.messages.markDeleted(account, ["one", "two"], { chatId: "room" })
    expect(await store.vectors.dropGoneMessages(account)).toBe(2)
    expect(unusedVectors(context)).toBe(0)
    expect(modelsOf(context, SHARED)).toEqual(MODELS)
  })

  it("an image's picture replaced by other bytes", async () => {
    const { store, context } = await anchored()
    await store.messages.saveMessages(
      account,
      "room",
      [messageOf("one", "", [{ kind: "photo", mime: "image/jpeg" }])],
      {
        via: "fixture",
      },
    )
    const [picture] = await store.vectors.picturesToEmbed(account, { limit: 10 })
    if (!picture) throw new Error("Missing invented picture")
    const save = (hash: string) =>
      Promise.all(
        MODELS.map((model) =>
          store.vectors.savePictures(account, model, 2, [
            { attachmentPk: picture.attachmentPk, hash, bytes: 1, occurredAt: 1000, vector: new Float32Array([1, 0]) },
          ]),
        ),
      )
    await save("invented-old-picture")
    await save(SHARED)
    expect(unusedVectors(context)).toBe(0)
    expect(modelsOf(context, "invented-old-picture")).toEqual([])
    await save("invented-new-picture")
    expect(unusedVectors(context)).toBe(0)
    expect(modelsOf(context, SHARED)).toEqual(MODELS)
  })

  it("a note whose text changed", async () => {
    const { store, context } = await anchored()
    const note = await store.notes.addNote({ text: "Invented first wording" })
    const [chunk] = await store.notes.chunksToEmbed(MODELS[0] as string, { limit: 1 })
    if (!chunk) throw new Error("Missing invented note chunk")
    for (const model of MODELS)
      await store.vectors.saveVectors(model, 2, [
        { hash: chunk.hash, vector: new Float32Array([1, 0]) },
        { hash: SHARED, vector: new Float32Array([0, 1]) },
      ])
    await store.notes.editNote(note.id, "Invented second wording", note.revision)
    await store.notes.chunksToEmbed(MODELS[0] as string, { limit: 1 })
    expect(unusedVectors(context)).toBe(0)
    expect(modelsOf(context, chunk.hash)).toEqual([])
    expect(modelsOf(context, SHARED)).toEqual(MODELS)
  })

  it("a meeting transcript whose text changed", async () => {
    const { store, context } = await anchored()
    const accountId = await store.accounts.saveAccount(account, { name: "Invented" })
    const sample = sampleMeeting()
    sample.meeting.accountId = accountId
    const saved = await store.meetings.saveMeeting(sample)
    await store.meetingVectors.rebuild({ accountId })
    const { items } = await store.meetingVectors.chunksToEmbed(MODELS[0] as string, { accountId, limit: 100 })
    for (const model of MODELS)
      await store.vectors.saveVectors(
        model,
        2,
        [...items.map(({ hash }) => hash), SHARED].map((hash) => ({ hash, vector: new Float32Array([1, 0]) })),
      )
    context.database
      .prepare("UPDATE meeting_transcript_rows SET text = 'Invented corrected wording' WHERE meeting_transcript_id = ?")
      .run(Number(saved.transcripts[0]?.transcript.id))
    await store.meetingVectors.rebuild({ accountId })
    expect(unusedVectors(context)).toBe(0)
    for (const { hash } of items) expect(modelsOf(context, hash)).toEqual([])
    expect(modelsOf(context, SHARED)).toEqual(MODELS)
  })

  it("a purged chat's message and conversation chunks", async () => {
    const { store, context } = await anchored()
    await store.messages.saveMessages(account, "room", [messageOf("one", "first"), messageOf("two", "second")], {
      via: "fixture",
    })
    await messageVectors(store, { first: SHARED, second: "invented-own-hash" })
    await store.conversations.replaceConversations(account, "room", {
      startedAt: 1000,
      algorithmVersion: 1,
      links: [],
      conversations: [["one", "two"]],
      chunks: [[{ firstId: "one", lastId: "two", hash: "invented-conversation-hash" }]],
    })
    for (const model of MODELS)
      await store.vectors.saveVectors(model, 2, [
        { hash: "invented-conversation-hash", vector: new Float32Array([1, 0]) },
      ])
    const chat = context.database.prepare("SELECT id FROM chats WHERE external_id = 'room'").get()
    purgeChats(context, [Number(chat?.id)])
    expect(context.database.prepare("SELECT count(*) AS n FROM chunks").get()?.n).toBe(1)
    expect(unusedVectors(context)).toBe(0)
    expect(modelsOf(context, SHARED)).toEqual(MODELS)
  })

  it("clearing a chat's vectors takes its message vectors too", async () => {
    const { store, context } = await anchored()
    await store.messages.saveMessages(account, "room", [messageOf("one", "first"), messageOf("two", "second")], {
      via: "fixture",
    })
    await messageVectors(store, { first: SHARED, second: "invented-own-hash" })
    expect(await store.vectors.clearVectors(account, "room", MODELS[0])).toBe(1)
    expect(modelsOf(context, "invented-own-hash")).toEqual([MODELS[1]])
    expect(await store.vectors.clearVectors(account, "room")).toBe(1)
    expect(modelsOf(context, "invented-own-hash")).toEqual([])
    expect(modelsOf(context, SHARED)).toEqual(MODELS)
  })
})
