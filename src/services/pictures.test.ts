import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import type { Messenger } from "../cli/messenger/context.js"
import type { Message } from "../domain/models.js"
import type { PictureEmbedder } from "../images/picture/embedder.js"
import { imageModel } from "../images/picture/models.js"
import type { MessengerAdapter, RemoteFile } from "../ports/messenger.js"
import type { SendGuard } from "../sends/guard.js"
import { openStore } from "../store/store.js"
import { storedDeps } from "./deps.js"
import type { MessagesService } from "./messages.js"
import { PICTURES_OFF, picturesService, plainWords, withPictures } from "./pictures.js"

const model = imageModel("clip-b32")
const account = { provider: "test", account: "1" }
const START = Date.parse("2026-10-01T10:00:00Z")

const photo = (id: string, minute: number): Message => ({
  id,
  chatId: "9",
  senderId: "100",
  senderName: "Anna",
  timestamp: new Date(START + minute * 60_000).toISOString(),
  editedAt: null,
  text: "",
  outgoing: false,
  attachments: [{ kind: "photo", mime: "image/jpeg" }],
  replyTo: null,
  forwardedFrom: null,
  reactions: null,
})

/** A picture's "bytes" are its number; the fake model puts the picture on that axis, a query on its word's axis. */
const WORDS = ["cat", "receipt", "beach"]
const fakeEmbedder = (): PictureEmbedder & { images: number } => {
  const embedder = {
    model,
    images: 0,
    embedImage: async (bytes: Uint8Array) => {
      embedder.images += 1
      const vector = new Float32Array(model.dims)
      vector[bytes[0] as number] = 1
      return vector
    },
    embedQuery: async (text: string) => {
      const vector = new Float32Array(model.dims)
      vector[Math.max(0, WORDS.indexOf(text))] = 1
      return vector
    },
    close: async () => {},
  }
  return embedder
}

const setUp = async ({ pictures = true, renews = false }: { pictures?: boolean; renews?: boolean } = {}) => {
  const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "pictures-")), "m.db") })
  await store.chats.saveChats(account, [
    { id: "9", title: "Chat 9", kind: "group", unreadCount: 0, lastMessageAt: null, participantsCount: null },
  ])
  await store.messages.saveMessages(account, "9", [photo("1", 0), photo("2", 1), photo("3", 2)], { via: "history" })
  const embedder = fakeEmbedder()
  const downloads: string[] = []
  const adapter = {
    download: async (_chat: string, id: string) => {
      downloads.push(id)
      const file: RemoteFile = {
        kind: "photo",
        position: 0,
        bytes: async function* () {
          yield Uint8Array.of(Number(id) - 1)
          if (renews) file.providerRef = { directPath: `/synthetic/fresh-${id}` }
        },
      }
      return { files: [file], skipped: [] }
    },
  } as unknown as MessengerAdapter
  const deps = {
    ...storedDeps({ provider: "test", app: { command: "chat" } } as Messenger, store, account, {} as SendGuard),
    connection: async () => adapter,
    pictures,
    pictureEmbedder: async () => embedder,
  }
  return { store, service: picturesService(deps), embedder, downloads }
}

describe("images embed", () => {
  it("writes a vector for each picture once, and reads none of them again on the next run", async () => {
    const { store, service, embedder, downloads } = await setUp()
    expect(await service.embed({ limit: 10, pauseMs: 0 })).toMatchObject({
      embedded: 3,
      skipped: 0,
      failed: 0,
      more: false,
    })
    expect(await service.embed({ limit: 10, pauseMs: 0 })).toMatchObject({ embedded: 0 })
    expect(embedder.images).toBe(3)
    expect(downloads).toEqual(["1", "2", "3"])
    await store.close()
  })

  it("saves a reference the messenger renewed while a picture was read, on its stored attachment", async () => {
    const { store, service } = await setUp({ renews: true })

    await service.embed({ limit: 10, pauseMs: 0 })
    const read = await store.messages.message(account, "2", { chatId: "9" })
    await store.close()

    expect(read?.attachments.map((one) => one.providerRef)).toEqual([{ directPath: "/synthetic/fresh-2" }])
  })

  it("stops at the limit and says more is left; the next run goes on", async () => {
    const { store, service } = await setUp()
    expect(await service.embed({ limit: 2, pauseMs: 0 })).toMatchObject({ embedded: 2, more: true })
    expect(await service.embed({ limit: 2, pauseMs: 0 })).toMatchObject({ embedded: 1, more: false })
    await store.close()
  })

  it("is refused for a profile that did not turn picture search on", async () => {
    const { store, service } = await setUp({ pictures: false })
    await expect(service.embed({ limit: 10 })).rejects.toThrow(PICTURES_OFF)
    await store.close()
  })

  it("is not undone by the text-side image chunks, which sit at another position", async () => {
    const { store, service } = await setUp()
    await service.embed({ limit: 10, pauseMs: 0 })
    await store.vectors.saveImageChunks(account, "9", [], [])
    expect(await store.vectors.picturesToEmbed(account, { limit: 10 })).toEqual([])
    await store.close()
  })
})

