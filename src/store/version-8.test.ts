import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import { sampleMeeting } from "../meetings/testing/index.js"
import type { Task } from "../tasks/index.js"
import { rollBackTo } from "../testing/older-store.js"
import { openCache } from "./open.js"
import { FOLDED } from "./sqlite/folded.js"
import { type AccountKey, type MessageStore, openStore } from "./store.js"

const account: AccountKey = { provider: "telegram", account: "100" }
const opened: { close(): unknown }[] = []
afterEach(async () => {
  for (const one of opened.splice(0)) await one.close()
})

const unfolded = async (path: string) => {
  const database = await openCache(path)
  try {
    return FOLDED.flatMap(({ table, column }) => {
      const row = database
        .prepare(`SELECT count(*) AS n FROM ${table} WHERE ${column} IS NOT NULL AND ${column}_folded IS NULL`)
        .get()
      return Number(row?.n) > 0 ? [`${table}.${column}`] : []
    })
  } finally {
    database.close()
  }
}

const folded = async (path: string, table: string, column: string) => {
  const database = await openCache(path)
  try {
    return database
      .prepare(`SELECT ${column}_folded AS value FROM ${table} WHERE ${column} IS NOT NULL ORDER BY id`)
      .all()
      .map((row) => row.value)
  } finally {
    database.close()
  }
}

/** Writes every folded name through the store's own paths. */
const written = async (store: MessageStore) => {
  await store.saveChats(account, [
    { id: "1", title: "Chat", kind: "group", unreadCount: 0, lastMessageAt: null, participantsCount: null },
  ])
  await store.saveMessages(
    account,
    "1",
    [
      {
        id: "1",
        chatId: "1",
        senderId: "200",
        senderName: "alice",
        timestamp: new Date(Date.UTC(2026, 0, 1)).toISOString(),
        editedAt: null,
        text: "",
        outgoing: false,
        attachments: [{ kind: "file", name: "Мой ОТЧЁТ.pdf" }],
        replyTo: null,
        forwardedFrom: null,
        reactions: null,
      },
    ],
    { via: "history" },
  )
  await store.keepDownloads(account, "1", "1", [{ kind: "file", name: "Мой ОТЧЁТ.pdf", path: "/Saved/ОТЧЁТ.pdf" }])
  const project = await store.knowledge.addProject({ name: "Research Example", key: "RES", scope: "work" })
  const work = await store.tasks.create({ project: project.ref, title: "Кофе Café", type: "chore" }, "owner")
  await store.tasks.edit(work.ref, { title: "Новый КОФЕ", status: "done", reason: "Сделано" }, "owner")
  const task: Task = {
    id: "t-1",
    source: "msg:telegram/100/1/1",
    sourceKind: "message",
    account: "telegram:100",
    group: "1",
    kind: "question",
    state: "open",
    origin: "owner",
    createdAt: new Date(Date.UTC(2026, 0, 2)),
  }
  await store.tasks.insert(task)
  await store.tasks.update({ ...task, state: "dismissed", reason: "НЕ НУЖНО", closedAt: new Date(), closedBy: "owner" })
  const accountId = await store.saveAccount({ provider: "example", account: "AliceExample" }, { name: "Alice" })
  const meeting = sampleMeeting()
  meeting.meeting.accountId = accountId
  meeting.meeting.title = "Планёрка ÉQUIPE"
  await store.meetings.saveMeeting(meeting)
}

it("**every writer keeps the folded copy** of the names list filters compare", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "folded-")), "wirecat.db")
  const store = await openStore({ path })
  opened.push(store)
  await written(store)
  expect(await unfolded(path)).toEqual([])
  expect(await folded(path, "attachments", "name")).toEqual(["мои отчет.pdf", "example.txt"])
  expect(await folded(path, "attachments", "local_path")).toEqual(["/saved/отчет.pdf"])
  expect(await folded(path, "tasks", "close_reason")).toEqual(["сделано", "не нужно"])
  expect((await folded(path, "tasks", "title"))[0]).toBe("новыи кофе")
  expect(await folded(path, "meetings", "title")).toEqual(["планерка equipe"])
})

it("fills the folded copies of a file stored before version 8", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "version-8-")), "wirecat.db")
  const store = await openStore({ path })
  await written(store)
  await store.close()

  const old = await openCache(path)
  rollBackTo(old, 8)
  old.close()

  const upgraded = await openStore({ path })
  opened.push(upgraded)
  expect(await unfolded(path)).toEqual([])
  expect(await folded(path, "attachments", "name")).toEqual(["мои отчет.pdf", "example.txt"])
})
