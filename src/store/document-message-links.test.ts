import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import type { Message } from "../domain/models.js"
import { openStore } from "./store.js"

const owner = { provider: "chat", account: "synthetic" }
const fileId = "SyntheticDocument_000123"
const url = `https://docs.google.com/document/d/${fileId}/edit`
const message = (text: string, editedAt: string | null = null): Message => ({
  id: "1",
  chatId: "7",
  senderId: "9",
  senderName: "Synthetic editor",
  timestamp: "2025-01-01T00:00:00.000Z",
  editedAt,
  text,
  outgoing: false,
  attachments: [],
  replyTo: null,
  forwardedFrom: null,
  reactions: null,
})
const setup = async () => {
  const clock = { at: Date.parse("2026-01-01T00:00:00.000Z") }
  const store = await openStore({
    path: join(mkdtempSync(join(tmpdir(), "document-message-edits-")), "store.db"),
    now: () => clock.at,
  })
  const folder = await store.notes.addFolder({ name: "Synthetic documents" })
  const { note } = await store.notes.saveFileNote({
    folderId: folder.id,
    path: "source.md",
    title: "Synthetic source",
    text: "evidence",
  })
  await store.messages.saveMessages(owner, "7", [message("before the document link")], { via: "history" })
  const documents = [{ reference: note.ref, fileId }]
  return { store, clock, documents, reference: note.ref }
}

describe("incremental document links after stored message edits", () => {
  it.each([null, "2025-02-01T00:00:00.000Z"])(
    "uses local revision time with provider edit time %s and is idempotent",
    async (editedAt) => {
      const { store, clock, documents, reference } = await setup()
      try {
        const since = new Date(clock.at + 5_000).toISOString()
        await store.messages.saveMessages(owner, "7", [{ ...message(url), id: "older" }], { via: "history" })
        expect(await store.notes.linkMessages({ documents, since })).toBe(0)
        clock.at += 10_000
        await store.messages.saveMessages(owner, "7", [message(url, editedAt)], { via: "history" })
        expect(await store.notes.linkMessages({ documents, since })).toBe(1)
        expect(await store.notes.linkMessages({ documents, since })).toBe(0)
        expect((await store.notes.links({ to: reference })).map((link) => link.from)).toEqual([
          "msg:chat/synthetic/7/1",
        ])
      } finally {
        await store.close()
      }
    },
  )

  it("includes an edit exactly at the checkpoint boundary", async () => {
    const { store, clock, documents } = await setup()
    try {
      clock.at += 10_000
      const since = new Date(clock.at).toISOString()
      await store.messages.saveMessages(owner, "7", [message(url)], { via: "events" })
      expect(await store.notes.linkMessages({ documents, since })).toBe(1)
      expect(await store.notes.linkMessages({ documents, since: new Date(clock.at + 1).toISOString() })).toBe(0)
    } finally {
      await store.close()
    }
  })

  it("keeps same-ID messages in different accounts separate while linking across accounts", async () => {
    const { store, clock, documents, reference } = await setup()
    try {
      const other = { provider: "other", account: "synthetic" }
      await store.messages.saveMessages(other, "7", [message("before")], { via: "history" })
      const since = new Date(clock.at + 5_000).toISOString()
      clock.at += 10_000
      await store.messages.saveMessages(other, "7", [message(url)], { via: "events" })
      expect(await store.notes.linkMessages({ documents, since })).toBe(1)
      expect((await store.notes.links({ to: reference })).map((link) => link.from)).toEqual(["msg:other/synthetic/7/1"])
    } finally {
      await store.close()
    }
  })

  it("uses the current message text rather than a URL only in its revision history", async () => {
    const { store, clock, documents } = await setup()
    try {
      const since = new Date(clock.at + 5_000).toISOString()
      clock.at += 10_000
      await store.messages.saveMessages(owner, "7", [message(url)], { via: "events" })
      clock.at += 1_000
      await store.messages.saveMessages(owner, "7", [message(`opaque id ${fileId}`)], { via: "events" })
      expect(await store.notes.linkMessages({ documents, since })).toBe(0)
      clock.at += 1_000
      await store.messages.saveMessages(owner, "7", [message(url)], { via: "events" })
      expect(await store.notes.linkMessages({ documents, since })).toBe(1)
    } finally {
      await store.close()
    }
  })

  it("does not link a message deleted after its edit", async () => {
    const { store, clock, documents } = await setup()
    try {
      const since = new Date(clock.at + 5_000).toISOString()
      clock.at += 10_000
      await store.messages.saveMessages(owner, "7", [message(url)], { via: "events" })
      await store.messages.markDeleted(owner, ["1"], { chatId: "7" })
      expect(await store.notes.linkMessages({ documents, since })).toBe(0)
    } finally {
      await store.close()
    }
  })
})
