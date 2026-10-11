import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import type { Messenger } from "../cli/messenger/context.js"
import type { MessengerAdapter } from "../cli/messenger/port.js"
import type { Chat, Message, Review } from "../domain/models.js"
import type { SendGuard } from "../sends/guard.js"
import { openStore } from "../store/store.js"
import { memoryTaskStore } from "../tasks/testing/index.js"
import { onlineDeps } from "./deps.js"
import { inboxService } from "./inbox.js"
import { applyTaskRules, applyTaskRulesOnArrival, openRequestTask } from "./task-rules.js"

const account = { provider: "telegram", account: "500" } as const
const at = (minute: number) => new Date(Date.UTC(2026, 9, 6, 10, minute)).toISOString()

const said = (id: string, minute: number, text = "hola", extra: Partial<Message> = {}): Message => ({
  id,
  chatId: "-1001",
  senderId: extra.outgoing ? "500" : "9",
  senderName: null,
  timestamp: at(minute),
  editedAt: null,
  text,
  outgoing: false,
  attachments: [],
  replyTo: null,
  forwardedFrom: null,
  reactions: null,
  ...extra,
})

const reviewOf = (messages: Message[]): Review => ({
  since: at(0),
  until: at(59),
  complete: true,
  chats: [{ id: "-1001", title: "Group", kind: "group", messages, more: false }],
  skipped: [],
  partial: false,
  quiet: 0,
})

const states = async (store: ReturnType<typeof memoryTaskStore>) =>
  (await store.list({})).map((task) => `${task.source} ${task.kind} ${task.state}`)

describe("applyTaskRules", () => {
  it("opens one task per unanswered question, however often the same window is reviewed", async () => {
    const store = memoryTaskStore()
    const review = reviewOf([said("1", 1, "who has the keys?"), said("2", 2, "thanks")])

    expect(await applyTaskRules(review, { store, account })).toEqual({ added: 1, closed: 0 })
    expect(await applyTaskRules(review, { store, account })).toEqual({ added: 0, closed: 0 })
    expect(await states(store)).toEqual(["msg:telegram/500/-1001/1 question open"])
  })

  it("closes the question once the owner answers it, and leaves another's answer open", async () => {
    const store = memoryTaskStore()
    await applyTaskRules(reviewOf([said("1", 1, "who has the keys?"), said("3", 3, "is it Monday?")]), {
      store,
      account,
    })

    const later = reviewOf([
      said("1", 1, "who has the keys?"),
      said("2", 2, "I do", { outgoing: true, replyToId: "1" }),
      said("3", 3, "is it Monday?"),
      said("4", 4, "yes", { senderId: "77", replyToId: "3" }),
    ])
    expect(await applyTaskRules(later, { store, account })).toEqual({ added: 0, closed: 1 })
    expect(await states(store)).toEqual([
      "msg:telegram/500/-1001/1 question done",
      "msg:telegram/500/-1001/3 question open",
    ])
  })

  it("never reopens a question the owner dismissed", async () => {
    const store = memoryTaskStore()
    const review = reviewOf([said("1", 1, "anyone?")])
    await applyTaskRules(review, { store, account })
    const [task] = await store.list({})
    if (task) await store.update({ ...task, state: "dismissed", reason: "no-reply-needed", closedBy: "owner" })

    expect(await applyTaskRules(review, { store, account })).toEqual({ added: 0, closed: 0 })
    expect(await states(store)).toEqual(["msg:telegram/500/-1001/1 question dismissed"])
  })

  it("opens a task for a mention of the owner, and closes it when the owner replies to that person", async () => {
    const store = memoryTaskStore()
    const mention = said("1", 1, "Slava will bring it", { mentions: ["500"] })
    await applyTaskRules(reviewOf([mention, said("2", 2, "about someone else", { mentions: ["7"] })]), {
      store,
      account,
    })
    expect(await states(store)).toEqual(["msg:telegram/500/-1001/1 mention open"])

    const answered = reviewOf([
      said("0", 0, "earlier, from the same person"),
      mention,
      said("6", 6, "sure", { outgoing: true, replyToId: "0" }),
    ])
    expect(await applyTaskRules(answered, { store, account })).toEqual({ added: 0, closed: 1 })
    expect(await states(store)).toEqual(["msg:telegram/500/-1001/1 mention done"])
  })

  it("keeps two accounts apart", async () => {
    const store = memoryTaskStore()
    const review = reviewOf([said("1", 1, "anyone?")])
    await applyTaskRules(review, { store, account })
    await applyTaskRules(review, { store, account: { provider: "max", account: "500" } })

    expect((await store.list({})).map((task) => task.account)).toEqual(["telegram:500", "max:500"])
  })
})

