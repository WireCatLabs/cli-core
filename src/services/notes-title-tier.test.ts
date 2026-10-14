import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { type MessageStore, openStore } from "../store/store.js"
import { searchNotes } from "./notes-search.js"

const live: MessageStore[] = []
afterEach(async () => {
  for (const store of live.splice(0)) await store.close()
})
const env = { WIRECAT_STATE_DIR: mkdtempSync(join(tmpdir(), "no-model-")) }

const seeded = async (files: { title: string; text: string }[]) => {
  const store = await openStore({
    path: join(mkdtempSync(join(tmpdir(), "title-tier-")), "store.db"),
    now: () => Date.parse("2026-10-01T10:00:00Z"),
  })
  live.push(store)
  const folder = await store.notes.addFolder({ name: "docs" })
  for (const [index, { title, text }] of files.entries())
    await store.notes.saveFileNote({ folderId: folder.id, path: `f${index}.md`, title, text })
  return { store, folder }
}
const titles = async (
  store: MessageStore,
  query: string,
  options: { exact?: boolean; limit?: number; offset?: number } = {},
) => (await searchNotes(store, query, { env, ...options })).hits.map(({ title }) => title)

const filler = Array.from({ length: 3000 }, (_, index) => `filler${index}`).join(" ")
const repeated = Array.from({ length: 12 }, (_, index) => ({
  title: `Note ${index}`,
  text: "quokka plan quokka plan quokka plan",
}))

describe("a title that holds the query comes first", () => {
  it.each([false, true])(
    "ranks a long file whose only match is its title above short files repeating the words (exact=%s)",
    async (exact) => {
      const { store } = await seeded([...repeated, { title: "Quokka plan", text: filler }])
      const hits = (await searchNotes(store, "quokka plan", { env, exact })).hits
      expect(hits[0]).toMatchObject({ title: "Quokka plan", found_by: expect.arrayContaining(["title"]) })
      expect(hits).toHaveLength(13)
    },
  )

  it("puts a title equal to the query before one that only contains it", async () => {
    const { store } = await seeded([
      { title: "Alpha beta gamma", text: "alpha beta" },
      { title: "Notes", text: "alpha beta alpha beta" },
      { title: "ALPHA beta", text: filler },
    ])
    expect((await titles(store, "alpha beta")).slice(0, 2)).toEqual(["ALPHA beta", "Alpha beta gamma"])
  })

  it("does not lift a title that holds only one of the words", async () => {
    const { store } = await seeded([...repeated, { title: "Quokka", text: filler }])
    const hits = await titles(store, "quokka plan")
    expect(hits).not.toContain("Quokka")
    expect(hits[0]).not.toBe("Quokka")
  })

  it("lists each note once and continues after the tier on page 2", async () => {
    const { store } = await seeded([
      { title: "Quokka plan A", text: filler },
      { title: "Quokka plan B", text: filler },
      ...repeated,
    ])
    const first = await searchNotes(store, "quokka plan", { env, limit: 3 })
    const second = await searchNotes(store, "quokka plan", { env, limit: 3, offset: 3 })
    const all = await titles(store, "quokka plan", { limit: 20 })
    expect(
      first.hits
        .slice(0, 2)
        .map(({ title }) => title)
        .sort(),
    ).toEqual(["Quokka plan A", "Quokka plan B"])
    expect([...first.hits, ...second.hits].map(({ title }) => title)).toEqual(all.slice(0, 6))
    expect(new Set(all).size).toBe(all.length)
    expect(first.has_more).toBe(true)
  })

  it("leaves a query with syntax in its own order", async () => {
    const { store } = await seeded([...repeated, { title: "Quokka plan", text: filler }])
    for (const query of ["title:x OR quokka", '"quokka plan" AND quokka', "quok*", "/quok.*/", "quokka OR plan"])
      expect(
        (await searchNotes(store, query, { env, limit: 20 })).hits.every(({ found_by }) => !found_by.includes("title")),
      ).toBe(true)
  })

  it("keeps a tag or filter narrowing the tier", async () => {
    const { store, folder } = await seeded([{ title: "Quokka plan", text: "x" }])
    const other = await store.notes.addFolder({ name: "other" })
    await store.notes.saveFileNote({ folderId: other.id, path: "o.md", title: "Quokka plan", text: "x" })
    const hits = (await searchNotes(store, "quokka plan", { env, folderIds: [folder.id] })).hits
    expect(hits.map(({ folder_id }) => folder_id)).toEqual([folder.id])
  })
})
