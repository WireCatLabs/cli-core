import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { openCache } from "./open.js"
import { type MessageStore, openStore } from "./store.js"

const live: MessageStore[] = []
afterEach(async () => {
  for (const store of live.splice(0)) await store.close()
})
const open = async () => {
  const path = join(mkdtempSync(join(tmpdir(), "list-offset-")), "store.db")
  const store = await openStore({ path })
  live.push(store)
  return { store, path }
}
const sameTime = async (path: string, table: string, column: string) => {
  const database = await openCache(path)
  try {
    database.prepare(`UPDATE ${table} SET ${column} = (SELECT min(${column}) FROM ${table})`).run()
  } finally {
    database.close()
  }
}
const ROWS = 520

const pages = async (read: (offset: number) => Promise<{ id: string }[]>) => {
  const first = await read(0)
  const second = await read(500)
  return { first: first.map(({ id }) => id), second: second.map(({ id }) => id) }
}
const descending = (ids: string[]) => [...ids].sort((a, b) => Number(b) - Number(a))

describe("an offset pages a list past the 500-row cap", () => {
  it("memories, facts, proposed actions and the agent log: no row twice, none left out, ties by id", async () => {
    const { store, path } = await open()
    const note = await store.notes.addNote({ text: "Alice Example prefers mornings" })
    const memories: string[] = []
    const facts: string[] = []
    const actions: string[] = []
    const calls: string[] = []
    for (let n = 0; n < ROWS; n++) {
      const memory = await store.memories.add({
        kind: "preference",
        body: `Synthetic memory ${n}`,
        scope: "work",
        evidence: [note.ref],
        author: "owner",
      })
      memories.push(memory.id)
      facts.push((await store.facts.add({ type: "decision", statement: `Synthetic fact ${n}`, by: "owner" })).id)
      actions.push((await store.proposedActions.propose({ kind: "reply", by: { bot: "helper" } })).id)
      const call = { tier: "read" as const, status: "ok" as const, startedAt: 1, finishedAt: 2 }
      calls.push((await store.agentActions.record({ ...call, actor: { bot: "memo-mcp" }, tool: "memories_list" })).id)
    }
    await sameTime(path, "memories", "created_at")
    await sameTime(path, "facts", "created_at")
    await sameTime(path, "proposed_actions", "created_at")

    const lists = {
      memories: [memories, (offset: number) => store.memories.list({ limit: 500, offset })],
      facts: [facts, (offset: number) => store.facts.list({ limit: 500, offset })],
      actions: [actions, (offset: number) => store.proposedActions.list({ limit: 500, offset })],
      calls: [calls, (offset: number) => store.agentActions.list({ limit: 500, offset })],
    } as const
    for (const [made, read] of Object.values(lists)) {
      const { first, second } = await pages(read)
      expect(first).toHaveLength(500)
      expect(second).toHaveLength(ROWS - 500)
      expect([...first, ...second]).toEqual(descending(made))
    }
  }, 60_000)
})
