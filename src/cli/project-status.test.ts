import type { NextStep } from "@wirecat/cli-base/standards"
import * as v from "valibot"
import { afterEach, describe, expect, it } from "vitest"
import { projectStatus, STATUS_SIGNALS } from "../services/project-status/index.js"
import type { MessageStore } from "../store/store.js"
import { type FixtureChat, HARBOUR, harbourStore, NOW } from "../testing/project-status.js"
import { compactText, rowsOfEntity } from "./compact.js"
import { itemOf } from "./envelope.js"
import { projectStatusAnswer, projectStatusRow, projectStatusSchema, projectStatusText } from "./project-status.js"
import { ON_CHAT_ROW, STATUS_SIGNAL_ROWS } from "./project-status-rows.js"
import { nextStep } from "./steps.js"

const opened: MessageStore[] = []
afterEach(async () => {
  for (const store of opened.splice(0)) await store.close()
})

const hints = {
  sync: (chat: { chatId: string }, since: string) =>
    nextStep("messages.sync", { args: { chat: chat.chatId, since_time: since } }),
  read: (chat: { chatId: string }, since: string) =>
    nextStep("messages.list", { args: { chat: chat.chatId, query: `date>=${since}` } }),
  line: (step: NextStep) =>
    step.kind === "command" ? `chat ${step.command} ${Object.values(step.args).join(" ")}` : step.why,
}

const statusOf = async (chats: FixtureChat[] = HARBOUR) => {
  const { store } = await harbourStore(chats)
  opened.push(store)
  return projectStatus(store, { project: "HRB", asOf: NOW, contextQueries: ["1C"] })
}

const compactOf = (found: Awaited<ReturnType<typeof statusOf>>) => {
  const { item, ...parts } = projectStatusAnswer(found, hints)
  return compactText(itemOf(item, parts), projectStatusRow(STATUS_SIGNALS), { timezone: "UTC" }, rowsOfEntity())
}

/** Eight chats shaped like the harbour ones, each in its own chat id. */
const eight = (): FixtureChat[] =>
  [0, 1].flatMap((copy) =>
    HARBOUR.map((chat) => ({ ...chat, id: copy ? `${chat.id}${copy}` : chat.id, title: `${chat.title} ${copy}` })),
  )

describe("projectStatusAnswer", () => {
  it("passes its schema, syncs the chat held in part first, and reads the chat whose move is the owner's", async () => {
    const found = await statusOf()
    const { item, next, missing, meta } = projectStatusAnswer(found, hints)
    expect(() => v.parse(projectStatusSchema, item)).not.toThrow()
    expect(next.map((step) => (step.kind === "command" ? [step.command, step.args] : []))).toEqual([
      ["messages sync", { chat: "555", since_time: "2026-09-03" }],
      ["messages list", { chat: "-900", query: "date>=2026-10-19" }],
    ])
    expect(next[0]?.why).toContain("held in part")
    expect(missing.map((one) => one.field)).toEqual(["history"])
    expect(meta).toMatchObject({ complete: false, accounts: ["max/11", "telegram/22"] })
    expect(item.money).toContainEqual({ direction: "to_us", currency: "EUR", amount: "1200.00", rows: 1 })
    expect(item.chats.find((one) => one.chat === "chat:telegram/22/555")).toMatchObject({
      coverage: "partial",
      held: { messages: 3, oldest_at: "2026-10-20T09:00:00.000Z" },
      sync_command: "chat messages sync 555 2026-09-03",
      last: { ref: "msg:telegram/22/555/12", who: { name: "Lev", owner: false } },
      next: "owner",
      waiting_since: "2026-10-21T09:00:00.000Z",
    })
    expect(item.reply_next).toBeUndefined()
    expect(item.coverage).toBeUndefined()
  })

  it("counts on the chat's row what it does not list: a role-less group's questions, others' word promises", async () => {
    const leads = HARBOUR.map((chat) =>
      chat.id === "-950"
        ? {
            ...chat,
            messages: [
              { id: 1, at: "2026-11-01T09:00:00.000Z", from: "Visitor", text: "Сколько стоит сайт?" },
              { id: 2, at: "2026-11-01T10:00:00.000Z", from: "Guest", sender: "89", text: "А лендинг сколько?" },
            ],
          }
        : chat.id === "-900"
          ? {
              ...chat,
              messages: [
                ...chat.messages,
                { id: 7, at: "2026-10-27T09:00:00.000Z", from: "Kai", sender: "40", text: "Фото пришлю позже" },
              ],
            }
          : chat,
    )
    const { item } = projectStatusAnswer(await statusOf(leads), hints)
    const rows = new Map(item.chats.map((one) => [one.chat, one]))
    expect(rows.get("chat:max/11/-950")?.unlisted).toEqual({ questions: 2 })
    expect(rows.get("chat:max/11/-900")?.unlisted).toEqual({ promises: 1 })
    expect((item.questions as { chat: string }[]).map((one) => one.chat)).not.toContain("chat:max/11/-950")
    expect(item.promises).toEqual([expect.objectContaining({ ref: "msg:telegram/22/555/11", basis: "pattern" })])
  })

  it("leaves out a signal with nothing to say, and names a failed one in missing", async () => {
    const found = await statusOf()
    const { item, missing, meta } = projectStatusAnswer(
      { ...found, failed: [{ signal: "broken", why: "synthetic failure" }] },
      hints,
    )
    expect(item.payments).toBeUndefined()
    expect(missing).toContainEqual({ field: "signal:broken", why: "synthetic failure" })
    expect(meta.complete).toBe(false)
  })

  it("keeps four chats within 4 KB of JSON and 1.5 KB compact, and eight within 4 KB compact", async () => {
    const four = await statusOf()
    const { item, ...parts } = projectStatusAnswer(four, hints)
    expect(Buffer.byteLength(JSON.stringify(itemOf(item, parts)))).toBeLessThanOrEqual(4 * 1024)
    expect(Buffer.byteLength(compactOf(four))).toBeLessThanOrEqual(1.5 * 1024)
    const eightChats = await statusOf(eight())
    expect(eightChats.chats).toHaveLength(8)
    expect(Buffer.byteLength(compactOf(eightChats))).toBeLessThanOrEqual(4 * 1024)
  })
})

