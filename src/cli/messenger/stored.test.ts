import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { Message, MessageEvent } from "../../domain/models.js"
import { countedPoll } from "../../domain/polls.js"
import type { HistoryBatch, MessengerAdapter } from "../../ports/messenger.js"
import { type DeletionScope, type MessageStore, openStore } from "../../store/store.js"
import { storedMessages } from "./context.js"
import { stored } from "./stored.js"

const account = { provider: "test", account: "500" }

const message = (id: string, text: string, chatId = "7"): Message => ({
  id,
  chatId,
  senderId: "500",
  senderName: "Me",
  timestamp: "2026-09-26T10:00:00.000Z",
  editedAt: null,
  text,
  outgoing: true,
  attachments: [],
  replyTo: null,
  forwardedFrom: null,
  reactions: null,
})

const opened: MessageStore[] = []
afterEach(async () => {
  for (const store of opened.splice(0)) await store.close()
})

const setUp = async () => {
  const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "stored-")), "m.db") })
  opened.push(store)
  await store.chats.saveChats(account, [
    { id: "7", title: "Book club", kind: "group", unreadCount: 0, lastMessageAt: null, participantsCount: 3 },
    { id: "8", title: "Olga", kind: "dialog", unreadCount: 0, lastMessageAt: null, participantsCount: 2 },
  ])
  await store.messages.saveMessages(account, "7", [message("1", "the meeting is on tuesday")], { via: "history" })
  const adapter = {
    self: () => "500",
    edit: async (chatId: string, messageId: string, text: string) => message(messageId, text, chatId),
    forward: async () => message("90", "the meeting is on tuesday", "8"),
    delete: async () => {},
  }
  const wrapped = stored(adapter as unknown as MessengerAdapter, {
    account,
    store: async () => store,
    warn: () => {},
    events: () => {},
    profile: { app: "chat", name: "work" },
  })
  const found = async (text: string) =>
    (await store.messages.search(text, { limit: 10, account })).items.map((hit) => hit.id)
  return { wrapped, found, store }
}

describe("what the writes leave in the store", () => {
  it("an edit replaces the text search finds", async () => {
    const { wrapped, found } = await setUp()

    await wrapped.edit?.("7", "1", "the meeting moved to friday", {})

    expect(await found("tuesday")).toEqual([])
    expect(await found("friday")).toEqual(["1"])
  })

  it("the first save records which account the profile is, for other apps to name it", async () => {
    const { wrapped, store } = await setUp()
    expect(await store.accounts.profiles()).toEqual({})

    await wrapped.edit?.("7", "1", "the meeting moved to friday", {})

    expect(await store.accounts.profiles()).toEqual({ chat: { work: account } })
  })

  it("a deletion leaves nothing for search to find", async () => {
    const { wrapped, found } = await setUp()

    await wrapped.delete?.("7", ["1"], { forEveryone: false })

    expect(await found("tuesday")).toEqual([])
  })

  it("a forward keeps its copy in the chat it went to", async () => {
    const { wrapped, found } = await setUp()

    await wrapped.forward?.("7", "1", "8", { sendId: "1" })

    expect(await found("tuesday")).toEqual(["90", "1"])
  })
})

describe("what a chat list leaves in the store", () => {
  const listing = async (pages: { items: string[]; hasMore: boolean }, window: { limit?: number; offset: number }) => {
    const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "stored-")), "m.db") })
    opened.push(store)
    const chat = (id: string) => ({
      id,
      title: id,
      kind: "group" as const,
      unreadCount: 0,
      lastMessageAt: null,
      participantsCount: 2,
    })
    await store.chats.saveChats(account, [chat("7"), chat("8")])
    const adapter = { self: () => "500", chats: async () => ({ items: pages.items.map(chat), hasMore: pages.hasMore }) }
    const wrapped = stored(adapter as unknown as MessengerAdapter, {
      account,
      store: async () => store,
      warn: () => {},
      events: () => {},
    })
    await wrapped.chats?.(window)
    return (await store.chats.chats(account, {})).items.map((one) => one.id).sort()
  }

  it("a page that names every chat marks the others as left", async () => {
    expect(await listing({ items: ["7"], hasMore: false }, { offset: 0 })).toEqual(["7"])
  })

  it("a later page, a page with more after it, or an empty answer marks nothing", async () => {
    expect(await listing({ items: ["7"], hasMore: false }, { offset: 20 })).toEqual(["7", "8"])
    expect(await listing({ items: ["7"], hasMore: true }, { limit: 1, offset: 0 })).toEqual(["7", "8"])
    expect(await listing({ items: [], hasMore: false }, { offset: 0 })).toEqual(["7", "8"])
  })
})

