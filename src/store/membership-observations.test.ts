import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import type { GroupMember } from "../domain/models.js"
import { openCache } from "./open.js"
import { type AccountKey, openStore } from "./store.js"

const OWNER: AccountKey = { provider: "telegram", account: "1" }
const DAY = 86_400_000
const START = Date.parse("2026-09-01T12:00:00Z")
const member = (joinedAt?: string): GroupMember => ({
  id: "2",
  name: "Synthetic member",
  username: null,
  role: "member",
  ...(joinedAt ? { joinedAt } : {}),
})
const setup = async () => {
  let now = START
  const path = join(mkdtempSync(join(tmpdir(), "membership-observations-")), "store.db")
  const store = await openStore({ path, now: () => now })
  await store.chats.saveChats(OWNER, [
    { id: "7", title: "Synthetic group", kind: "group", unreadCount: 0, lastMessageAt: null, participantsCount: 1 },
  ])
  return {
    path,
    store,
    advance: () => {
      now += DAY
    },
    observation: () => ({ observedAt: new Date(now).toISOString(), source: "remote_fetch" as const }),
  }
}

describe("membership observation history", () => {
  it("records every explicit batch, including partial absence, in daily counts", async () => {
    const { store, path, advance, observation } = await setup()
    try {
      await store.roster.saveRoster(OWNER, "7", { members: [member()], complete: true, participants: 1 })
      advance()
      await store.roster.saveRoster(OWNER, "7", {
        members: [member()],
        complete: false,
        participants: 1,
        observation: observation(),
      })
      advance()
      await store.roster.saveRoster(OWNER, "7", {
        members: [],
        complete: false,
        participants: 1,
        observation: observation(),
      })
      expect((await store.roster.memberStays(OWNER, "7"))[0]).toMatchObject({ goneAt: null, joinedAt: null })
      advance()
      await store.roster.saveRoster(OWNER, "7", {
        members: [],
        complete: true,
        participants: 0,
        observation: observation(),
      })
      expect((await store.roster.memberStays(OWNER, "7"))[0]?.goneAt).toBe(new Date(START + 3 * DAY).toISOString())
      const db = await openCache(path)
      try {
        expect(
          db.prepare("SELECT complete_list,listed_count,created_at FROM member_counts ORDER BY date").all(),
        ).toEqual([
          { complete_list: 1, listed_count: 1, created_at: START },
          { complete_list: 0, listed_count: 1, created_at: START + DAY },
          { complete_list: 0, listed_count: 0, created_at: START + 2 * DAY },
          { complete_list: 1, listed_count: 0, created_at: START + 3 * DAY },
        ])
      } finally {
        db.close()
      }
    } finally {
      await store.close()
    }
  })
  it("splits a definite rejoin into separate stays and retains both stays", async () => {
    const { store, path, advance, observation } = await setup()
    try {
      await store.roster.saveRoster(OWNER, "7", {
        members: [member(new Date(START - DAY).toISOString())],
        complete: true,
        participants: 1,
        observation: observation(),
      })
      advance()
      const changedJoin = new Date(START + 1000).toISOString()
      await store.roster.saveRoster(OWNER, "7", {
        members: [member(changedJoin)],
        complete: true,
        participants: 1,
        observation: observation(),
      })
      expect(await store.roster.memberStays(OWNER, "7")).toMatchObject([
        { goneAt: changedJoin },
        { joinedAt: changedJoin, goneAt: null },
      ])
      const db = await openCache(path)
      try {
        expect(db.prepare("SELECT count(*) AS n FROM member_stays").get()?.n).toBe(2)
      } finally {
        db.close()
      }
    } finally {
      await store.close()
    }
  })
  it("rejects duplicate or out-of-order snapshots atomically", async () => {
    const { store, path, advance, observation } = await setup()
    try {
      await expect(
        store.roster.saveRoster(OWNER, "7", {
          members: [member(), member()],
          complete: true,
          participants: 1,
          observation: observation(),
        }),
      ).rejects.toThrow("duplicate")
      advance()
      await store.roster.saveRoster(OWNER, "7", {
        members: [member()],
        complete: true,
        participants: 1,
        observation: observation(),
      })
      await expect(
        store.roster.saveRoster(OWNER, "7", {
          members: [],
          complete: true,
          participants: 0,
          observation: { observedAt: new Date(START).toISOString(), source: "remote_fetch" },
        }),
      ).rejects.toThrow("predates")
      expect((await store.roster.memberStays(OWNER, "7"))[0]?.goneAt).toBeNull()
      const db = await openCache(path)
      try {
        expect(db.prepare("SELECT count(*) AS n FROM member_counts").get()?.n).toBe(1)
      } finally {
        db.close()
      }
    } finally {
      await store.close()
    }
  })
})
