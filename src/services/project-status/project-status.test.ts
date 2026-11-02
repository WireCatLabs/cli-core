import { afterEach, describe, expect, it } from "vitest"
import type { ChatKind } from "../../domain/models.js"
import type { MessageStore } from "../../store/store.js"
import {
  CLIENT,
  CONTRACTOR,
  D,
  HARBOUR,
  harbourStore,
  NOW,
  openTestStore,
  type Said,
  said,
  seedChat,
} from "../../testing/project-status.js"
import { storeOnlyDeps } from "../deps.js"
import { tasksService } from "../tasks.js"
import { projectStatus, STATUS_SIGNALS, type StatusChat, type StatusContext, type StatusSignal } from "./index.js"
import { amounts } from "./signals/amounts.js"
import { replyNext } from "./signals/reply-next.js"

const app = { command: "chat", appName: "chat-cli", envPrefix: "CHAT", description: "", version: "1.0.0" }
const opened: MessageStore[] = []
afterEach(async () => {
  for (const store of opened.splice(0)) await store.close()
})

const seeded = async (chats = HARBOUR) => {
  const found = await harbourStore(chats)
  opened.push(found.store)
  return found
}

const chatOf = (kind: ChatKind, messages: Said[], role: string | null = null): StatusChat => ({
  ref: "chat:max/11/-1",
  account: CLIENT,
  chatId: "-1",
  title: "Synthetic",
  kind,
  role,
  purpose: "work",
  project: "project:1",
  coverage: {
    chatId: "-1",
    title: "Synthetic",
    completeness: { chatId: "-1", state: "complete", upToDate: true, gaps: false, reachesStart: true, fetchedAt: null },
    held: { messages: messages.length, oldestAt: null, newestAt: null },
  },
  messages: messages.map((one) => said("-1", one)),
})

const contextOf = (chats: StatusChat[] = []): StatusContext => ({
  now: NOW,
  since: NOW - 60 * 86_400_000,
  chats,
  project: { ref: "project:1", key: "HRB", name: "Harbour site", children: [], cut: [] },
  store: {} as MessageStore,
  contextQueries: [],
})

const hour = (n: number) => new Date(Date.UTC(2026, 9, 30, n)).toISOString()

