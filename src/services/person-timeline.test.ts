import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { type MessageStore, openStore } from "../store/store.js"
import { personTimeline } from "./person-timeline.js"

const opened: MessageStore[] = []
afterEach(async () => {
  for (const store of opened.splice(0)) await store.close()
})

const tg = { provider: "telegram", account: "500" }
const said = (id: string, timestamp: string) => ({
  id,
  chatId: "31",
  senderId: "21",
  senderName: "Alice Example",
  timestamp,
  editedAt: null,
  text: "synthetic",
  outgoing: false,
  attachments: [],
  replyTo: null,
  forwardedFrom: null,
  reactions: null,
})

const fixture = async () => {
  const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "person-timeline-paging-")), "store.db") })
  opened.push(store)
  await store.saveChats(tg, [
    { id: "31", title: "Example group", kind: "group", unreadCount: 0, lastMessageAt: null, participantsCount: 2 },
  ])
  const days = ["01", "02", "03", "03", "04", "05", "06"]
  await store.saveMessages(
    tg,
    "31",
    days.map((day, at) => said(String(at + 1), `2026-09-${day}T10:00:00.000Z`)),
    { via: "test" },
  )
  return store
}

const pages = async (store: MessageStore, options: Parameters<typeof personTimeline>[3]) => {
  const out: Awaited<ReturnType<typeof personTimeline>>[] = []
  let cursor: string | undefined
  do {
    const page = await personTimeline(store, tg, "21", { ...options, limit: 3, ...(cursor ? { cursor } : {}) })
    out.push(page)
    cursor = page.cursor
  } while (cursor && out.length < 10)
  return out
}

describe("personTimeline paging", () => {
  it("walks 7 items in 3 pages, each once, across two items sharing a time", async () => {
    const found = await pages(await fixture(), {})
    expect(found.map((page) => page.items.length)).toEqual([3, 3, 1])
    expect(found.map((page) => page.hasMore)).toEqual([true, true, false])
    expect(found.at(-1)?.cursor).toBeUndefined()
    const locators = found.flatMap((page) => page.items.map((item) => item.locator))
    expect(new Set(locators).size).toBe(7)
    expect(locators.map((locator) => locator?.split("/").at(-1))).toEqual(["7", "6", "5", "4", "3", "2", "1"])
  })

  it("keeps the filters the caller repeats on every page", async () => {
    const found = await pages(await fixture(), { since: Date.parse("2026-09-02T00:00:00Z") })
    const locators = found.flatMap((page) => page.items.map((item) => item.locator?.split("/").at(-1)))
    expect(locators).toEqual(["7", "6", "5", "4", "3", "2"])
    expect(found.map((page) => page.hasMore)).toEqual([true, false])
  })

  it("rejects a cursor it did not give", async () => {
    await expect(personTimeline(await fixture(), tg, "21", { cursor: "nope" })).rejects.toMatchObject({
      code: "validation_error",
    })
  })

  it("reports queued changes in pending, apart from paging", async () => {
    const store = await fixture()
    const queued = { ...store, involvements: { ...store.involvements, pending: () => 2 } } as MessageStore
    expect(await personTimeline(queued, tg, "21", { limit: 10 })).toMatchObject({ hasMore: false, pending: 2 })
  })
})
