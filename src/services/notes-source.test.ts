import { afterEach, describe, expect, it, vi } from "vitest"
import type { MessageStore } from "../store/store.js"
import { openTwinStore, SHARED_WORD, twinAccount } from "../testing/twin-accounts.js"
import { searchNotesOf } from "./notes-search.js"

const alpha = twinAccount("alpha")
const opened: MessageStore[] = []
afterEach(async () => {
  for (const store of opened.splice(0)) await store.close()
})

const twinStore = async () => {
  const twin = await openTwinStore()
  opened.push(twin.store)
  for (const day of [1, 2, 3]) await twin.store.notes.addNote({ text: `${SHARED_WORD} written in memo, day ${day}` })
  await twin.store.fillSearchIndex({})
  return twin
}

const accountOf = (hit: { folder_id: string | null }) => hit.folder_id ?? "internal"

describe("search notes --source", () => {
  it("reads memo's notes beside one folder in one store query per lane (words, title), and pages it as one list", async () => {
    const { store, twins } = await twinStore()
    const source = `notes:internal,notes:${twins.alpha.folderId}`
    const spy = vi.spyOn(store.notes, "search")
    const whole = await searchNotesOf(store, alpha, SHARED_WORD, { accounts: source, limit: 50 })
    expect(spy).toHaveBeenCalledTimes(2)
    expect(new Set(whole.hits.map(accountOf))).toEqual(new Set(["internal", twins.alpha.folderId]))
    expect(whole.accounts.map(({ account }) => account)).toEqual(["internal", twins.alpha.folderId])
    expect(whole.skipped).toEqual([])

    const first = await searchNotesOf(store, alpha, SHARED_WORD, { accounts: source, limit: 2 })
    const rest = await searchNotesOf(store, alpha, SHARED_WORD, { accounts: source, limit: 50, offset: 2 })
    expect([...first.hits, ...rest.hits].map(({ ref }) => ref)).toEqual(whole.hits.map(({ ref }) => ref))
  })

  it("names an entry it cannot read in skipped, and fails when nothing fits", async () => {
    const { store, twins } = await twinStore()
    const found = await searchNotesOf(store, alpha, SHARED_WORD, {
      accounts: `notes:${twins.bravo.folderId},synthetic:500`,
      limit: 50,
    })
    expect(new Set(found.hits.map(accountOf))).toEqual(new Set([twins.bravo.folderId]))
    expect(found.skipped).toEqual([
      { source: "synthetic:500", code: "validation_error", reason: "messenger messages — search messages reads them" },
    ])
    await expect(searchNotesOf(store, alpha, SHARED_WORD, { accounts: "email:500", limit: 50 })).rejects.toThrow(
      "--source names nothing tg search notes reads: email:500",
    )
  })

  it("refuses a type: that leaves nothing of the list", async () => {
    const { store, twins } = await twinStore()
    await expect(
      searchNotesOf(store, alpha, `${SHARED_WORD} type:file`, { accounts: "notes:internal", limit: 50 }),
    ).rejects.toThrow("type:file reads notes folders, and --source names none")
    const files = await searchNotesOf(store, alpha, `${SHARED_WORD} type:file`, {
      accounts: `notes:internal,notes:${twins.alpha.folderId}`,
      limit: 50,
    })
    expect(new Set(files.hits.map(accountOf))).toEqual(new Set([twins.alpha.folderId]))
    expect(files.accounts.map(({ account }) => account)).toEqual([twins.alpha.folderId])
  })

  it("finds memo's notes beside a folder by meaning too", async () => {
    const { store, twins } = await twinStore()
    const chunks = await store.notes.chunksToEmbed("test:model:2", { limit: 100 })
    await store.saveVectors(
      "test:model:2",
      2,
      chunks.map(({ hash }) => ({ hash, vector: new Float32Array([1, 0]) })),
    )
    const nearest = (options: { folderIds: string[]; withInternal?: boolean }) =>
      store.notes
        .nearest("test:model:2", new Float32Array([1, 0]), { limit: 100, ...options })
        .then((found) => new Set(found.map(({ note }) => note.folderId ?? "internal")))
    expect(await nearest({ folderIds: [twins.alpha.folderId] })).toEqual(new Set([twins.alpha.folderId]))
    expect(await nearest({ folderIds: [twins.alpha.folderId], withInternal: true })).toEqual(
      new Set(["internal", twins.alpha.folderId]),
    )
  })
})