describe("projectStatus on the harbour fixture", () => {
  it("answers who owes what, whose move it is and what went quiet, with refs", async () => {
    const { store } = await seeded()
    const found = await projectStatus(store, { project: "HRB", asOf: NOW, contextQueries: ["1C"] })

    expect(found.money.open).toContainEqual({ direction: "to_us", currency: "EUR", amount: "1200.00", rows: 1 })
    const owed = found.items.find((one) => one.signal === "amounts" && one.chat === "chat:max/11/-900")
    expect(owed).toMatchObject({
      basis: "pattern",
      data: { amount: "1200.00", direction: "to_us", state: "open", since: `${D}T09:00:00.000Z`, asks: 2 },
      evidence: [{ ref: "msg:max/11/-900/3" }, { ref: "msg:max/11/-900/5" }],
    })

    const lev = found.items.find((one) => one.signal === "reply-next" && one.chat === "chat:telegram/22/555")
    expect(lev?.data).toMatchObject({ next: "owner", waitingSince: "2026-10-21T09:00:00.000Z", overdue: true })

    const quiet = found.items.find((one) => one.signal === "topics" && one.chat === "chat:max/11/-900")
    expect(quiet?.data).toMatchObject({ query: "1C", silentSince: "2026-10-12T09:00:00.000Z" })

    const held = found.items.find((one) => one.signal === "coverage" && one.chat === "chat:telegram/22/555")
    expect(held?.data).toMatchObject({ state: "partial", beforeHeld: true })
    expect(found.attention[0]).toMatchObject({ chat: "chat:telegram/22/555" })
    expect(found.accounts.sort()).toEqual(["max/11", "telegram/22"])
    expect(found.signals.map(({ id }) => id)).toEqual(STATUS_SIGNALS.map(({ id }) => id))
    expect(found.failed).toEqual([])
  })

  it("names the group member a message addresses, and says the owner waits in a dialog", async () => {
    const { store } = await seeded()
    const found = await projectStatus(store, { project: "HRB", asOf: NOW })
    const next = (chat: string) => found.items.find((one) => one.signal === "reply-next" && one.chat === chat)?.data
    expect(next("chat:max/11/-900")).toMatchObject({ next: "named", addressed: { name: "Kai" } })
    expect(next("chat:max/11/501")).toMatchObject({ next: "them", waitingSince: "2026-10-18T09:00:00.000Z" })
    expect(next("chat:max/11/-950")).toMatchObject({ next: "nobody" })
  })

  it("reads only the accounts it is given and names the other chats out of scope", async () => {
    const { store } = await seeded()
    const found = await projectStatus(store, { project: "HRB", asOf: NOW, accounts: [CONTRACTOR] })
    expect(found.chats.map((chat) => chat.ref)).toEqual(["chat:telegram/22/555"])
    expect(found.outOfScope).toHaveLength(3)
    expect(found.outOfScope.every((one) => one.reason === "other-account")).toBe(true)
  })

  it("reads only the default purposes, and leaves every chat out when none of them is asked", async () => {
    const { store } = await seeded()
    expect((await projectStatus(store, { project: "HRB", asOf: NOW, purposes: ["all"] })).chats).toHaveLength(4)
    const sales = await projectStatus(store, { project: "HRB", asOf: NOW, purposes: ["sales"] })
    expect(sales.chats).toEqual([])
    expect(sales.outOfScope.map((one) => one.reason)).toEqual(["purpose", "purpose", "purpose", "purpose"])
  })

  it("keeps answering when a signal throws, and names it in failed", async () => {
    const { store } = await seeded()
    const broken: StatusSignal = {
      id: "broken",
      version: 3,
      scope: "chat",
      read: async () => {
        throw new Error("synthetic failure")
      },
    }
    const counted: StatusSignal<{ messages: number }> = {
      id: "counted",
      version: 1,
      scope: "chat",
      read: async (_context, chat) => [
        {
          signal: "counted",
          chat: chat?.ref ?? null,
          at: null,
          who: null,
          evidence: [],
          basis: "store",
          data: { messages: chat?.messages.length ?? 0 },
        },
      ],
      attention: (items) => items.map((one) => ({ chat: one.chat as string, weight: 9, why: "counted" })),
    }
    const found = await projectStatus(store, {
      project: "HRB",
      asOf: NOW,
      signals: [broken, counted as unknown as StatusSignal],
    })
    expect(found.failed).toEqual([{ signal: "broken", why: "synthetic failure" }])
    expect(found.items.map((one) => one.signal)).toEqual(["counted", "counted", "counted", "counted"])
    expect(found.signals).toEqual([
      { id: "broken", version: 3 },
      { id: "counted", version: 1 },
    ])
    expect(found.attention.every((one) => one.weight === 3)).toBe(true)
  })

  it("rolls up child projects two levels deep, skips a cycle, and counts a chat linked twice once", async () => {
    const { store, project } = await seeded([HARBOUR[0] as (typeof HARBOUR)[number]])
    const child = await store.knowledge.addProject({ name: "Harbour app", key: "HRA" })
    const grandchild = await store.knowledge.addProject({ name: "Harbour app API", key: "HRX" })
    const deep = await store.knowledge.addProject({ name: "Too deep", key: "HRZ" })
    const unconfirmed = await store.knowledge.addProject({ name: "Guess", key: "HRG" })
    const member = (from: string, to: string, confirmed = true) =>
      store.knowledge.relate(null, { from, to, kind: "member-of", confirmed })
    await member(child.ref, project)
    await member(grandchild.ref, child.ref)
    await member(deep.ref, grandchild.ref)
    await member(project, grandchild.ref)
    await member(unconfirmed.ref, project, false)
    await seedChat(store, HARBOUR[2] as (typeof HARBOUR)[number], child.ref)
    await member("chat:max/11/-900", child.ref)

    const found = await projectStatus(store, { project: "HRB", asOf: NOW })
    expect(found.children).toEqual([
      { ref: child.ref, key: "HRA", name: "Harbour app", chats: 1 },
      { ref: grandchild.ref, key: "HRX", name: "Harbour app API", chats: 0 },
    ])
    const cut = found.items.filter((one) => one.signal === "children" && one.data.cut !== null)
    expect(cut.map((one) => [one.data.child, one.data.cut])).toEqual([
      [deep.ref, "depth"],
      [project, "cycle"],
    ])
    expect(found.chats.map((chat) => [chat.ref, chat.project])).toEqual([
      ["chat:max/11/-900", project],
      ["chat:telegram/22/555", child.ref],
    ])
  })

  it("lists stored promise tasks and facts, and promises found by words marked as patterns", async () => {
    const { store, project } = await seeded()
    const tasks = tasksService(storeOnlyDeps(store, CONTRACTOR, { app }))
    await tasks.add("msg:telegram/22/555/11", "promise", "owner", { title: "Send the September report" })
    await store.facts.add({
      type: "promise",
      statement: "Ana promised the signed contract by Friday",
      by: "owner",
      project,
      evidence: ["msg:max/11/501/1"],
    })
    const found = await projectStatus(store, { project: "HRB", asOf: NOW })
    const promised = found.items
      .filter((one) => one.signal === "promises")
      .map((one) => [one.basis, one.chat, one.data])
    expect(promised).toContainEqual([
      "task",
      "chat:telegram/22/555",
      expect.objectContaining({ source: "task", kind: "promise", title: "Send the September report" }),
    ])
    expect(promised).toContainEqual(["fact", null, expect.objectContaining({ source: "fact", status: "accepted" })])
    expect(promised).toContainEqual([
      "pattern",
      "chat:telegram/22/555",
      expect.objectContaining({ side: "theirs", title: "Пришлю отчёт завтра", due: "2026-10-22" }),
    ])
  })

  it("finds no payments before any payment fact exists", async () => {
    const { store } = await seeded()
    const found = await projectStatus(store, { project: "HRB", asOf: NOW })
    expect(found.items.filter((one) => one.signal === "payments")).toEqual([])
  })

  it("carries no message text beyond an 80 character excerpt", async () => {
    const long = `Почему так долго? ${"очень ".repeat(40)}долго`
    const { store } = await seeded([
      {
        ...(HARBOUR[1] as (typeof HARBOUR)[number]),
        messages: [{ id: 1, at: "2026-10-30T09:00:00.000Z", from: "Ana", text: long }],
      },
    ])
    const found = await projectStatus(store, { project: "HRB", asOf: NOW })
    const text = JSON.stringify(found)
    expect(text).not.toContain(long.slice(0, 120))
    const question = found.items.find((one) => one.signal === "questions")
    expect(Array.from(String(question?.data.excerpt)).length).toBeLessThanOrEqual(80)
  })
})

