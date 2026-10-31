import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { allHitItem, noteHitItem } from "../cli/messenger/search-answers.js"
import { openStore } from "../store/store.js"
import { searchNotesOf } from "./notes-search.js"
import { searchAllWithMeetings } from "./search-all-meetings.js"

const account = { provider: "synthetic", account: "500" }
describe("imported document search provenance", () => {
  it("finds registered Drive profiles in combined and note search and retains the Google URL and edit time", async () => {
    const directory = mkdtempSync(join(tmpdir(), "document-source-"))
    const store = await openStore({ path: join(directory, "store.db") })
    try {
      const folder = await store.notes.addFolder({ name: "google-drive:synthetic-owner" })
      await store.accounts.saveProfile("drive", "personal", { provider: "folder", account: folder.name })
      const { note } = await store.notes.saveFileNote({
        folderId: folder.id,
        path: "synthetic-doc.md",
        title: "Budget",
        text: "synthetic budget evidence",
        frontMatter: {
          source: "google-drive",
          sourceUrl: "https://docs.google.com/document/d/synthetic-document/edit",
          modifiedAt: "2026-01-01T00:00:00Z",
        },
      })
      const other = await store.notes.addFolder({ name: "google-drive:another-owner" })
      await store.notes.saveFileNote({
        folderId: other.id,
        path: "other.md",
        title: "Budget",
        text: "synthetic budget evidence",
      })
      const found = await searchNotesOf(store, account, "budget", { accounts: "drive:personal", exact: true })
      expect(found.hits).toHaveLength(1)
      expect(noteHitItem(required(found.hits[0]))).toMatchObject({
        ref: note.ref,
        kind: "document",
        provider: "drive",
        account: "personal",
        url: "https://docs.google.com/document/d/synthetic-document/edit",
        updated_at: "2026-01-01T00:00:00.000Z",
      })
      const all = await searchAllWithMeetings(store, account, {
        source: "drive:personal",
        text: "budget",
        exact: true,
        limit: 10,
      })
      expect(all.items).toHaveLength(1)
      expect(allHitItem(required(all.items[0]))).toMatchObject({
        ref: note.ref,
        kind: "document",
        provider: "drive",
        account: "personal",
        url: found.hits[0]?.url,
        timestamp: "2026-01-01T00:00:00.000Z",
      })
      expect((await searchNotesOf(store, account, "budget", { accounts: "drive", exact: true })).hits).toHaveLength(1)
    } finally {
      await store.close()
    }
  })
  it("falls back to local time and folder scope without a registered profile or valid remote time", async () => {
    const directory = mkdtempSync(join(tmpdir(), "document-source-"))
    const store = await openStore({ path: join(directory, "store.db") })
    try {
      const folder = await store.notes.addFolder({ name: "google-drive:synthetic-owner" })
      const { note } = await store.notes.saveFileNote({
        folderId: folder.id,
        path: "doc.md",
        title: "Budget",
        text: "budget",
        frontMatter: { source: "google-drive", modifiedAt: "invalid" },
      })
      const found = await searchNotesOf(store, account, "budget", { accounts: `notes:${folder.id}`, exact: true })
      expect(found.hits[0]).toMatchObject({
        kind: "document",
        provider: "notes",
        account: folder.id,
        updated_at: note.updatedAt,
      })
      expect(found.hits[0]).not.toHaveProperty("url")
    } finally {
      await store.close()
    }
  })
})

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("fixture hit missing")
  return value
}
