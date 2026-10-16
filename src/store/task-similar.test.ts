import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import type { Message } from "../domain/models.js"
import { createTaskService, type NewTask } from "../tasks/index.js"
import { openStore } from "./store.js"

const account = { provider: "chat", account: "500" }
const taskAccount = "chat:500"

const said = (id: string, sender: string, text: string, replyToId?: string): Message => ({
  id,
  chatId: "7",
  senderId: sender,
  senderName: sender === "9" ? "Alice Example" : sender === "8" ? "Bob Sample" : "Carol Test",
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
  const clock = { at: Date.now() }
  const store = await openStore({
    path: join(mkdtempSync(join(tmpdir(), "task-similar-")), "wirecat.db"),
    now: () => clock.at,
  })
  await store.messages.saveMessages(account, "7", messages, { via: "test" })
  const service = createTaskService({ store: store.tasks })
  const add = async (message: string, plan: { title?: string; description?: string; category?: string } = {}) => {
    const input: NewTask = {
      source: `msg:chat/500/7/${message}`,
      sourceKind: "message",
      account: taskAccount,
      group: "7",
      kind: "request",
      origin: "agent",
      ...(plan.category === undefined ? {} : { category: plan.category }),
    }
    const { task } = await service.add(input)
    const { category: _category, ...text } = plan
    if (Object.keys(text).length > 0) await store.tasks.edit(task.id, text, "owner")
    return (await store.tasks.details(task.id)).key
  }
  const similar = async (key: string) =>
    Object.fromEntries((await store.tasks.similar({ task: key })).map((one) => [one.key, one]))
  return { store, add, similar, clock }
}

describe("similar tasks", () => {
  it("**finds a task by shared stems, joined digit groups and no stop words**, and scores it", async () => {
    const { store, add, similar } = await setup([said("1", "9", "pay"), said("2", "8", "pay"), said("3", "7", "x")])
    const first = await add("1", { title: "Pay the plumber 15 000 rub for the boiler" })
    const second = await add("2", { title: "Paid plumber 15000 rub, boiler repair" })
    await add("3", { title: "Book a table for the team dinner" })

    const found = await similar(first)
    expect(Object.keys(found)).toEqual([second])
    expect(found[second]).toMatchObject({ foundBy: ["text"], levels: { amount: "equal", person: "different" } })
    expect(found[second]?.reasons).toContain("same amount")
    await store.close()
  })

  it("**never takes a task as a candidate for sharing the chat alone**, but does for the same person", async () => {
    const { store, add, similar } = await setup([
      said("1", "9", "a"),
      said("2", "8", "b"),
      said("3", "9", "c"),
      said("4", "8", "d"),
    ])
    const subject = await add("1", { title: "Renew the parking permit", category: "documents" })
    await add("2", { title: "Send the slides to the board", category: "meeting" })
    const samePerson = await add("3", { title: "Water the garden plants", category: "personal" })
    const sameCategory = await add("4", { title: "Sign the lease extension", category: "documents" })

    const found = await similar(subject)
    expect(Object.keys(found).sort()).toEqual([samePerson, sameCategory].sort())
    expect(found[samePerson]?.foundBy).toEqual(["person"])
    expect(found[sameCategory]?.foundBy).toEqual(["category"])
    await store.close()
  })

  it("**takes the tasks of one reply chain** and weighs the chain, whoever wrote them", async () => {
    const { store, add, similar } = await setup([
      said("1", "9", "can you check the router"),
      said("2", "8", "and the printer too", "1"),
      said("3", "7", "reply to the reply", "2"),
    ])
    const root = await add("1", { title: "Check the router" })
    const reply = await add("2", { title: "Fix the printer" })
    const deeper = await add("3", { title: "Order toner" })

    const found = await similar(reply)
    expect(Object.keys(found).sort()).toEqual([root, deeper].sort())
    expect(found[root]).toMatchObject({ foundBy: ["reply"], levels: { reply: "yes" } })
    expect(found[root]?.reasons).toContain("in one reply chain")
    await store.close()
  })

  it("**leaves out a rule's placeholder title, deleted tasks and tasks closed over 14 days ago**", async () => {
    const { store, add, similar, clock } = await setup([said("1", "9", "a"), said("2", "8", "b"), said("3", "7", "c")])
    const subject = await add("1", { title: "Return the projector" })
    const placeholder = await add("2")
    const closed = await add("3", { title: "Return the projector to the office" })
    expect(await similar(subject)).toHaveProperty(closed)
    expect(await similar(subject)).not.toHaveProperty(placeholder)

    await store.tasks.edit(closed, { status: "done" }, "owner")
    expect(await similar(subject)).toHaveProperty(closed)
    clock.at += 15 * 86_400_000
    expect(await similar(subject)).toEqual({})
    expect(await similar(placeholder)).toEqual({})
    await store.close()
  })

  it("**reads the messages linked to a task**: a reminder like a linked message scores higher, never lower", async () => {
    const { store, add } = await setup([
      said("1", "9", "Can you call the plumber?"),
      said("2", "9", "The boiler repair is 15 000 rub, pay by Friday"),
      said("3", "9", "x"),
      said("4", "8", "unrelated chatter"),
    ])
    const plumber = await add("1", { title: "Call the plumber", category: "money" })
    const reminder = await add("3", { title: "Pay 15000 rub for the boiler repair by Friday", category: "money" })
    const before = await store.tasks.compare({ task: reminder }, plumber)
    expect(before).toMatchObject({ band: "different", levels: { text: "low", amount: "missing" } })

    const ref = (await store.tasks.details(plumber)).ref
    await store.notes.addLink({ from: ref, to: "msg:chat/500/7/4", kind: "related-to" })
    expect((await store.tasks.compare({ task: reminder }, plumber)).score).toBe(before.score)
    await store.notes.addLink({ from: ref, to: "msg:chat/500/7/2", kind: "evidence" })
    const after = await store.tasks.compare({ task: reminder }, plumber)
    expect(after).toMatchObject({ band: "likely", levels: { amount: "equal", person: "same" } })
    expect((await store.tasks.similar({ task: reminder })).map(({ key }) => key)).toEqual([plumber])
    await store.close()
  })

  it("**reads a rule task's source message**, whose placeholder title says nothing", async () => {
    const { store, add } = await setup([said("1", "9", "Could you pay the 15 000 rub invoice?"), said("2", "9", "x")])
    const rule = await add("1")
    const agent = await add("2", { title: "Pay the 15000 rub invoice" })
    expect((await store.tasks.similar({ task: agent }))[0]).toMatchObject({
      key: rule,
      foundBy: ["person"],
      levels: { text: "high", amount: "equal" },
    })
    await store.close()
  })

  it("**takes a task whose linked message the new one replies to**", async () => {
    const { store, add, similar } = await setup([
      said("1", "9", "Book the venue"),
      said("2", "8", "the caterer said yes"),
      said("3", "7", "great, and the band?", "2"),
    ])
    const venue = await add("1", { title: "Book the venue" })
    await store.notes.addLink({
      from: (await store.tasks.details(venue)).ref,
      to: "msg:chat/500/7/2",
      kind: "evidence",
    })
    const band = await add("3", { title: "Hire a band" })
    expect((await similar(band))[venue]).toMatchObject({ foundBy: ["reply"], levels: { reply: "yes" } })
    await store.close()
  })

  it("**scores a draft** not added yet against the account's tasks", async () => {
    const { store, add } = await setup([said("1", "9", "a"), said("2", "9", "b")])
    const existing = await add("1", { title: "Send Alice the signed contract by Friday" })
    const found = await store.tasks.similar({
      account: taskAccount,
      draft: { title: "Send the signed contract to Alice", source: "msg:chat/500/7/2" },
    })
    expect(found.map((one) => one.key)).toEqual([existing])
    expect(found[0]).toMatchObject({ foundBy: ["text", "person"], levels: { person: "same" } })
    expect(await store.tasks.similar({ account: "chat:404", draft: { title: "Send the contract" } })).toEqual([])
    await store.close()
  })
})
