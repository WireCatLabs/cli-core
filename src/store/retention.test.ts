import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import type { GroupMember } from "../domain/models.js"
import type { RetentionOptions } from "../domain/retention.js"
import { type AccountKey, openStore } from "./store.js"

const OWNER: AccountKey = { provider: "telegram", account: "1" }
const DAY = 86_400_000
const START = Date.parse("2026-09-01T12:00:00Z")
const member = (id: string, known = true): GroupMember => ({
  id,
  name: "Synthetic",
  username: null,
  role: "member",
  ...(known ? { joinedAt: new Date(START).toISOString() } : {}),
})
const setup = async () => {
  let now = START
  const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "retention-")), "store.db"), now: () => now })
  await store.chats.saveChats(OWNER, [
    { id: "7", title: "Synthetic group", kind: "group", unreadCount: 0, lastMessageAt: null, participantsCount: 4 },
  ])
  const roster = async (days: number, members: GroupMember[], complete: boolean) => {
    now = START + days * DAY
    return store.roster.saveRoster(OWNER, "7", {
      members,
      complete,
      participants: 4,
      observation: { observedAt: new Date(now).toISOString(), source: "remote_fetch" },
    })
  }
  const options = (): RetentionOptions => ({
    since: START,
    until: START,
    cutoff: now,
    checkpoints: [DAY, 7 * DAY, 30 * DAY],
    within: 7 * DAY,
    by: "week",
    timezone: "UTC",
    limit: 20,
  })
  return { store, roster, options }
}

describe("observed retention", () => {
  it("discloses unknown joins and separate observable, unknown and pending denominators", async () => {
    const { store, roster, options } = await setup()
    try {
      await roster(0, [member("2"), member("3"), member("4", false)], true)
      await roster(1.25, [member("2")], false)
      await roster(7.5, [member("2")], true)
      const found = await store.roster.retention?.(OWNER, "7", options())
      expect(found).toMatchObject({
        unknownJoin: 1,
        eligibleStays: 2,
        quality: { continuousSurvival: false, groupSilentRate: null },
      })
      expect(found?.items[0]).toMatchObject({ cohort: "2026-08-31", stays: 2 })
      expect(found?.items[0]?.checkpoints).toEqual([
        { ageMilliseconds: DAY, eligible: 2, observable: 1, present: 1, absent: 0, unknown: 1, pending: 0, rate: 1 },
        {
          ageMilliseconds: 7 * DAY,
          eligible: 2,
          observable: 2,
          present: 1,
          absent: 1,
          unknown: 0,
          pending: 0,
          rate: 0.5,
        },
        {
          ageMilliseconds: 30 * DAY,
          eligible: 0,
          observable: 0,
          present: 0,
          absent: 0,
          unknown: 0,
          pending: 2,
          rate: null,
        },
      ])
      expect(found?.evidence[0]?.checkpoints[0]).toMatchObject({
        observedAt: new Date(START + 1.25 * DAY).toISOString(),
        lagMilliseconds: 0.25 * DAY,
      })
      expect(found?.evidence.find((one) => one.person === "3")?.departure).toMatchObject({
        after: new Date(START).toISOString(),
        atOrBefore: new Date(START + 7.5 * DAY).toISOString(),
        early: "unknown",
      })
      expect(found?.evidence[0]?.activity).toMatchObject({ state: "no-observed-message", archiveCovered: false })
    } finally {
      await store.close()
    }
  })
  it("does not substitute an observation outside the checkpoint tolerance", async () => {
    const { store, roster, options } = await setup()
    try {
      await roster(0, [member("2")], true)
      await roster(3, [member("2")], true)
      const found = await store.roster.retention?.(OWNER, "7", options())
      expect(found?.evidence[0]?.checkpoints[0]).toMatchObject({ state: "unknown", observedAt: null })
      const before = found?.fingerprint
      await roster(4, [member("2")], true)
      expect((await store.roster.retention?.(OWNER, "7", options()))?.fingerprint).not.toBe(before)
    } finally {
      await store.close()
    }
  })
  it("rejects invalid and unbounded durations before querying", async () => {
    const { store, options } = await setup()
    try {
      await expect(store.roster.retention?.(OWNER, "7", { ...options(), checkpoints: [DAY, DAY] })).rejects.toThrow(
        "increasing",
      )
      await expect(store.roster.retention?.(OWNER, "7", { ...options(), limit: 101 })).rejects.toThrow("1–100")
    } finally {
      await store.close()
    }
  })

  it("purges an account together with every roster read it kept", async () => {
    const { store, roster, options } = await setup()
    try {
      await roster(0, [member("2"), member("3")], true)
      await roster(1, [member("2")], false)
      await store.accounts.purge(OWNER)
      await store.chats.saveChats(OWNER, [
        { id: "7", title: "Synthetic group", kind: "group", unreadCount: 0, lastMessageAt: null, participantsCount: 4 },
      ])

      expect((await store.roster.retention?.(OWNER, "7", options()))?.eligibleStays).toBe(0)
    } finally {
      await store.close()
    }
  })
})
