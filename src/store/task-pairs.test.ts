import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import type { Message } from "../domain/models.js"
import { createTaskService, type NewTask } from "../tasks/index.js"
import { openStore } from "./store.js"

const account = { provider: "chat", account: "500" }
const taskAccount = "chat:500"

const said = (id: string, text: string, replyToId?: string): Message => ({
  id,
  chatId: "7",
  senderId: "9",
  senderName: "Alice Example",
  timestamp: `2026-10-06T10:${id.padStart(2, "0")}:00.000Z`,
  editedAt: null,
  text,
  outgoing: false,
  attachments: [],
  replyTo: null,
  ...(replyToId === undefined ? {} : { replyToId }),
  forwardedFrom: null,
  reactions: null,
})

const setup = async (messages: Message[]) => {
  const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "task-pairs-")), "wirecat.db") })
  await store.saveMessages(account, "7", messages, { via: "test" })
  const service = createTaskService({ store: store.tasks })
  const input = (message: string, origin: NewTask["origin"]): NewTask => ({
    source: `msg:chat/500/7/${message}`,
    sourceKind: "message",
    account: taskAccount,
    group: "7",
    kind: "request",
    origin,
    category: "money",
  })
  const agent = async (message: string, title: string) => {
    const { task } = await service.add(input(message, "agent"))
    await store.tasks.edit(task.id, { title }, "owner")
    return (await store.tasks.details(task.id)).key
  }
  const rule = async (message: string) => service.add(input(message, "rule"))
  const pairs = (decision: "review" | "unsure") => store.tasks.pairs(taskAccount, { decision, limit: 10, offset: 0 })
  return { store, agent, rule, pairs }
}

describe("task pairs", () => {
  it("**a rule opens the task anyway and sends a likely or maybe pair to the review list**, once", async () => {
    const { store, agent, rule, pairs } = await setup([
      said("1", "Could you pay the 15 000 rub invoice?"),
      said("2", "Any news on the payment?", "1"),
    ])
    const first = await agent("1", "Pay the 15 000 rub invoice")

    const opened = await rule("2")
    expect(opened).toMatchObject({ created: true, review: 1 })
    const [pair] = await pairs("review")
    expect(pair).toMatchObject({
      task: { key: opened.task.key ?? expect.any(String) },
      other: { key: first },
      band: expect.stringMatching(/likely|maybe/),
      levels: { reply: "yes" },
      decision: "review",
      decidedAt: null,
    })
    expect(pair?.reasons).toContain("in one reply chain")

    expect(await store.tasks.reviewDuplicates(opened.task.id)).toBe(0)
    expect(await rule("2")).toMatchObject({ created: false })
    expect(await pairs("review")).toHaveLength(1)
    await store.close()
  })

  it("**unsure passes a pair to the owner; rejected takes it off for good**, whichever way round it is named", async () => {
    const { store, agent, rule, pairs } = await setup([said("1", "pay the bill"), said("2", "and this?", "1")])
    const first = await agent("1", "Pay the bill")
    const { task } = await rule("2")
    const dup = (await store.tasks.details(task.id)).key

    await store.tasks.decidePair(dup, first, "unsure", { bot: "agent" })
    expect(await pairs("review")).toEqual([])
    expect(await pairs("unsure")).toMatchObject([{ decision: "unsure", decidedAt: expect.any(String) }])

    expect(await store.tasks.decidePair(first, dup, "rejected", "owner")).toMatchObject({ decision: "rejected" })
    expect(await pairs("unsure")).toEqual([])
    expect(await store.tasks.reviewDuplicates(dup)).toBe(0)
    await store.close()
  })

  it("**merge links the duplicate's messages and closes it as a duplicate; unmerge reopens it**, links stay", async () => {
    const { store, agent, rule } = await setup([said("1", "pay the bill"), said("2", "and this?", "1")])
    const kept = await agent("1", "Pay the bill")
    const { task } = await rule("2")
    const dup = (await store.tasks.details(task.id)).key

    const merged = await store.tasks.merge(dup, kept, { bot: "agent" })
    expect(merged).toMatchObject({ linked: 1, pair: { decision: "merged" } })
    expect(await store.tasks.details(dup)).toMatchObject({ status: "dismissed", reason: `duplicate of ${kept}` })
    expect((await store.tasks.taskRelations(dup)).map(({ kind }) => kind)).toEqual(["duplicate-of"])
    const evidence = await store.notes.links({ from: (await store.tasks.details(kept)).ref })
    expect(evidence.filter(({ kind }) => kind === "evidence")).toHaveLength(1)
    await expect(store.tasks.merge(dup, kept, "owner")).rejects.toThrow(/already dismissed/)

    expect(await store.tasks.unmerge(dup, "owner")).toMatchObject({ pair: { decision: "unmerged" } })
    expect(await store.tasks.details(dup)).toMatchObject({ status: "open", reason: null, closedAt: null })
    expect(await store.tasks.taskRelations(dup)).toEqual([])
    expect(await store.notes.links({ from: (await store.tasks.details(kept)).ref })).toHaveLength(evidence.length)
    expect((await store.tasks.events(dup)).map(({ kind }) => kind)).toEqual(
      expect.arrayContaining(["linked", "unlinked", "status"]),
    )
    await expect(store.tasks.unmerge(dup, "owner")).rejects.toThrow(/was not merged/)

    await store.tasks.linkTask(dup, kept, "duplicate-of", "owner")
    expect(await store.tasks.unmerge(dup, "owner")).toMatchObject({ pair: { decision: "unmerged" } })
    await store.close()
  })

  it("**a message merged or attached to a task opens no second task** when a rule sees it", async () => {
    const { store, agent, rule } = await setup([said("1", "pay the bill"), said("3", "who has the keys?")])
    const kept = await agent("1", "Pay the bill")
    await store.notes.addLink({ from: (await store.tasks.details(kept)).ref, to: "msg:chat/500/7/3", kind: "evidence" })

    expect(await rule("3")).toMatchObject({ created: false, task: { key: kept } })
    await store.close()
  })

  it("refuses a duplicate across accounts, of itself, and a merge into a task that was itself merged", async () => {
    const { store, agent } = await setup([said("1", "a"), said("2", "b"), said("3", "c")])
    const [a, b, c] = [await agent("1", "Pay the bill"), await agent("2", "Pay it"), await agent("3", "Pay")]
    await expect(store.tasks.merge(a, a, "owner")).rejects.toThrow(/not a duplicate of itself/)
    await store.tasks.merge(b, c, "owner")
    await expect(store.tasks.merge(a, b, "owner")).rejects.toThrow(new RegExp(`merged into ${c}`))
    await store.knowledge.addProject({ name: "Home", key: "HOM", type: "personal" })
    const owned = await store.tasks.create({ project: "HOM", title: "Fix the gate", type: "chore" }, "owner")
    await expect(store.tasks.merge(a, owned.key, "owner")).rejects.toThrow(/different accounts/)
    await store.close()
  })
})