describe("a deletion `watch` hears without its chat", () => {
  const deleting = async (deletedWithoutChat?: DeletionScope) => {
    const { store } = await setUp()
    await store.messages.saveMessages(account, "8", [message("1", "see you tuesday", "8")], { via: "history" })
    const pending = new Set<Promise<void>>()
    const adapter = {
      self: () => "500",
      watch: async (onEvent: (event: MessageEvent) => void) => {
        onEvent({ event: "delete", chatId: null, chatTitle: null, messageId: "1" })
      },
    }
    const wrapped = stored(adapter as unknown as MessengerAdapter, {
      account,
      store: async () => store,
      warn: () => {},
      events: () => {},
      pending,
      ...(deletedWithoutChat ? { deletedWithoutChat } : {}),
    })
    await wrapped.watch?.(() => {}, new AbortController().signal)
    await Promise.all(pending)
    return {
      inGroup: await store.messages.message(account, "1", { chatId: "7" }),
      inDialog: await store.messages.message(account, "1", { chatId: "8" }),
    }
  }

  it("tombstones the one message in the chats the messenger's rule accepts", async () => {
    const { inGroup, inDialog } = await deleting((chat) => chat.kind === "dialog")
    expect(inGroup).toBeDefined()
    expect(inDialog).toBeUndefined()
  })

  it("without the rule, leaves an id two chats share alone", async () => {
    const { inGroup, inDialog } = await deleting()
    expect(inGroup).toBeDefined()
    expect(inDialog).toBeDefined()
  })
})

const listening = async (store: MessageStore, events: MessageEvent[], extra: Record<string, unknown> = {}) => {
  const pending = new Set<Promise<void>>()
  const adapter = {
    self: () => "500",
    watch: async (onEvent: (event: MessageEvent) => void) => {
      for (const event of events) onEvent(event)
    },
    ...extra,
  }
  const wrapped = stored(adapter as unknown as MessengerAdapter, {
    account,
    store: async () => store,
    warn: () => {},
    events: () => {},
    pending,
  })
  await wrapped.watch?.(() => {}, new AbortController().signal)
  await Promise.all(pending)
  return wrapped
}

describe("an edit `watch` hears", () => {
  it("keeps the send time, the quote and the reactions an edit event does not carry", async () => {
    const { store } = await setUp()
    const reactions = { counts: [{ reaction: "👍", count: 2 }], mine: null, total: 2 }
    const quote = {
      id: "0",
      senderId: "9",
      senderName: "Olga",
      timestamp: null,
      text: "when?",
      attachments: [],
      outgoing: false,
    }
    await store.messages.saveMessages(account, "7", [{ ...message("1", "on tuesday"), replyTo: quote, reactions }], {
      via: "history",
    })

    const editedAt = "2026-09-26T10:05:00.000Z"
    const edit = { ...message("1", "on friday"), timestamp: editedAt, editedAt, chatTitle: "Book club" }
    await listening(store, [{ event: "edit", message: { ...edit, reactions: { counts: [], mine: null, total: 0 } } }])

    expect(await store.messages.message(account, "1", { chatId: "7" })).toMatchObject({
      text: "on friday",
      timestamp: "2026-09-26T10:00:00.000Z",
      editedAt,
      replyTo: { id: "0", text: "when?" },
      reactions,
    })
  })

  it("takes the earlier send time when the edit was stored before the message it changed", async () => {
    const { store } = await setUp()
    const editedAt = "2026-09-26T10:05:00.000Z"
    const edit = { ...message("2", "on friday"), timestamp: editedAt, editedAt, chatTitle: "Book club" }
    await listening(store, [{ event: "edit", message: edit }])

    await store.messages.saveMessages(account, "7", [{ ...message("2", "on friday"), editedAt }], { via: "history" })

    expect((await store.messages.message(account, "2", { chatId: "7" }))?.timestamp).toBe("2026-09-26T10:00:00.000Z")
  })
})

