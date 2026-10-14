import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import type { Chat } from "../domain/models.js"
import { type AccountKey, openStore } from "./store.js"

const fresh = () => join(mkdtempSync(join(tmpdir(), "contacts-")), "messages.db")
const OWNER: AccountKey = { provider: "max", account: "1" }
const OTHER: AccountKey = { provider: "max", account: "2" }

const chat = (id: string, kind: Chat["kind"], lastMessageAt: string | null): Chat => ({
  id,
  title: null,
  kind,
  unreadCount: 0,
  lastMessageAt,
  participantsCount: null,
})

/** Vera and Anna each have a dialog with the owner; Boris is only in a group. */
const seeded = async () => {
  const store = await openStore({ path: fresh() })
  await store.savePeople(OWNER, [
    { id: "1", name: "Owner" },
    { id: "7", name: "Vera", description: "València" },
    { id: "8", name: "Anna", username: "anna_k" },
    { id: "9", name: "Boris" },
  ])
  await store.saveChats(OWNER, [
    chat("d7", "dialog", "2026-09-01T00:00:00.000Z"),
    chat("d8", "dialog", "2026-09-20T00:00:00.000Z"),
    chat("-1", "group", "2026-09-29T00:00:00.000Z"),
  ])
  await store.saveMembers(OWNER, "d7", ["1", "7"])
  await store.saveMembers(OWNER, "d8", ["1", "8"])
  await store.saveMembers(OWNER, "-1", ["1", "7", "8", "9"])
  return store
}

const ids = (page: { items: { id: string }[] }) => page.items.map(({ id }) => id)

describe("contacts", () => {
  it("**are the people in the account's one-to-one chats**, never the account itself", async () => {
    const store = await seeded()

    expect(ids(await store.contacts(OWNER, { order: "name", limit: 10 }))).toEqual(["8", "7"])
    expect(await store.countContacts(OWNER)).toBe(2)
    expect((await store.contacts(OWNER, { order: "name", limit: 10 })).items[1]).toEqual({
      id: "7",
      name: "Vera",
      username: null,
      description: "València",
      lastMessagedAt: null,
    })
    await store.close()
  })

  it("**order by the newest one-to-one message** once recency is worked out, then by name", async () => {
    const store = await seeded()
    await store.savePeople(OWNER, [{ id: "10", name: "Zoya" }])
    await store.saveChats(OWNER, [chat("d10", "dialog", null)])
    await store.saveMembers(OWNER, "d10", ["1", "10"])
    await store.refreshRecency(OWNER)

    const page = await store.contacts(OWNER, { order: "recent", limit: 10 })
    expect(ids(page)).toEqual(["8", "7", "10"])
    expect(page.items[0]?.lastMessagedAt).toBe("2026-09-20T00:00:00.000Z")
    expect(ids(await store.contacts(OWNER, { order: "recent", limit: 1, offset: 1 }))).toEqual(["7"])
    expect((await store.contacts(OWNER, { order: "recent", limit: 2 })).hasMore).toBe(true)
    await store.close()
  })

  it("find three letters of a name or username, and refuse fewer", async () => {
    const store = await seeded()

    expect(ids(await store.contacts(OWNER, { order: "name", query: "ver", limit: 10 }))).toEqual(["7"])
    expect(ids(await store.contacts(OWNER, { order: "name", query: "a_k", limit: 10 }))).toEqual(["8"])
    expect(await store.countContacts(OWNER, { query: "bor" })).toBe(0)
    await expect(store.contacts(OWNER, { order: "name", query: "ve", limit: 10 })).rejects.toMatchObject({
      code: "validation_error",
    })
    await store.close()
  })

  it("**find people by text in the owner's private notes**, Latin letters in any case", async () => {
    const store = await seeded()
    await store.addContactNote(OWNER, "7", "Met at the Valencia meetup")
    await store.addContactNote(OWNER, "8", "Книжный клуб по средам")
    const gone = await store.addContactNote(OWNER, "8", "valencia, once")
    await store.removeContactNote(OWNER, "8", gone.id)
    const found = async (notes: string) => ids(await store.contacts(OWNER, { order: "name", notes, limit: 10 }))

    expect(await found("VALENCIA")).toEqual(["7"])
    expect(await found("valencia meetup")).toEqual(["7"])
    expect(await found("клуб")).toEqual(["8"])
    expect(await found("")).toEqual(["8", "7"])
    expect(await store.countContacts(OWNER, { notes: "valencia", query: "ann" })).toBe(0)
    await store.close()
  })

  it("keep a description a later, shorter record does not know", async () => {
    const store = await seeded()
    await store.savePeople(OWNER, [{ id: "7", name: "Vera P." }])

    expect((await store.contacts(OWNER, { order: "name", query: "vera", limit: 1 })).items[0]).toMatchObject({
      name: "Vera P.",
      description: "València",
    })
    await store.close()
  })

  it("belong to one account", async () => {
    const store = await seeded()

    expect(await store.contacts(OTHER, { order: "name", limit: 10 })).toEqual({ items: [], hasMore: false })
    expect(await store.countContacts(OTHER)).toBe(0)
    await store.refreshRecency(OTHER)
    await store.close()
  })
})
