import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import type { Chat, Message } from "../domain/models.js"
import { openStore } from "../store/store.js"
import { agendaService } from "./agenda.js"
import { storeOnlyDeps } from "./deps.js"
import { tasksService } from "./tasks.js"

const app = { command: "chat", appName: "chat-cli", envPrefix: "CHAT", description: "", version: "1.0.0" }
const account = { provider: "chat", account: "500" }
const DAY = 86_400_000
const now = Date.now()
const daysAgo = (days: number) => new Date(now - days * DAY).toISOString()

const chat = (id: string, kind: Chat["kind"]): Chat => ({
  id,
  title: `Synthetic ${id}`,
  participantsCount: 2,
  kind,
  unreadCount: 0,
  lastMessageAt: null,
})

const said = (chatId: string, id: string, days: number, outgoing: boolean): Message => ({
  id,
  chatId,
  senderId: outgoing ? "500" : "11",
  timestamp: daysAgo(days),
  text: "synthetic",
  senderName: outgoing ? "Owner" : "Synthetic author",
  editedAt: null,
  replyTo: null,
  forwardedFrom: null,
  reactions: null,
  outgoing,
  attachments: [],
})

const seeded = async () => {
  const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "agenda-")), "m.db") })
  await store.saveChats(account, [
    chat("1", "dialog"),
    chat("2", "dialog"),
    chat("3", "dialog"),
    chat("4", "channel"),
    chat("5", "dialog"),
    { ...chat("6", "dialog"), lastMessageAt: daysAgo(2) },
    { ...chat("7", "dialog"), title: null, lastMessageAt: daysAgo(4) },
  ])
  const messages: [string, Message[]][] = [
    ["1", [said("1", "10", 5, true), said("1", "11", 3, false)]],
    ["2", [said("2", "20", 9, false), said("2", "21", 8, true)]],
    ["3", [said("3", "30", 2, false), said("3", "31", 0.1, true)]],
    ["4", [said("4", "40", 3, false)]],
    ["5", [said("5", "50", 60, false)]],
    ["7", [said("7", "70", 6, false), said("7", "71", 5, true)]],
  ]
  for (const [id, list] of messages) await store.saveMessages(account, id, list, { via: "test" })
  const deps = storeOnlyDeps(store, account, { app })
  return { store, tasks: tasksService(deps), agenda: agendaService(deps, () => now) }
}

it("lists the chats owed an answer and the ones waiting on others, from who wrote last and never the text", async () => {
  const { store, agenda } = await seeded()
  try {
    const shown = await agenda.show()
    expect(shown).toMatchObject({ account: "chat:500", stale: false, tasks: [] })
    expect(shown.owed.map((one) => one.chatId)).toEqual(["1"])
    expect(shown.owed[0]).toEqual({
      chatId: "1",
      title: "Synthetic 1",
      kind: "dialog",
      lastMessage: "msg:chat/500/1/11",
      lastMessageAt: daysAgo(3),
      lastFromOwner: false,
      openTasks: [],
    })
    expect(shown.waiting.map((one) => one.chatId)).toEqual(["2"])
    expect(
      shown.unsynced.map(({ chatId, title, lastMessage, lastFromOwner }) => [
        chatId,
        title,
        lastMessage,
        lastFromOwner,
      ]),
    ).toEqual([
      ["6", "Synthetic 6", null, null],
      ["7", "Synthetic author", null, null],
    ])
    expect(JSON.stringify(shown)).not.toContain("synthetic")
    expect((await agenda.show({ waiting: DAY / 2 })).waiting.map((one) => one.chatId)).toEqual(["2"])
    expect((await agenda.show({ within: 90 * DAY })).owed.map((one) => one.chatId)).toEqual(["1", "5"])
    expect((await agenda.show({ kinds: ["channel"] })).owed.map((one) => one.chatId)).toEqual(["4"])
  } finally {
    await store.close()
  }
})

it("lists a task when it is due, overdue, due a check or never planned, and not while it waits for its check", async () => {
  const { store, tasks, agenda } = await seeded()
  try {
    const add = (message: string, plan = {}) => tasks.add(message, "promise", "owner", plan)
    const overdue = await add("msg:chat/500/1/10", { title: "Send the doc", dueAt: new Date(now - DAY) })
    const soon = await add("msg:chat/500/2/21", { dueAt: new Date(now + DAY / 2) })
    const check = await add("msg:chat/500/3/31", { nextCheckAt: new Date(now - 1000) })
    const unplanned = await add("msg:chat/500/1/11")
    await add("msg:chat/500/2/20", { dueAt: new Date(now + 5 * DAY), nextCheckAt: new Date(now + DAY) })
    const closed = await add("msg:chat/500/3/30", { dueAt: new Date(now - DAY) })
    await tasks.close(closed.task.id, { as: "done", by: "owner" })

    const shown = await agenda.show()
    expect(shown.tasks.map(({ id, reasons }) => [id, reasons])).toEqual([
      [overdue.task.id, ["overdue"]],
      [check.task.id, ["check"]],
      [unplanned.task.id, ["unplanned"]],
      [soon.task.id, ["due"]],
    ])
    expect(shown.tasks[0]?.title).toBe("Send the doc")
    expect(shown.owed[0]?.openTasks.sort()).toEqual([overdue.task.id, unplanned.task.id].sort())
  } finally {
    await store.close()
  }
})

it("plans and links a task, refusing a date on a closed one and a mistyped reference", async () => {
  const { store, tasks } = await seeded()
  try {
    const { task, card } = await tasks.add("msg:chat/500/1/11", "request", "owner", {
      title: "Send Alex the API token",
      description: "Owes: me → Alex\nDone when: Alex confirms the test import",
      nextCheckAt: new Date(now + DAY),
    })
    expect(card).toMatchObject({ title: "Send Alex the API token", dueAt: null, nextCheckAt: expect.any(String) })

    const planned = await tasks.plan(task.id, { dueAt: new Date(now + 2 * DAY), nextCheckAt: null }, "agent")
    expect(planned).toMatchObject({ dueAt: new Date(now + 2 * DAY).toISOString(), nextCheckAt: null })

    const linked = await tasks.link(
      task.id,
      { references: ["msg:chat/500/2/21", "msg:chat/500/9/99", "https://docs.example.com/d/1"], chats: ["3"] },
      { kind: "related-to", by: "owner" },
    )
    expect(linked.links.map(({ to, targetText, kind }) => [to, targetText, kind])).toEqual([
      ["msg:chat/500/2/21", null, "related-to"],
      [null, "msg:chat/500/9/99", "related-to"],
      [null, "https://docs.example.com/d/1", "related-to"],
      ["chat:chat/500/3", null, "related-to"],
    ])
    expect((await tasks.show(card?.key as string)).links).toHaveLength(4)
    await expect(
      tasks.link(task.id, { references: ["person:999"] }, { kind: "related-to", by: "owner" }),
    ).rejects.toMatchObject({ code: "not_found" })

    await tasks.close(task.id, { as: "done", by: "owner" })
    await expect(tasks.plan(task.id, { dueAt: new Date(now + DAY) }, "owner")).rejects.toMatchObject({
      code: "validation_error",
    })
    expect(await tasks.plan(task.id, { title: "Sent Alex the token" }, "owner")).toMatchObject({
      title: "Sent Alex the token",
    })
  } finally {
    await store.close()
  }
})
