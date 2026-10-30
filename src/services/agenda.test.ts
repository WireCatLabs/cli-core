import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as v from "valibot"
import { expect, it } from "vitest"
import { listQuery } from "../cli/list-query.js"
import type { Chat, Message } from "../domain/models.js"
import { agenda as agendaEntity } from "../entities/agenda.js"
import { openStore } from "../store/store.js"
import { AGENDA_QUERY, agendaItem, agendaService } from "./agenda.js"
import { storeOnlyDeps } from "./deps.js"
import { TASK_QUERY, type TaskCard, tasksService } from "./tasks.js"

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
  text: `synthetic${chatId}x${id}`,
  senderName: outgoing ? "Owner" : "Synthetic author",
  editedAt: null,
  replyTo: null,
  forwardedFrom: null,
  reactions: null,
  outgoing,
  attachments: [],
})

const kinds = (text: string) => listQuery(text, AGENDA_QUERY, "tasks agenda")

const seeded = async () => {
  const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "agenda-")), "m.db") })
  await store.chats.saveChats(account, [
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
  for (const [id, list] of messages) await store.messages.saveMessages(account, id, list, { via: "test" })
  const deps = storeOnlyDeps(store, account, { app })
  return { store, tasks: tasksService(deps), agenda: agendaService(deps, () => now) }
}

it("says per listed chat how much of its history the store holds, so a quiet chat is not taken for a whole one", async () => {
  const { store, agenda } = await seeded()
  try {
    await store.sync.markRange(account, "1", 10, 11)
    const shown = await agenda.show({ query: kinds("") })
    expect(shown.since).toBe(daysAgo(30))
    const rows = Object.fromEntries(
      [...shown.owed, ...shown.waiting, ...shown.unsynced].map(({ chatId, coverage }) => [
        chatId,
        [coverage.completeness.state, coverage.held.messages],
      ]),
    )
    expect(rows).toEqual({ "1": ["partial", 2], "2": ["unknown", 2], "6": ["unknown", 0], "7": ["unknown", 2] })
    const [owed] = agendaItem(shown).owed
    expect(owed).toMatchObject({
      completeness: { state: "partial", reaches_start: false },
      held: { messages: 2, oldest_at: daysAgo(5), newest_at: daysAgo(3) },
    })
    v.parse(agendaEntity, agendaItem(shown))
  } finally {
    await store.close()
  }
})

it("lists the chats owed an answer and the ones waiting on others, from who wrote last and never the text", async () => {
  const { store, agenda } = await seeded()
  try {
    const shown = await agenda.show({ query: kinds("") })
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
      coverage: expect.objectContaining({ chatId: "1" }),
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
    expect((await agenda.show({ waiting: DAY / 2, query: kinds("") })).waiting.map((one) => one.chatId)).toEqual(["2"])
    expect((await agenda.show({ within: 90 * DAY, query: kinds("") })).owed.map((one) => one.chatId)).toEqual([
      "1",
      "5",
    ])
    expect((await agenda.show({ query: kinds("chat_kind:channel") })).owed.map((one) => one.chatId)).toEqual(["4"])
    expect((await agenda.show({ query: kinds("-chat_kind:dialog") })).owed.map((one) => one.chatId)).not.toContain("1")
    const item = v.parse(agendaEntity, agendaItem(await agenda.show({ query: kinds("") })))
    expect(item.owed[0]).toMatchObject({ chat: "chat:chat/500/1", kind: "dialog", last_message: "msg:chat/500/1/11" })
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

    const shown = await agenda.show({ query: kinds("") })
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

it("lists open tasks someone else does, oldest first, as what they owe the owner", async () => {
  const { store, tasks, agenda } = await seeded()
  try {
    const add = (message: string, plan = {}) => tasks.add(message, "promise", "agent", plan)
    const older = await add("msg:chat/500/1/11", { title: "Send the contract", assignees: ["sender"] })
    await add("msg:chat/500/2/20")
    const newer = await add("msg:chat/500/3/30", { title: "Pay the deposit", assignees: ["sender"] })
    const closed = await add("msg:chat/500/4/40", { assignees: ["sender"] })
    await tasks.close(closed.task.id, { as: "done", by: "owner" })

    const shown = await agenda.show({ query: kinds("") })
    expect(shown.assigned.map(({ id, title }) => [id, title])).toEqual([
      [older.task.id, "Send the contract"],
      [newer.task.id, "Pay the deposit"],
    ])
    expect(shown.assigned[0]?.assignees).toEqual([expect.stringMatching(/^person:\d+$/)])
    const item = v.parse(agendaEntity, agendaItem(shown))
    expect(item.assigned[0]).toMatchObject({
      key: older.card?.key,
      kind: "promise",
      assignees: shown.assigned[0]?.assignees,
    })
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

    const linked = (await tasks.link(
      task.id,
      { references: ["msg:chat/500/2/21", "msg:chat/500/9/99", "https://docs.example.com/d/1"], chats: ["3"] },
      { kind: "related-to", by: "owner" },
    )) as TaskCard
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

it("finds tagged tasks and agenda items by every inherited name after consolidation", async () => {
  const { store, tasks, agenda } = await seeded()
  try {
    const first = await tasks.add("msg:chat/500/1/10", "promise", "owner", { dueAt: new Date(now - DAY) })
    const second = await tasks.add("msg:chat/500/2/21", "promise", "owner", { dueAt: new Date(now - DAY) })
    await tasks.add("msg:chat/500/3/31", "promise", "owner", { dueAt: new Date(now - DAY) })
    const source = await store.knowledge.createTag("arrival"),
      survivor = await store.knowledge.createTag("welcome")
    await store.knowledge.addVocabularyAlias({ kind: "tag", id: String(source.id) }, "arriving")
    await store.knowledge.addTags(account, { type: "task", id: first.task.id }, [source.name])
    await store.knowledge.addTags(account, { type: "task", id: second.task.id }, [survivor.name])
    const catalog = await store.knowledge.vocabulary()
    const selection = {
      sourceId: String(source.id),
      survivorId: String(survivor.id),
      expectedVocabularyFingerprint: catalog.fingerprint,
    }
    const preview = await store.knowledge.previewTagConsolidation(selection)
    await store.knowledge.applyTagConsolidation({
      ...selection,
      expectedPreviewFingerprint: preview.previewFingerprint,
      by: "owner",
      idempotencyKey: "task-and-agenda-tags",
    })
    for (const name of ["arrival", "arriving", "welcome"]) {
      const query = listQuery(`tag:${name}`, TASK_QUERY, "tasks list")
      const listed = await tasks.list({ limit: 20, offset: 0, previews: true, ...(query ? { query } : {}) })
      expect(listed.previews?.map((row) => row.id).sort()).toEqual([first.task.id, second.task.id].sort())
      expect((await agenda.show({ query: kinds(`tag:${name}`) })).tasks.map((row) => row.id).sort()).toEqual(
        [first.task.id, second.task.id].sort(),
      )
    }
    const captured = await store.tasks.tagWhere("arrival")
    const next = await store.knowledge.createTag("harbour")
    const current = (await store.knowledge.vocabulary()).fingerprint
    const nextSelection = {
      sourceId: String(survivor.id),
      survivorId: String(next.id),
      expectedVocabularyFingerprint: current,
    }
    const nextPreview = await store.knowledge.previewTagConsolidation(nextSelection)
    await store.knowledge.applyTagConsolidation({
      ...nextSelection,
      expectedPreviewFingerprint: nextPreview.previewFingerprint,
      by: "owner",
      idempotencyKey: "task-predicate-after-merge",
    })
    expect(
      (await store.tasks.query("chat:500", captured, { limit: 20, offset: 0 })).map((row) => row.task.id).sort(),
    ).toEqual([first.task.id, second.task.id].sort())
  } finally {
    await store.close()
  }
})