describe("polls in the store", () => {
  const poll = { question: "When?", answers: ["Tue", "Fri"], multiple: false, anonymous: false }

  it("a poll the owner creates is stored, as a send is", async () => {
    const { store } = await setUp()
    const wrapped = await listening(store, [], {
      createPoll: async () => ({ message: message("40", "When?"), sendId: "s" }),
    })

    await wrapped.createPoll?.("7", poll, { sendId: "s" })

    expect((await store.messages.message(account, "40", { chatId: "7" }))?.text).toBe("When?")
  })

  it("keeps each voter's newest vote, a take-back included, and the owner's own", async () => {
    const { store } = await setUp()
    const olga = { id: "9", name: "Olga", username: null }
    const vote = (answers: string[], votedAt: string) => ({
      event: "vote" as const,
      chatId: "7",
      chatTitle: "Book club",
      messageId: "40",
      vote: { person: olga, answers, votedAt },
    })
    const wrapped = await listening(
      store,
      [
        vote(["fri"], "2026-09-26T10:02:00.000Z"),
        vote(["tue"], "2026-09-26T10:01:00.000Z"),
        {
          ...vote(["tue"], "2026-09-26T10:03:00.000Z"),
          vote: { person: { ...olga, id: "10", name: "Ivan" }, answers: ["tue"], votedAt: "2026-09-26T10:03:00.000Z" },
        },
        {
          ...vote([], "2026-09-26T10:04:00.000Z"),
          vote: { person: { ...olga, id: "10", name: "Ivan" }, answers: [], votedAt: "2026-09-26T10:04:00.000Z" },
        },
      ],
      { vote: async () => ({}) },
    )
    await wrapped.vote?.("7", "40", ["tue"])

    const votes = await store.messages.pollVotes(account, "7", "40")
    expect(votes.map(({ person, answers }) => [person.id, person.name, answers])).toEqual([
      ["500", "Me", ["tue"]],
      ["10", "Ivan", []],
      ["9", "Olga", ["fri"]],
    ])
  })

  it("a deleted poll keeps no votes, and takes none after", async () => {
    const { store } = await setUp()
    await store.messages.saveMessages(account, "7", [message("40", "When?")], { via: "history" })
    const vote = {
      person: { id: "9", name: "Olga", username: null },
      answers: ["fri"],
      votedAt: "2026-09-26T10:02:00.000Z",
    }
    await store.messages.saveVote(account, "7", "40", vote)

    await store.messages.markDeleted(account, ["40"], { chatId: "7" })
    await store.messages.saveVote(account, "7", "40", vote)

    expect(await store.messages.pollVotes(account, "7", "40")).toEqual([])
  })
})

describe("votes in a pushed history batch", () => {
  const olga = { id: "9", name: "Olga", username: null }
  const vote = (answers: string[], votedAt: string, messageId = "40", chatId = "7") => ({
    chatId,
    messageId,
    vote: { person: olga, answers, votedAt },
  })
  const fed = async (store: MessageStore, batch: HistoryBatch) => {
    const pending = new Set<Promise<void>>()
    const adapter = { self: () => "500", feed: async (onBatch: (batch: HistoryBatch) => void) => onBatch(batch) }
    const wrapped = stored(adapter as unknown as MessengerAdapter, {
      account,
      store: async () => store,
      warn: () => {},
      events: () => {},
      pending,
    })
    await wrapped.feed?.(() => {}, new AbortController().signal)
    await Promise.all(pending)
  }
  const answers = async (store: MessageStore, messageId = "40", chatId = "7") =>
    (await store.messages.pollVotes(account, chatId, messageId)).map((held) => [held.person.id, held.answers])

  it("keeps a poll and its votes from one batch, the newest vote of each voter winning", async () => {
    const { store } = await setUp()

    await fed(store, {
      messages: [message("40", "When?"), message("41", "Where?", "8")],
      votes: [
        vote(["fri"], "2026-09-26T10:02:00.000Z"),
        vote(["tue"], "2026-09-26T10:01:00.000Z"),
        vote(["home"], "2026-09-26T10:01:00.000Z", "41", "8"),
      ],
    })

    expect(await answers(store)).toEqual([["9", ["fri"]]])
    expect(await answers(store, "41", "8")).toEqual([["9", ["home"]]])
  })

  it("a history vote older than the one `watch` heard does not replace it", async () => {
    const { store } = await setUp()
    await store.messages.saveVote(account, "7", "1", vote(["tue"], "2026-09-26T10:05:00.000Z").vote)

    await fed(store, { votes: [vote(["fri"], "2026-09-26T10:02:00.000Z", "1")] })

    expect(await answers(store, "1")).toEqual([["9", ["tue"]]])
  })

  it("a vote in a poll the store holds as deleted is dropped", async () => {
    const { store } = await setUp()
    await store.messages.markDeleted(account, ["1"], { chatId: "7" })

    await fed(store, { votes: [vote(["fri"], "2026-09-26T10:02:00.000Z", "1")] })

    expect(await answers(store, "1")).toEqual([])
  })
})