describe("a chat left out by its purpose", () => {
  it("is one missing row with its purpose, count, dates and the command that reads it", async () => {
    const { store } = await harbourStore(
      HARBOUR.map((chat) => (chat.id === "-950" ? { ...chat, purpose: "sales" } : chat)),
    )
    opened.push(store)
    const found = await projectStatus(store, { project: "HRB", asOf: NOW })
    const readChat = (chat: { chatId: string }, since: string) => hints.read(chat, since)
    const { item, missing } = projectStatusAnswer(found, { ...hints, readChat })
    expect(() => v.parse(projectStatusSchema, item)).not.toThrow()
    const why =
      "chat:max/11/-950, purpose sales, not read: 1 message 2026-11-01…2026-11-01; " +
      "read it: chat messages list -950 date>=2026-09-03"
    expect(missing).toContainEqual({ field: "chats", why, step: "messages.list" })
    expect(item.out_of_scope).toEqual([
      {
        chat: "chat:max/11/-950",
        reason: "purpose",
        purpose: "sales",
        messages: 1,
        first_at: "2026-11-01T09:00:00.000Z",
        last_at: "2026-11-01T09:00:00.000Z",
        read_command: "chat messages list -950 date>=2026-09-03",
      },
    ])
    expect(projectStatusText(found, { ...hints, readChat })).toContain(`Left out: ${why}`)
  })
})

describe("projectStatusText", () => {
  it("says who owes what, whose move it is, what went quiet, and what to run next", async () => {
    const text = projectStatusText(await statusOf(), hints)
    expect(text).toContain("HRB · Harbour site · 4 linked chats in 2 accounts, 2026-09-03 to 2026-11-02")
    expect(text).toMatch(/to us +1200\.00 EUR open since 2026-10-19 \(asked 2×, last 2026-10-26\) · Harbour group/)
    expect(text).toContain("Lev (contractor, dialog) · last 2026-10-28 Lev · next: YOU since 2026-10-21")
    expect(text).toContain('"1C" quiet on their side since 2026-10-12')
    expect(text).toContain("Harbour group (client, group) · last 2026-10-26 Ana · next: Kai (named) since 2026-10-26")
    expect(text).toContain("  1. chat messages sync 555 2026-09-03")
  })
})

describe("the compact form", () => {
  it("draws each signal with its own row and never prints a message beyond its excerpt", async () => {
    const compact = compactOf(await statusOf())
    expect(compact).toContain("# amounts: 2 · data.currency: EUR · data.state: open · basis: pattern")
    expect(compact).toContain("msg:max/11/-900/3 · to_us · 1200.00 · 10-19 · 2 asks")
    expect(compact).toContain("chat:telegram/22/555 · Lev · contractor · next owner · 10-21 · overdue · 3 held")
    expect(compact).not.toMatch(/^(window|signals|purposes):/m)
    expect(compact).not.toContain("Напоминаю")
    expect(compact).toContain("# next: your move, money open, held in part: messages sync")
  })

  it("has a row for every built in signal not drawn on the chat's row", () => {
    const listed = STATUS_SIGNALS.filter(({ id }) => !ON_CHAT_ROW.has(id))
    expect(listed.map(({ id }) => `status.${id}`).sort()).toEqual(Object.keys(STATUS_SIGNAL_ROWS).sort())
  })
})