describe("the pictures lane", () => {
  it("ranks pictures by the cosine to the query, best first, and drops those under the floor", async () => {
    const { store, service } = await setUp()
    await service.embed({ limit: 10, pauseMs: 0 })
    const { pictures, picturesSkipped } = await service.lane("receipt")
    expect(picturesSkipped).toBeUndefined()
    expect(pictures?.map(({ messageId, score }) => [messageId, score])).toEqual([["2", 1]])
    expect(pictures?.[0]?.locator).toBe("msg:test/1/9/2")
    await store.close()
  })

  it("leaves the text hits as they were and adds the lane beside them", async () => {
    const { store, service } = await setUp()
    await service.embed({ limit: 10, pauseMs: 0 })
    const found = {
      items: [{ locator: "msg:test/1/9/1" }],
      hasMore: false,
      corrections: [],
      completeness: [],
      wordsReady: true,
    }
    const search = withPictures({ search: async () => found } as unknown as MessagesService, service)
    const answer = await search.search({
      kind: "messages",
      text: "from:anna receipt",
      limit: 10,
    } as never)
    expect(answer.items).toBe(found.items)
    expect(answer.pictures?.map(({ messageId }) => messageId)).toEqual(["2"])
    await store.close()
  })

  it("keeps to the one chat a chat: in the query chose", async () => {
    const { store, service } = await setUp()
    await store.chats.saveChats(account, [
      { id: "8", title: "Chat 8", kind: "group", unreadCount: 0, lastMessageAt: null, participantsCount: null },
    ])
    await store.messages.saveMessages(account, "8", [{ ...photo("2", 5), chatId: "8" }], { via: "history" })
    await service.embed({ limit: 10, pauseMs: 0 })
    const found = { items: [], hasMore: false, coverage: { chat: "9" } }
    const search = withPictures({ search: async () => found } as unknown as MessagesService, service)
    const answer = await search.search({ kind: "messages", text: "receipt chat:9", limit: 10 } as never)
    expect(answer.pictures?.map(({ locator }) => locator)).toEqual(["msg:test/1/9/2"])
    await store.close()
  })

  it("has no lane, and no note, for a profile with picture search off", async () => {
    const { store, service } = await setUp({ pictures: false })
    const search = withPictures(
      { search: async () => ({ items: [], hasMore: false }) } as unknown as MessagesService,
      service,
    )
    const answer = await search.search({ kind: "messages", text: "receipt", limit: 10 } as never)
    expect(answer).not.toHaveProperty("pictures")
    expect(answer).not.toHaveProperty("picturesSkipped")
    await store.close()
  })

  it("keeps mail and discovery out of it", async () => {
    const { store, service } = await setUp()
    const search = withPictures({ search: async () => ({ items: [] }) } as unknown as MessagesService, service)
    for (const request of [{ kind: "mail" }, { discover: true }]) {
      expect(await search.search({ ...request, text: "receipt" } as never)).toEqual({ items: [] })
    }
    await store.close()
  })
})

describe("plainWords", () => {
  it("keeps the words of a Lucene query and drops fields, operators and quotes", () => {
    expect(plainWords('from:anna AND (receipt OR "red cat") NOT in:work after:2026-01-01')).toBe("receipt red cat")
    expect(plainWords("text:beach has:photo")).toBe("beach")
    expect(plainWords("has:photo")).toBe("")
  })
})
