import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { EntryInput } from "../meetings/index.js"
import { type MessageStore, openStore } from "./store.js"

const opened: MessageStore[] = []
afterEach(async () => {
  for (const store of opened.splice(0)) await store.close()
})

const setup = async () => {
  const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "attachments-")), "store.db") })
  opened.push(store)
  const accountId = await store.accounts.saveAccount(
    { provider: "google-calendar", account: "owner-1" },
    { name: null },
  )
  const [calendar] = await store.calendar.saveCalendars(
    accountId,
    [{ externalId: "primary", title: "Work", timezone: "UTC", accessRole: "owner", primary: true }],
    1,
  )
  const drive = String(
    await store.accounts.saveAccount({ provider: "google-drive", account: "owner-1" }, { name: null }),
  )
  return { store, calendar: calendar?.id as number, drive }
}

const driveFile = (store: MessageStore, drive: string, fileId: string) =>
  store.notes.saveFileNote({
    folderId: drive,
    path: `${fileId}.md`,
    title: "Plan",
    text: "the plan",
    frontMatter: { source: "google-drive", fileId },
  })

const planning = (attachments: EntryInput["attachments"]): EntryInput => ({
  externalId: "g1",
  kind: "single",
  status: "confirmed",
  title: "Planning",
  startsAt: 1_000,
  endsAt: 2_000,
  ...(attachments === undefined ? {} : { attachments }),
})

const attachmentsOf = async (store: MessageStore, eventId: number | null) =>
  (await store.calendar.event(eventId as number))?.attachments.map(({ fileId, title, documentId }) => ({
    fileId,
    title,
    documentId,
  }))

describe("a calendar entry's Drive attachments", () => {
  it("link the entry to the document of a Drive file already stored", async () => {
    const { store, calendar, drive } = await setup()
    const { note } = await driveFile(store, drive, "file-1")

    const [entry] = await store.calendar.saveEntries(calendar, [planning([{ fileId: "file-1", title: "Plan" }])], 1)

    expect(await attachmentsOf(store, entry?.eventId ?? null)).toEqual([
      { fileId: "file-1", title: "Plan", documentId: Number(note.id) },
    ])
  })

  it("link it once Drive stores the file, in whichever order the two sync", async () => {
    const { store, calendar, drive } = await setup()
    const [entry] = await store.calendar.saveEntries(calendar, [planning([{ fileId: "file-2" }])], 1)
    expect(await attachmentsOf(store, entry?.eventId ?? null)).toEqual([
      { fileId: "file-2", title: null, documentId: null },
    ])

    const { note } = await driveFile(store, drive, "file-2")

    expect(await attachmentsOf(store, entry?.eventId ?? null)).toEqual([
      { fileId: "file-2", title: null, documentId: Number(note.id) },
    ])
  })

  it("are replaced by the next list, and kept when the entry comes without one", async () => {
    const { store, calendar } = await setup()
    await store.calendar.saveEntries(calendar, [planning([{ fileId: "a" }, { fileId: "b" }])], 1)
    const [kept] = await store.calendar.saveEntries(calendar, [planning(undefined)], 2)
    expect((await attachmentsOf(store, kept?.eventId ?? null))?.map(({ fileId }) => fileId)).toEqual(["a", "b"])

    const [entry] = await store.calendar.saveEntries(calendar, [planning([{ fileId: "b" }, { fileId: "c" }])], 3)

    expect((await attachmentsOf(store, entry?.eventId ?? null))?.map(({ fileId }) => fileId)).toEqual(["b", "c"])
  })

  it("keep one link for a file the list names twice", async () => {
    const { store, calendar } = await setup()
    const [entry] = await store.calendar.saveEntries(calendar, [planning([{ fileId: "a" }, { fileId: " a " }])], 1)
    expect((await attachmentsOf(store, entry?.eventId ?? null))?.map(({ fileId }) => fileId)).toEqual(["a"])

    await store.calendar.saveEntries(calendar, [planning([{ fileId: "b" }])], 2)

    expect((await attachmentsOf(store, entry?.eventId ?? null))?.map(({ fileId }) => fileId)).toEqual(["b"])
  })

  it("show no document while the file's document is deleted, and show it again once Drive restores it", async () => {
    const { store, calendar, drive } = await setup()
    const { note } = await driveFile(store, drive, "file-3")
    const [entry] = await store.calendar.saveEntries(calendar, [planning([{ fileId: "file-3" }])], 1)

    await store.notes.deleteFileNotes(drive, ["file-3.md"])
    expect(await attachmentsOf(store, entry?.eventId ?? null)).toEqual([
      { fileId: "file-3", title: null, documentId: null },
    ])

    await driveFile(store, drive, "file-3")
    expect(await attachmentsOf(store, entry?.eventId ?? null)).toEqual([
      { fileId: "file-3", title: null, documentId: Number(note.id) },
    ])
  })

  it("link a waiting file once Drive stores it again after a deletion", async () => {
    const { store, calendar, drive } = await setup()
    const { note } = await driveFile(store, drive, "file-4")
    await store.notes.deleteFileNotes(drive, ["file-4.md"])
    const [entry] = await store.calendar.saveEntries(calendar, [planning([{ fileId: "file-4" }])], 1)
    expect((await attachmentsOf(store, entry?.eventId ?? null))?.[0]?.documentId).toBeNull()

    await driveFile(store, drive, "file-4")

    expect((await attachmentsOf(store, entry?.eventId ?? null))?.[0]?.documentId).toBe(Number(note.id))
  })

  it("link a waiting file when the entry is saved again after the other Drive account's copy was deleted", async () => {
    const { store, calendar, drive } = await setup()
    const other = String(
      await store.accounts.saveAccount({ provider: "google-drive", account: "owner-2" }, { name: null }),
    )
    const { note } = await driveFile(store, drive, "shared")
    await driveFile(store, other, "shared")
    await store.calendar.saveEntries(calendar, [planning([{ fileId: "shared" }])], 1)
    await store.notes.deleteFileNotes(other, ["shared"])

    const [entry] = await store.calendar.saveEntries(calendar, [planning([{ fileId: "shared" }])], 2)

    expect((await attachmentsOf(store, entry?.eventId ?? null))?.[0]?.documentId).toBe(Number(note.id))
  })

  it("make no link while two Drive accounts hold the same file", async () => {
    const { store, calendar, drive } = await setup()
    const other = String(
      await store.accounts.saveAccount({ provider: "google-drive", account: "owner-2" }, { name: null }),
    )
    await driveFile(store, drive, "shared")
    await driveFile(store, other, "shared")

    const [entry] = await store.calendar.saveEntries(calendar, [planning([{ fileId: "shared" }])], 1)

    expect(await attachmentsOf(store, entry?.eventId ?? null)).toEqual([
      { fileId: "shared", title: null, documentId: null },
    ])
  })
})