describe("the stored-messages lookup an adapter gets", () => {
  const at = (id: string, chatId: string, timestamp: string, outgoing = true): Message => ({
    ...message(id, `message ${id}`, chatId),
    timestamp,
    outgoing,
  })

  it("anchors on the oldest message, or the newest at or before a moment, past deleted ones", async () => {
    const { store } = await setUp()
    await store.messages.saveMessages(
      account,
      "9",
      [
        at("a", "9", "2026-09-01T10:00:00.000Z"),
        at("b", "9", "2026-09-02T10:00:00.000Z"),
        at("c", "9", "2026-09-03T10:00:00.000Z"),
      ],
      { via: "history" },
    )
    await store.messages.markDeleted(account, ["a"], { chatId: "9" })
    const lookup = storedMessages(
      "test",
      async () => store,
      () => "500",
    )

    expect((await lookup.anchor("9"))?.id).toBe("b")
    expect((await lookup.anchor("9", "2026-09-03T10:00:00.000Z"))?.id).toBe("c")
    expect((await lookup.anchor("9", "2026-09-02T12:00:00.000Z"))?.id).toBe("b")
    expect(await lookup.anchor("9", "2026-08-01T00:00:00.000Z")).toBeUndefined()
  })

  it("knows whom the account wrote to: a dialog named by the person, or one they are a member of", async () => {
    const { store } = await setUp()
    await store.messages.saveMessages(account, "8", [at("d", "8", "2026-09-01T10:00:00.000Z")], { via: "history" })
    await store.chats.saveChats(account, [
      { id: "d-33", title: "Ivan", kind: "dialog", unreadCount: 0, lastMessageAt: null, participantsCount: 2 },
    ])
    await store.roster.saveMembers(account, "d-33", ["33"])
    await store.messages.saveMessages(account, "d-33", [at("e", "d-33", "2026-09-01T10:00:00.000Z")], {
      via: "history",
    })
    await store.messages.saveMessages(account, "44", [at("f", "44", "2026-09-01T10:00:00.000Z", false)], {
      via: "history",
    })
    const lookup = storedMessages(
      "test",
      async () => store,
      () => "500",
    )

    expect(await lookup.wroteTo("8")).toBe(true)
    expect(await lookup.wroteTo("33")).toBe(true)
    expect(await lookup.wroteTo("44")).toBe(false)
    expect(await lookup.wroteTo("9")).toBe(false)
  })

  it("answers nothing before the connection knows its account", async () => {
    const { store } = await setUp()
    const lookup = storedMessages(
      "test",
      async () => store,
      () => null,
    )

    expect(await lookup.anchor("7")).toBeUndefined()
    expect(await lookup.wroteTo("8")).toBe(false)
    expect(await lookup.pollVotes("7", "40")).toEqual([])
  })

  it("hands over the poll's votes, which countedPoll turns into counts and the owner's choice", async () => {
    const { store } = await setUp()
    const voted = (id: string, answers: string[]) => ({
      person: { id, name: null, username: null },
      answers,
      votedAt: "2026-09-26T10:02:00.000Z",
    })
    await store.messages.saveVote(account, "7", "40", voted("9", ["fri"]))
    await store.messages.saveVote(account, "7", "40", voted("10", ["fri", "tue"]))
    await store.messages.saveVote(account, "7", "40", voted("500", ["tue"]))
    await store.messages.saveVote(account, "7", "40", voted("11", []))
    const lookup = storedMessages(
      "test",
      async () => store,
      () => "500",
    )
    const answer = (id: string) => ({ id, text: id, voters: null, chosen: false })
    const poll = {
      chatId: "7",
      messageId: "40",
      question: "When?",
      answers: [answer("tue"), answer("fri")],
      closed: false,
      multiple: true,
      anonymous: false,
      voters: null,
    }

    const counted = countedPoll(poll, await lookup.pollVotes("7", "40"), "500")

    expect(counted.voters).toBe(3)
    expect(counted.answers.map(({ id, voters, chosen }) => [id, voters, chosen])).toEqual([
      ["tue", 2, true],
      ["fri", 2, false],
    ])
  })
})
