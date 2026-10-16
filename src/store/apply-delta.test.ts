import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import type { Chat } from "../domain/models.js"
import { type AccountKey, openStore } from "./store.js"

const fresh = () => join(mkdtempSync(join(tmpdir(), "delta-")), "messages.db")
const OWNER: AccountKey = { provider: "max", account: "1" }

const chat = (id: string): Chat => ({
  id,
  title: `Chat ${id}`,
  kind: "group",
  unreadCount: 0,
  lastMessageAt: null,
  participantsCount: null,
})

describe("applying a catch-up", () => {
  it("**writes chats, people, members and state together**", async () => {
    const store = await openStore({ path: fresh() })
    await store.roster.saveMembers(OWNER, "-1", ["9"])

    await store.sync.applyDelta(OWNER, {
      chats: [chat("-1"), chat("-2")],
      people: [
        { id: "7", name: "Vera" },
        { id: "8", name: "Anna" },
      ],
      members: new Map([["-1", ["7", "8"]]]),
      state: { "login.marker": "1727690000000" },
    })

    expect((await store.chats.chats(OWNER, {})).items.map(({ id }) => id).sort()).toEqual(["-1", "-2"])
    expect((await store.roster.members(OWNER, "-1")).map(({ name }) => name)).toEqual(["Anna", "Vera"])
    expect(await store.sync.syncState(OWNER, "login.marker")).toMatchObject({ value: "1727690000000" })
    await store.close()
  })

  it("**writes nothing when any part fails**, so the marker never runs ahead of the rows", async () => {
    const store = await openStore({ path: fresh() })
    const broken = { ...chat("-2"), kind: null } as unknown as Chat

    await expect(
      store.sync.applyDelta(OWNER, {
        chats: [chat("-1"), broken],
        people: [{ id: "7", name: "Vera" }],
        state: { "login.marker": "5" },
      }),
    ).rejects.toThrow()

    expect((await store.chats.chats(OWNER, {})).items).toEqual([])
    expect(await store.sync.syncState(OWNER, "login.marker")).toBeUndefined()
    expect((await store.people.people("max", { account: "1" })).all()).toEqual([])
    await store.close()
  })

  it("takes an empty catch-up", async () => {
    const store = await openStore({ path: fresh() })
    await store.sync.applyDelta(OWNER, {})
    expect((await store.chats.chats(OWNER, {})).items).toEqual([])
    await store.close()
  })
})
