import { afterEach, describe, expect, it } from "vitest"
import type { MessageStore } from "../store/store.js"
import { CLIENT, CONTRACTOR, type FixtureChat, openTestStore, seedChat } from "../testing/project-status.js"
import { projectActivity } from "./project-activity.js"

const opened: MessageStore[] = []
afterEach(async () => {
  for (const store of opened.splice(0)) await store.close()
})

const NOW = Date.parse("2026-11-02T10:00:00.000Z")
const DAY = 86_400_000
const ago = (days: number) => new Date(NOW - days * DAY).toISOString()

const chat = (id: string, title: string, days: number[], account = CLIENT): FixtureChat => ({
  account,
  id,
  title,
  kind: "group",
  whole: true,
  messages: days.map((d, i) => ({ id: i + 1, at: ago(d), from: i % 2 ? "me" : "Ana", sender: "31", text: `m${i}` })),
})

const seeded = async () => {
  const store = await openTestStore()
  opened.push(store)
  const busy = await store.knowledge.addProject({ name: "Harbour site", key: "HRB" })
  const quiet = await store.knowledge.addProject({ name: "Old garden", key: "OLD" })
  const child = await store.knowledge.addProject({ name: "Harbour docks", key: "DCK" })
  await store.knowledge.addProject({ name: "No chats", key: "NOC" })
  await store.knowledge.relate(null, { by: "owner", from: child.ref, to: busy.ref, kind: "member-of", confirmed: true })
  await seedChat(store, chat("-900", "Harbour group", [1, 2, 3, 40]), busy.ref)
  await seedChat(store, chat("-901", "Docks crew", [5]), child.ref)
  await seedChat(store, chat("77", "Garden", [60, 90], CONTRACTOR), quiet.ref)
  return { store, busy: busy.ref, quiet: quiet.ref }
}

describe("projectActivity", () => {
  it("counts every project's linked chats, its children's included, busiest first", async () => {
    const { store, busy, quiet } = await seeded()
    const found = await projectActivity(store, { since: NOW - 30 * DAY, until: NOW, limit: 10, offset: 0 })

    expect(found.total).toBe(4)
    expect(found.items[0]).toEqual({
      ref: busy,
      key: "HRB",
      name: "Harbour site",
      chats: 2,
      muted: 0,
      messages: 4,
      sent: 1,
      lastAt: ago(1),
      top: [
        { ref: "chat:max/11/-900", title: "Harbour group", messages: 3 },
        { ref: "chat:max/11/-901", title: "Docks crew", messages: 1 },
      ],
    })
    const old = found.items.find((one) => one.ref === quiet)
    expect(old).toMatchObject({ chats: 1, messages: 0, lastAt: ago(60), top: [] })
    expect(found.items.at(-1)).toMatchObject({ key: "NOC", chats: 0, messages: 0, lastAt: null })
  })

  it("names a muted chat and leaves its messages out", async () => {
    const { store, busy } = await seeded()
    await store.chats.saveChats(CLIENT, [{ id: "-900", title: "Harbour group", kind: "group", muted: true }])
    const found = await projectActivity(store, { since: NOW - 30 * DAY, until: NOW, limit: 10, offset: 0 })

    expect(found.items.find((one) => one.ref === busy)).toMatchObject({ chats: 2, muted: 1, messages: 1, sent: 0 })
  })

  it("pages, and reads only the accounts it is given", async () => {
    const { store } = await seeded()
    const page = await projectActivity(store, { since: NOW - 30 * DAY, until: NOW, limit: 2, offset: 1 })
    expect(page.items).toHaveLength(2)
    expect(page.hasMore).toBe(true)

    const scoped = await projectActivity(store, {
      since: NOW - 120 * DAY,
      until: NOW,
      limit: 10,
      offset: 0,
      accounts: [CONTRACTOR],
    })
    expect(scoped.items.map((one) => [one.key, one.chats, one.messages])).toEqual([
      ["OLD", 1, 2],
      ["HRB", 0, 0],
      ["DCK", 0, 0],
      ["NOC", 0, 0],
    ])
  })

  it("refuses a window that ends before it starts", async () => {
    const { store } = await seeded()
    await expect(projectActivity(store, { since: NOW, until: NOW, limit: 1, offset: 0 })).rejects.toThrow(/window/)
  })
})
