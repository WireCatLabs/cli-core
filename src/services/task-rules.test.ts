import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import type { Messenger } from "../cli/messenger/context.js"
import type { Chat, Message, Review } from "../domain/models.js"
import { DEFAULT_TASK_CATEGORIES, withTaskCategory } from "../domain/task-categories.js"
import type { MessengerAdapter } from "../ports/messenger.js"
import type { SendGuard } from "../sends/guard.js"
import { openStore } from "../store/store.js"
import { memoryTaskStore } from "../tasks/testing/index.js"
import { onlineDeps } from "./deps.js"
import { inboxService } from "./inbox.js"
import { categorize } from "./task-categories.js"
import {
  applyTaskRules,
  applyTaskRulesOnArrival,
  applyTaskRulesSinceLastPass,
  applyTaskRulesToChats,
  applyTaskRulesToStored,
  openRequestTask,
} from "./task-rules.js"

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

    expect(await applyTaskRules(review, { store, account })).toEqual({ added: 1, closed: 0, review: 0 })
    expect(await applyTaskRules(review, { store, account })).toEqual({ added: 0, closed: 0, review: 0 })
    expect(await states(store)).toEqual(["msg:telegram/500/-1001/1 question open"])
  })

  it("picks a category by the trigger words of the message, in any form or language, else other", async () => {
    const store = memoryTaskStore()
    const review = reviewOf([
      said("1", 1, "когда оплатишь счета?"),
      said("2", 2, "can you sign the contract?"),
      said("3", 3, "¿quedamos para la reunión?"),
      said("4", 4, "how was the weekend?"),
    ])
    await applyTaskRules(review, { store, account })
    expect((await store.list({})).map((task) => task.category)).toEqual(["money", "documents", "meeting", "other"])
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
    expect(await applyTaskRules(later, { store, account })).toEqual({ added: 0, closed: 1, review: 0 })
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

    expect(await applyTaskRules(review, { store, account })).toEqual({ added: 0, closed: 0, review: 0 })
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
    expect(await applyTaskRules(answered, { store, account })).toEqual({ added: 0, closed: 1, review: 0 })
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
      { added: 1, closed: 0, review: 0 },
      { added: 0, closed: 0, review: 0 },
    ])
    expect((await store.tasks.list({})).map((task) => task.source)).toEqual(["msg:telegram/500/-1001/1"])
    await store.close()
  })
})

describe("serve's rule pass", () => {
  it("opens a task when a question arrives and closes it when the owner's answer arrives", async () => {
    const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "task-arrival-")), "messages.db") })
    const question = said("1", 1, "who has the keys?")
    await store.messages.saveMessages(account, "-1001", [said("0", 0, "morning"), question], { via: "test" })

    expect(await applyTaskRulesOnArrival(store, account, question)).toEqual({ added: 1, closed: 0, review: 0 })
    expect(await applyTaskRulesOnArrival(store, account, question)).toEqual({ added: 0, closed: 0, review: 0 })

    const answer = said("2", 2, "I do", { outgoing: true, replyToId: "1" })
    await store.messages.saveMessages(account, "-1001", [answer], { via: "test" })
    expect(await applyTaskRulesOnArrival(store, account, answer)).toEqual({ added: 0, closed: 1, review: 0 })
    expect((await store.tasks.list({})).map((task) => task.state)).toEqual(["done"])
    await store.close()
  })

  it("sees an arrival the store has not saved yet", async () => {
    const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "task-arrival-")), "messages.db") })

    expect(await applyTaskRulesOnArrival(store, account, said("1", 1, "anyone?"))).toEqual({
      added: 1,
      closed: 0,
      review: 0,
    })
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

  it("**picks the category from the list the owner saved in the store**", async () => {
    const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "task-rule-")), "messages.db") })
    await store.tasks.saveCategories(
      withTaskCategory(DEFAULT_TASK_CATEGORIES, "garden", "plants | seedling, ru:рассада"),
    )

    await openRequestTask(store, account, said("42", 1, "can you water my seedlings?"))
    expect((await store.tasks.list({})).map((task) => task.category)).toEqual(["garden"])
    await store.close()
  })

  it("**gives a tie to the narrower category**, and no trigger fires on a common word it stems like", () => {
    expect(categorize("Купи бабушке лекарства")).toBe("health")
    expect(categorize("Оплати квитанцию за электричество")).toBe("bills")
    expect(categorize("the billing page at this stage is fine")).toBe("other")
    expect(categorize("это другая история")).toBe("other")
  })

  it("**stems a Spanish message as Spanish**, so a verb form meets its trigger", () => {
    expect(categorize("pagar la factura")).toBe("money")
    expect(categorize("cita con el médico")).toBe("health")
    expect(categorize("vuelo a Madrid")).toBe("travel")
    expect(categorize("Necesito que me pagues los 50 €")).toBe("money")
    expect(categorize("Viajamos a Madrid el lunes")).toBe("travel")
  })

  it("**reads an English message as English**, so a word on a short Spanish stem fires nothing", () => {
    expect(categorize("update the landing page")).toBe("other")
    expect(categorize("please don't cite me on that")).toBe("other")
    expect(categorize("ask Al about the landing page, su to root if you must")).toBe("other")
  })
})

