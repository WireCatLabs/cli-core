import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { PictureEmbedder } from "../images/picture/embedder.js"
import { imageModel } from "../images/picture/models.js"
import { type MessageStore, openStore } from "../store/store.js"
import { removePicture, savePicture } from "./document-pictures.js"
import { searchNotes } from "./notes-search.js"

const model = imageModel("clip-b32")
const axis = (index: number) => Float32Array.from({ length: model.dims }, (_, i) => (i === index ? 1 : 0))
const WORDS: Record<string, number> = { cat: 1, dog: 2 }

const fake = () => {
  const embedded: number[] = []
  const embedder: PictureEmbedder = {
    model,
    embedImage: async (bytes) => {
      embedded.push(bytes[0] as number)
      return axis(bytes[0] as number)
    },
    embedQuery: async (text) => axis(WORDS[text] ?? 9),
    close: async () => {},
  }
  return { embedder, embedded }
}

const live: MessageStore[] = []
afterEach(async () => {
  for (const store of live.splice(0)) await store.close()
})
const open = async () => {
  const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "doc-pictures-")), "store.db") })
  live.push(store)
  const folder = await store.notes.addFolder({ name: "drive" })
  const add = async (folderId: string, path: string) =>
    (await store.notes.saveFileNote({ folderId, path, title: path, text: "" })).note.ref
  return { store, folder, add }
}

describe("savePicture", () => {
  it("writes once, skips the same bytes and replaces different ones", async () => {
    const { store, folder, add } = await open()
    const ref = await add(folder.id, "cat.png")
    const { embedder, embedded } = fake()

    expect(await savePicture(store, { ref }, Uint8Array.of(1), { embedder })).toBe("saved")
    expect(await savePicture(store, { ref }, Uint8Array.of(1), { embedder })).toBe("unchanged")
    expect(embedded).toEqual([1])

    expect(await savePicture(store, { documentId: ref.split(":")[1] as string }, Uint8Array.of(2), { embedder })).toBe(
      "saved",
    )
    expect(embedded).toEqual([1, 2])
    expect(await store.notes.nearestPictures(model.key, axis(1), { limit: 10 })).toHaveLength(1)
    const near = await store.notes.nearestPictures(model.key, axis(2), { limit: 5 })
    expect(near).toEqual([{ ref, score: 1 }])
  })

  it("names the tool's download command when the model is missing, and no other tool's", async () => {
    const { store, folder, add } = await open()
    const ref = await add(folder.id, "cat.png")
    const env = { WIRECAT_STATE_DIR: mkdtempSync(join(tmpdir(), "no-model-")) }
    await expect(savePicture(store, { ref }, Uint8Array.of(1), { env, command: "max" })).rejects.toMatchObject({
      code: "not_found",
      message: expect.stringContaining("`max images models download clip-b32`"),
    })
    await expect(savePicture(store, { ref }, Uint8Array.of(1), { env })).rejects.toThrow(
      "install it with a WireCat CLI that has `images models download` (tg, max or wa)",
    )
  })
})

describe("searchNotes with pictures", () => {
  it("returns the nearest document, scoped by folder, and nothing when off", async () => {
    const { store, folder, add } = await open()
    const other = await store.notes.addFolder({ name: "other" })
    const cat = await add(folder.id, "cat.png")
    const dog = await add(folder.id, "dog.png")
    const stray = await add(other.id, "cat2.png")
    const { embedder } = fake()
    for (const [ref, byte] of [
      [cat, 1],
      [dog, 2],
      [stray, 1],
    ] as const)
      await savePicture(store, { ref }, Uint8Array.of(byte), { embedder })

    const found = await searchNotes(store, "cat", { pictures: true, pictureEmbedder: embedder, folderIds: [folder.id] })
    expect(found.pictures).toEqual([{ ref: cat, score: 1 }])
    const off = await searchNotes(store, "cat", { pictureEmbedder: embedder, folderIds: [folder.id] })
    expect(found.hits).toEqual(off.hits)
    expect(off).not.toHaveProperty("pictures")
    expect(off).not.toHaveProperty("pictures_skipped")
  })

  it("notes why when the model is missing", async () => {
    const { store } = await open()
    const found = await searchNotes(store, "cat", {
      pictures: true,
      env: { WIRECAT_STATE_DIR: mkdtempSync(join(tmpdir(), "no-model-")) },
    })
    expect(found.pictures_skipped).toContain("images models download")
    expect(found.pictures).toBeUndefined()
  })

  it("leaves no hit for a deleted document, and removePicture drops one", async () => {
    const { store, folder, add } = await open()
    const cat = await add(folder.id, "cat.png")
    const dog = await add(folder.id, "dog.png")
    const { embedder } = fake()
    await savePicture(store, { ref: cat }, Uint8Array.of(1), { embedder })
    await savePicture(store, { ref: dog }, Uint8Array.of(2), { embedder })

    await store.notes.deleteFileNotes(folder.id, ["cat.png"])
    expect((await searchNotes(store, "cat", { pictures: true, pictureEmbedder: embedder })).pictures).toEqual([])

    expect(await removePicture(store, { ref: dog })).toBe(true)
    expect(await removePicture(store, { ref: dog })).toBe(false)
    expect((await searchNotes(store, "dog", { pictures: true, pictureEmbedder: embedder })).pictures).toEqual([])
  })
})
