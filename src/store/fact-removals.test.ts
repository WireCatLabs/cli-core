import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { afterEach, describe, expect, it } from "vitest"
import { type MessageStore, openStore } from "./store.js"

let store: MessageStore | undefined
let path = ""
afterEach(async () => {
  await store?.close()
  store = undefined
})

const open = async () => {
  path = join(mkdtempSync(join(tmpdir(), "fact-removals-")), "wirecat.db")
  let at = Date.parse("2026-11-13T10:00:00Z")
  store = await openStore({ path, now: () => (at += 1000) })
  return store
}

describe("removing a fact", () => {
  it("logs that it was removed, by whom and why, and never what it said", async () => {
    const s = await open()
    const project = await s.knowledge.addProject({ name: "Lighthouse" })
    const fact = await s.facts.add({
      type: "fact",
      statement: "The budget is 40000 EUR",
      by: "owner",
      subject: project.ref,
    })

    await s.facts.remove(fact.ref, "owner", "  wrong number  ")

    const removed = await s.facts.removed()
    expect(removed).toEqual({
      items: [
        {
          fact: fact.ref,
          subject: project.ref,
          removedBy: "owner",
          bot: null,
          reason: "wrong number",
          removedAt: expect.any(String),
        },
      ],
      hasMore: false,
    })
    const rows = new DatabaseSync(path).prepare("SELECT * FROM fact_removals").all()
    expect(JSON.stringify(rows)).not.toContain("40000")
    expect(JSON.stringify(rows)).not.toContain("budget")
  })

  it("logs an agent's removal of its own proposal with the agent's reason", async () => {
    const s = await open()
    const mine = await s.facts.add({ type: "fact", statement: "Mine", by: { bot: "codex" } })

    await s.facts.remove(mine.ref, { bot: "codex", reason: "a duplicate" })

    expect((await s.facts.removed()).items).toMatchObject([
      { fact: mine.ref, subject: null, removedBy: "agent", bot: "codex", reason: "a duplicate" },
    ])
  })

  it("pages the log newest first", async () => {
    const s = await open()
    const first = await s.facts.add({ type: "fact", statement: "One", by: "owner" })
    const second = await s.facts.add({ type: "fact", statement: "Two", by: "owner" })
    await s.facts.remove(first.ref, "owner")
    await s.facts.remove(second.ref, "owner")

    const page = await s.facts.removed({ limit: 1 })
    expect(page.items.map((one) => [one.fact, one.reason])).toEqual([[second.ref, null]])
    expect(page.hasMore).toBe(true)
    expect((await s.facts.removed({ limit: 1, offset: 1 })).items.map((one) => one.fact)).toEqual([first.ref])
  })
})

describe("reversing a decision", () => {
  it("keeps the owner's reason", async () => {
    const s = await open()
    const decision = await s.facts.add({ type: "decision", statement: "Ship on Friday", by: "owner" })

    const reversed = await s.facts.reverse(decision.ref, "owner", "the client moved the date")

    expect(reversed).toMatchObject({
      status: "reversed",
      reversal: { by: "owner", bot: null, reason: "the client moved the date" },
    })
    expect((await s.facts.get(decision.ref)).reversal?.reason).toBe("the client moved the date")
  })
})