describe("the rule pass over the store", () => {
  it("reads only chats stored into after the stop point, and opens and closes as review did", async () => {
    const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "task-stored-")), "messages.db") })
    await store.messages.saveMessages(account, "-1001", [said("0", 0, "morning"), said("1", 1, "who has the keys?")], {
      via: "test",
    })

    const first = await applyTaskRulesToStored(store, account)
    expect(first).toMatchObject({ added: 1, closed: 0, until: expect.any(String) })
    expect(await applyTaskRulesToStored(store, account, first.until ?? undefined)).toEqual({
      added: 0,
      closed: 0,
      review: 0,
      until: first.until,
    })

    await new Promise((resolve) => setTimeout(resolve, 5))
    await store.messages.saveMessages(
      account,
      "-1001",
      [said("2", 2, "I do", { outgoing: true, replyToId: "1", timestamp: new Date().toISOString() })],
      {
        via: "test",
      },
    )
    const second = await applyTaskRulesToStored(store, account, first.until ?? undefined)
    expect(second).toMatchObject({ added: 0, closed: 1, review: 0 })
    expect(second.until && first.until && second.until > first.until).toBe(true)
    expect((await store.tasks.list({})).map((task) => task.state)).toEqual(["done"])
    await store.close()
  })

  it("**after a sync, starts where the last pass stopped**; the first reads only chats active in the last 14 days", async () => {
    const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "task-since-")), "messages.db") })
    const now = new Date(Date.UTC(2026, 9, 10))
    await store.tasks.saveFirstPassPerChat(1)
    await store.messages.saveMessages(account, "-1001", [said("1", 1, "who has the keys?")], { via: "test" })
    await store.messages.saveMessages(
      account,
      "-2002",
      [said("1", 1, "anyone seen the invoice?", { chatId: "-2002", timestamp: "2025-01-01T10:00:00.000Z" })],
      { via: "test" },
    )

    expect(await applyTaskRulesSinceLastPass(store, account, now)).toEqual({ added: 1, closed: 0, review: 0 })
    expect(await store.sync.taskRulesStop(account)).toEqual(expect.any(String))
    expect(await applyTaskRulesSinceLastPass(store, account, now)).toEqual({ added: 0, closed: 0, review: 0 })

    await new Promise((resolve) => setTimeout(resolve, 5))
    await store.messages.saveMessages(
      account,
      "-1001",
      [said("2", 2, "I do", { outgoing: true, replyToId: "1", timestamp: new Date().toISOString() })],
      {
        via: "test",
      },
    )
    expect(await applyTaskRulesSinceLastPass(store, account, now)).toEqual({ added: 0, closed: 1, review: 0 })
    await store.close()
  })

  it("**a first sync opens no task from history by default**, counts what it held, and still sets the stop point", async () => {
    const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "task-first-")), "messages.db") })
    const now = new Date(Date.UTC(2026, 9, 10))
    await store.messages.saveMessages(
      account,
      "-1001",
      [said("1", 1, "who has the keys?"), said("2", 2, "and the car?")],
      {
        via: "test",
      },
    )

    expect(await applyTaskRulesSinceLastPass(store, account, now)).toEqual({
      added: 0,
      closed: 0,
      review: 0,
      held: 2,
      heldChats: 1,
    })
    expect(await store.sync.taskRulesStop(account)).toEqual(expect.any(String))
    expect(await store.tasks.list({})).toEqual([])
    await store.close()
  })

  it("**opens only the newest task_first_pass_per_chat of a chat's history** on the first sync", async () => {
    const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "task-first-n-")), "messages.db") })
    await store.tasks.saveFirstPassPerChat(1)
    await store.messages.saveMessages(
      account,
      "-1001",
      [said("1", 1, "who has the keys?"), said("2", 2, "and the car?")],
      {
        via: "test",
      },
    )

    expect(await applyTaskRulesSinceLastPass(store, account, new Date(Date.UTC(2026, 9, 10)))).toMatchObject({
      added: 1,
      held: 1,
    })
    expect((await store.tasks.list({})).map((task) => task.source)).toEqual(["msg:telegram/500/-1001/2"])
    await store.close()
  })

  it("**after the first pass, history backfilled into a chat opens nothing**: only messages sent since are new", async () => {
    const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "task-backfill-")), "messages.db") })
    const now = new Date(Date.UTC(2026, 9, 10))
    await store.messages.saveMessages(account, "-1001", [said("1", 1, "morning")], { via: "test" })
    await applyTaskRulesSinceLastPass(store, account, now)

    await new Promise((resolve) => setTimeout(resolve, 5))
    await store.messages.saveMessages(account, "-3003", [said("7", 7, "who pays the rent?", { chatId: "-3003" })], {
      via: "test",
    })
    expect(await applyTaskRulesSinceLastPass(store, account, now)).toEqual({ added: 0, closed: 0, review: 0 })

    await new Promise((resolve) => setTimeout(resolve, 5))
    const today = new Date().toISOString()
    await store.messages.saveMessages(
      account,
      "-3003",
      [said("8", 8, "and the deposit?", { chatId: "-3003", timestamp: today })],
      { via: "test" },
    )
    expect(await applyTaskRulesSinceLastPass(store, account, now)).toMatchObject({ added: 2 })
    await store.close()
  })
})

describe("tasks apply", () => {
  it("lists what a chat's history would open and changes nothing; with yes it opens them", async () => {
    const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "task-apply-")), "messages.db") })
    await store.messages.saveMessages(
      account,
      "-1001",
      [
        said("1", 1, "when do you pay the invoice?"),
        said("2", 2, "hi"),
        said("3", 3, "Slava will bring it", { mentions: ["500"] }),
      ],
      { via: "test" },
    )

    const [dry] = await applyTaskRulesToChats(store, account, ["-1001"])
    expect(dry).toMatchObject({ chat: "-1001", messages: 3, added: 0 })
    expect(dry?.tasks).toEqual([
      { source: "msg:telegram/500/-1001/1", kind: "question", category: "money" },
      { source: "msg:telegram/500/-1001/3", kind: "mention", category: "other" },
    ])
    expect(await store.tasks.list({})).toEqual([])

    const [done] = await applyTaskRulesToChats(store, account, ["-1001"], { yes: true, last: 2 })
    expect(done).toMatchObject({ messages: 2, added: 1, tasks: [] })
    expect((await store.tasks.list({})).map((task) => task.source)).toEqual(["msg:telegram/500/-1001/3"])
    await store.close()
  })
})
