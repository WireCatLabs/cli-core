import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import type { Message } from "../domain/models.js"
import { createTaskService } from "../tasks/index.js"
import { rollBackTo } from "../testing/older-store.js"
import { openCache } from "./open.js"
import { fillFoundTaskTitles } from "./sqlite/task-titles.js"
import { type AccountKey, openStore } from "./store.js"

const ACCOUNT: AccountKey = { provider: "telegram", account: "1" }
const CHAT = "-1001234567890"

const message = (id: string, text: string): Message => ({
  id,
  chatId: CHAT,
  senderId: "21",
  senderName: "Ann Example",
  timestamp: `2026-10-0${id}T10:00:00.000Z`,
  editedAt: null,
  text,
  outgoing: false,
  attachments: [],
  replyTo: null,
  forwardedFrom: null,
  reactions: null,
})

const storedTitles = async (path: string) => {
  const database = await openCache(path)
  try {
    return {
      titles: Object.fromEntries(
        database
          .prepare("SELECT key, title, title_folded FROM tasks ORDER BY id")
          .all()
          .map((row) => [String(row.key), [String(row.title), String(row.title_folded)]]),
      ),
      flag: Number(
        database.prepare("SELECT count(*) AS n FROM store_settings WHERE key = 'found_task_titles_to_fill'").get()?.n,
      ),
    }
  } finally {
    database.close()
  }
}

const toStandIns = (database: Awaited<ReturnType<typeof openCache>>) =>
  database.exec(
    "UPDATE tasks SET title = type || ' — ' || source_locator, title_folded = NULL WHERE package_id IS NOT NULL " +
      "AND title NOT LIKE 'Call Ann%'",
  )

const foundIn = (id: string) => `msg:telegram/1/${CHAT}/${id}`

it("stores a found task's first line as its title once, and leaves every other title as it was", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "version-65-")), "wirecat.db")
  const store = await openStore({ path })
  await store.messages.saveMessages(
    ACCOUNT,
    CHAT,
    [
      message("1", "\n Can you send the invoice?\nThanks"),
      message("2", "Gone soon"),
      message("3", ""),
      message("4", "Mine"),
    ],
    { via: "history" },
  )
  const service = createTaskService({ store: store.tasks })
  const keys: string[] = []
  for (const id of ["1", "2", "3", "4", "9"]) {
    const { task } = await service.add({
      source: foundIn(id),
      sourceKind: "message",
      account: "telegram:1",
      group: CHAT,
      kind: "question",
      origin: "rule",
    })
    keys.push((await store.tasks.details(task.id)).key)
  }
  const [text, deleted, empty, owned, missing] = keys as [string, string, string, string, string]
  await store.tasks.edit((await store.tasks.details(owned)).id, { title: "Call Ann back" }, "owner")
  await store.knowledge.addProject({ name: "Harbour", key: "HRB" })
  const project = await store.tasks.create(
    { project: "HRB", title: "feature — msg:telegram/1/70/1", type: "feature" },
    "owner",
  )
  await store.close()

  const old = await openCache(path)
  toStandIns(old)
  rollBackTo(old, 65)
  old.close()
  const upgraded = await openStore({ path })
  await upgraded.messages.markDeleted(ACCOUNT, ["2"], { chatId: CHAT })
  await upgraded.close()

  expect(await storedTitles(path)).toEqual({
    titles: {
      [text]: ["Can you send the invoice?", "can you send the invoice?"],
      [deleted]: ["Gone soon", "gone soon"],
      [empty]: [`question — ${foundIn("3")}`, `question — ${foundIn("3")}`],
      [owned]: ["Call Ann back", "call ann back"],
      [missing]: [`question — ${foundIn("9")}`, `question — ${foundIn("9")}`],
      [project.key]: ["feature — msg:telegram/1/70/1", "feature — msg:telegram/1/70/1"],
    },
    flag: 0,
  })

  const reopened = await openStore({ path })
  try {
    expect((await reopened.tasks.details(deleted)).title).toBe("Gone soon")
  } finally {
    await reopened.close()
  }
})

it("fills in batches and keeps the key until the last one", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "version-65-")), "wirecat.db")
  const store = await openStore({ path })
  await store.messages.saveMessages(ACCOUNT, CHAT, [message("1", "One"), message("2", "Two"), message("3", "Three")], {
    via: "history",
  })
  const service = createTaskService({ store: store.tasks })
  for (const id of ["1", "2", "3"])
    await service.add({
      source: foundIn(id),
      sourceKind: "message",
      account: "telegram:1",
      group: CHAT,
      kind: "request",
      origin: "rule",
    })
  await store.close()

  const database = await openCache(path)
  try {
    toStandIns(database)
    database.exec("INSERT INTO store_settings (key, value, at) VALUES ('found_task_titles_to_fill', '1', 0)")
    const warnings: string[] = []
    expect(fillFoundTaskTitles(database, (line) => warnings.push(line), { batch: 2 })).toBe(3)
    expect(warnings).toEqual([])
    expect(
      database
        .prepare("SELECT title FROM tasks ORDER BY id")
        .all()
        .map((row) => row.title),
    ).toEqual(["One", "Two", "Three"])
    expect(
      database.prepare("SELECT 1 FROM store_settings WHERE key = 'found_task_titles_to_fill'").get(),
    ).toBeUndefined()
  } finally {
    database.close()
  }
})
