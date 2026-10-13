import { afterEach, describe, expect, it } from "vitest"
import { sampleMeeting } from "../meetings/testing/index.js"
import type { MessageStore } from "../store/store.js"
import { openTwinStore, SHARED_WORD, type TwinStore, twinAccount } from "../testing/twin-accounts.js"
import { type SearchAllWithMeetingsRequest, searchAllWithMeetings } from "./search-all-meetings.js"

const alpha = twinAccount("alpha")
const opened: MessageStore[] = []
afterEach(async () => {
  for (const store of opened.splice(0)) await store.close()
})

const twinStore = async (): Promise<TwinStore & { noteId: string }> => {
  const twin = await openTwinStore()
  opened.push(twin.store)
  const note = await twin.store.notes.addNote({ text: `${SHARED_WORD} written in memo` })
  await twin.store.fillSearchIndex({})
  return { ...twin, noteId: String(note.id) }
}

const search = (store: MessageStore, extra: Partial<SearchAllWithMeetingsRequest> = {}) =>
  searchAllWithMeetings(store, alpha, { text: SHARED_WORD, limit: 50, only: ["messages", "mail", "notes"], ...extra })

const keys = (accounts: { resource: string; provider: string; account: string }[]) =>
  accounts.map(({ resource, provider, account }) => `${resource} ${provider}:${account}`)

describe("search all --source", () => {
  it("reads each kind's accounts from the list, skips a kind it names none of, and says what it read", async () => {
    const { store } = await twinStore()
    const found = await search(store, { source: "synthetic:500,email:500" })
    expect(found.searched).toEqual(["messages", "mail"])
    expect(keys(found.accounts)).toEqual(["messages synthetic:500", "mail email:500"])
    expect(found.skipped).toEqual([{ resource: "notes", reason: "--source names no notes account" }])
    expect(found.items.length).toBeGreaterThan(0)
    expect(found.items.every(({ account }) => account === "500")).toBe(true)
  })

  it("finds a note again by the provider:account its hit shows", async () => {
    const { store, twins } = await twinStore()
    const notes = (await search(store, { only: ["notes"] })).items
    expect(new Set(notes.map(({ account }) => account))).toEqual(
      new Set(["internal", twins.alpha.folderId, twins.bravo.folderId]),
    )
    for (const hit of notes) {
      const again = await search(store, { only: ["notes"], source: `${hit.provider}:${hit.account}` })
      expect(again.items.map(({ ref }) => ref)).toContain(hit.ref)
      expect(again.items.every(({ account }) => account === hit.account)).toBe(true)
      expect(keys(again.accounts)).toEqual([`notes notes:${hit.account}`])
    }
  })

  it("reads memo's notes beside one folder without the other folder", async () => {
    const { store, twins } = await twinStore()
    const found = await search(store, { only: ["notes"], source: `notes:internal,notes:${twins.alpha.folderId}` })
    expect(new Set(found.items.map(({ account }) => account))).toEqual(new Set(["internal", twins.alpha.folderId]))
    expect(keys(found.accounts)).toEqual(["notes notes:internal", `notes notes:${twins.alpha.folderId}`])
  })

  it("takes a group of mixed kinds and names what --only leaves out", async () => {
    const { store, twins } = await twinStore()
    await store.saveAccountGroup("work", ["synthetic:500", "email:500", `notes:${twins.alpha.folderId}`])
    expect(keys((await search(store, { source: "group:work" })).accounts)).toEqual([
      "messages synthetic:500",
      "mail email:500",
      `notes notes:${twins.alpha.folderId}`,
    ])
    const narrowed = await search(store, { only: ["messages"], source: "group:work" })
    expect(narrowed.skipped).toEqual([
      { source: "email:500", reason: "--only leaves mail out" },
      { source: `notes:${twins.alpha.folderId}`, reason: "--only leaves notes out" },
    ])
    await expect(search(store, { only: ["messages"], source: "email:500" })).rejects.toThrow(
      "--source names nothing search all reads: email:500 (--only leaves mail out)",
    )
  })

  it("reads meetings only from a meeting account the list names, and one at a time", async () => {
    const { store } = await twinStore()
    const zoom = { provider: "zoom", account: "z1" }
    const meeting = sampleMeeting()
    meeting.meeting.accountId = await store.saveAccount(zoom, { name: null })
    const [row] = meeting.transcripts?.[0]?.rows ?? []
    if (row) row.text = `${SHARED_WORD} on the call`
    await store.meetings.saveMeeting(meeting)
    const found = await search(store, { only: undefined, source: "synthetic:500,meetings" })
    expect(found.searched).toEqual(["messages", "meetings"])
    expect(keys(found.accounts)).toEqual(["messages synthetic:500", "meetings zoom:z1"])
    expect(found.items.some(({ kind }) => kind === "meeting")).toBe(true)
    const other = sampleMeeting()
    other.meeting.accountId = await store.saveAccount({ provider: "zoom", account: "z2" }, { name: null })
    const narrowed = await search(store, { only: undefined, source: "zoom" })
    expect(keys(narrowed.accounts)).toEqual(["meetings zoom:z1"])
    expect(narrowed.skipped).toContainEqual({ source: "zoom:z2", reason: "no meetings stored for it" })
    await store.meetings.saveMeeting(other)
    await expect(search(store, { only: undefined, source: "zoom" })).rejects.toThrow(
      "--source names several meeting accounts; search all reads one: zoom:z1, zoom:z2",
    )
  })

  it("answers the accounts it read without --source too", async () => {
    const { store, twins } = await twinStore()
    const found = await search(store)
    expect(keys(found.accounts)).toEqual(
      expect.arrayContaining([
        "messages synthetic:500",
        "messages synthetic:600",
        "mail email:500",
        "mail email:600",
        "notes notes:internal",
        `notes notes:${twins.alpha.folderId}`,
        `notes notes:${twins.bravo.folderId}`,
      ]),
    )
  })
})