describe("reply-next rules", () => {
  const next = async (kind: ChatKind, messages: Said[]) =>
    (await replyNext.read(contextOf(), chatOf(kind, messages)))[0]?.data

  it("1: the owner wrote last, so it is their move, and a group names whom the owner addressed", async () => {
    expect(
      await next("dialog", [
        { id: 1, at: hour(1), from: "Ana", text: "hi" },
        { id: 2, at: hour(2), from: "me", text: "ok" },
      ]),
    ).toMatchObject({ next: "them", waitingSince: hour(2) })
    const group = await next("group", [
      { id: 1, at: hour(1), from: "Kai", sender: "40", text: "hi" },
      { id: 2, at: hour(2), from: "me", text: "Kai, see this", extra: { mentions: ["40"] } },
    ])
    expect(group).toMatchObject({ next: "them", addressed: { name: "Kai" } })
  })

  it("2: someone else wrote last in a dialog, so it is the owner's move from their first message", async () => {
    expect(
      await next("dialog", [
        { id: 1, at: hour(1), from: "me", text: "hi" },
        { id: 2, at: hour(2), from: "Ana", text: "one" },
        { id: 3, at: hour(3), from: "Ana", text: "two" },
      ]),
    ).toMatchObject({ next: "owner", waitingSince: hour(2) })
  })

  it("3: in a group, a reply to the owner or a question right after the owner is the owner's move", async () => {
    const reply = await next("group", [
      { id: 1, at: hour(1), from: "me", text: "draft is up" },
      { id: 2, at: hour(2), from: "Kai", text: "lunch" },
      { id: 3, at: hour(3), from: "Ana", text: "looks fine", extra: { replyToId: "1" } },
    ])
    expect(reply).toMatchObject({ next: "owner" })
    const asked = await next("group", [
      { id: 1, at: hour(1), from: "me", text: "draft is up" },
      { id: 2, at: hour(2), from: "Ana", text: "which one?" },
    ])
    expect(asked).toMatchObject({ next: "owner", waitingSince: hour(2) })
  })

  it("4: in a group, a reply to another member names that member", async () => {
    const named = await next("group", [
      { id: 1, at: hour(1), from: "Kai", sender: "40", text: "done" },
      { id: 2, at: hour(2), from: "Ana", text: "thanks", extra: { replyToId: "1" } },
    ])
    expect(named).toMatchObject({ next: "named", addressed: { name: "Kai" } })
  })

  it("5: a group message that names nobody is nobody's move, and so is one whose sender is unknown", async () => {
    expect(
      await next("group", [
        { id: 1, at: hour(1), from: "me", text: "hi" },
        { id: 2, at: hour(2), from: "Kai", text: "news" },
        { id: 3, at: hour(3), from: "Ana", text: "Misha, will you answer" },
      ]),
    ).toMatchObject({ next: "nobody" })
    expect(
      await next("dialog", [{ id: 1, at: hour(1), from: "Ana", text: "hi", extra: { outgoing: null } }]),
    ).toMatchObject({ next: "nobody", waitingSince: null })
  })
})