describe("review", () => {
  it("opens the task in the store once, however often it runs, and says so", async () => {
    const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "task-rules-")), "messages.db") })
    const chat: Chat = {
      id: "-1001",
      title: "Group",
      kind: "group",
      unreadCount: 0,
      lastMessageAt: at(5),
      participantsCount: null,
    }
    const history = [said("1", 1, "who has the keys?"), said("2", 2, "thanks")]
    const adapter = {
      chats: async () => ({ items: [chat], hasMore: false }),
      history: async () => ({ items: history, hasMore: false }),
      resolve: async () => chat,
    } as unknown as MessengerAdapter
    const deps = {
      ...onlineDeps({ provider: "telegram", chatArgument: "a chat" } as Messenger, adapter, {} as SendGuard),
      store: async () => store,
      account: async () => account,
    }

    const first = await inboxService(deps).review({ since: Date.parse(at(0)) })
    const second = await inboxService(deps).review({ since: Date.parse(at(0)), unansweredAfterHours: 0 })

    expect([first.tasks, second.tasks]).toEqual([
      { added: 1, closed: 0 },
      { added: 0, closed: 0 },
    ])
    expect((await store.tasks.list({})).map((task) => task.source)).toEqual(["msg:telegram/500/-1001/1"])
    await store.close()
  })
})

describe("serve's rule pass", () => {
  it("opens a task when a question arrives and closes it when the owner's answer arrives", async () => {
    const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "task-arrival-")), "messages.db") })
    const question = said("1", 1, "who has the keys?")
    await store.saveMessages(account, "-1001", [said("0", 0, "morning"), question], { via: "test" })

    expect(await applyTaskRulesOnArrival(store, account, question)).toEqual({ added: 1, closed: 0 })
    expect(await applyTaskRulesOnArrival(store, account, question)).toEqual({ added: 0, closed: 0 })

    const answer = said("2", 2, "I do", { outgoing: true, replyToId: "1" })
    await store.saveMessages(account, "-1001", [answer], { via: "test" })
    expect(await applyTaskRulesOnArrival(store, account, answer)).toEqual({ added: 0, closed: 1 })
    expect((await store.tasks.list({})).map((task) => task.state)).toEqual(["done"])
    await store.close()
  })

  it("sees an arrival the store has not saved yet", async () => {
    const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "task-arrival-")), "messages.db") })

    expect(await applyTaskRulesOnArrival(store, account, said("1", 1, "anyone?"))).toEqual({ added: 1, closed: 0 })
    await store.close()
  })
})

describe("a reply rule's task", () => {
  it("opens one request task for a message, however many times it arrives", async () => {
    const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "task-rule-")), "messages.db") })

    const first = await openRequestTask(store, account, said("41", 1))
    const again = await openRequestTask(store, account, said("41", 1))
    const tasks = await store.tasks.list({})

    expect([first, again]).toEqual([true, false])
    expect(tasks.map((task) => [task.kind, task.state, task.origin])).toEqual([["request", "open", "rule"]])
    await store.close()
  })
})