describe("amount direction", () => {
  const read = async (role: string | null, messages: Said[]) =>
    (await amounts.read(contextOf(), chatOf("dialog", messages, role))).map((one) => [
      one.data.direction,
      one.data.state,
    ])

  it.each([
    ["the owner asks", "me", "Оплатите, пожалуйста, 50 000 ₽", null, ["to_us", "open"]],
    ["they ask", "Lev", "Please pay the invoice of $300", null, ["from_us", "open"]],
    ["the owner says paid", "me", "Оплатил 50 000 ₽ по счёту", null, ["from_us", "paid-mentioned"]],
    ["they say paid", "Ana", "Перевела 50 000 ₽ за сентябрь", null, ["to_us", "paid-mentioned"]],
    ["a client chat names a price", "Ana", "Цена 50 000 ₽", "client", ["to_us", "mentioned"]],
    ["a contractor chat names a price", "Lev", "Цена 50 000 ₽", "contractor", ["from_us", "mentioned"]],
    ["a chat with no role names a price", "Lev", "Цена 50 000 ₽", null, ["unknown", "mentioned"]],
  ] as const)("%s", async (_, from, text, role, expected) => {
    expect(await read(role, [{ id: 1, at: hour(1), from, text }])).toEqual([expected])
  })

  it("folds a reminder into the first ask and marks it paid when a later message says so", async () => {
    const found = await amounts.read(
      contextOf(),
      chatOf("dialog", [
        { id: 1, at: hour(1), from: "me", text: "Счёт на 1 200 € к оплате" },
        { id: 2, at: hour(2), from: "me", text: "Напоминаю про счёт 1 200 €" },
        { id: 3, at: hour(3), from: "Ana", text: "Оплатила 1 200 € сегодня" },
      ]),
    )
    expect(found).toHaveLength(1)
    expect(found[0]?.data).toMatchObject({ state: "paid-mentioned", since: hour(1), lastAsked: hour(2), asks: 2 })
    expect(found[0]?.evidence.map((one) => one.ref)).toEqual(["msg:max/11/-1/1", "msg:max/11/-1/2", "msg:max/11/-1/3"])
  })

  it("reads no amount from a number without a currency or a money word", async () => {
    expect(
      await read(null, [{ id: 1, at: hour(1), from: "Ana", text: "Позвони на 8 921 000 00 00, это 1 200 € ровно" }]),
    ).toEqual([])
    expect(await read(null, [{ id: 1, at: hour(1), from: "Ana", text: "Встреча 12.10 в 15:00" }])).toEqual([])
  })
})

describe("an empty store", () => {
  it("refuses a project it does not know", async () => {
    const store = await openTestStore()
    opened.push(store)
    await expect(projectStatus(store, { project: "NOPE", asOf: NOW })).rejects.toMatchObject({ code: "not_found" })
  })
})
