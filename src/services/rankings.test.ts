import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { Message } from "../domain/models.js"
import { type MessageStore, openStore } from "../store/store.js"
import { storedDeps } from "./deps.js"
import { rankingsService } from "./rankings.js"
import { readRankingSelection } from "./rankings-selection.js"
import { searchesService } from "./searches.js"

const account = { provider: "fixture", account: "owner" }
const live: MessageStore[] = []
afterEach(async () => {
  for (const store of live.splice(0)) await store.close()
})
const setup = async () => {
  const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "ranking-service-")), "fixture.db") })
  live.push(store)
  await store.saveChats(account, [
    {
      id: "room",
      title: "Synthetic room",
      kind: "group",
      unreadCount: null,
      lastMessageAt: null,
      participantsCount: null,
    },
  ])
  const messages: Message[] = [1, 2, 3].map((i) => ({
    id: String(i),
    chatId: "room",
    senderId: i === 3 ? "bob" : "alice",
    senderName: i === 3 ? "Bob" : "Alice",
    timestamp: `2026-10-07T10:00:0${i}Z`,
    editedAt: null,
    text: "Synthetic fixture",
    outgoing: false,
    attachments: [],
    replyTo: null,
    forwardedFrom: null,
    reactions: { total: i, mine: null, counts: [] },
    providerMetadata: { views: i, graph: { version: 1, reply: null } },
  }))
  await store.saveMessages(account, "room", messages, { via: "history" })
  const messenger = {
    provider: "fixture",
    app: { command: "fixture", envPrefix: "FIXTURE", configName: "fixture", stateName: "fixture" },
    chatArgument: "stored chat",
    savedChatId: "me",
  }
  const deps = storedDeps(messenger as never, store, account, { check() {}, record() {} })
  return { store, deps, service: rankingsService(deps) }
}

describe("ranking services and drilldown selection", () => {
  it("returns structured message drilldown without transient signal/stemmer state", async () => {
    const { store, service } = await setup()
    const result = await service.top("messages", { measure: "views", limit: 2, signal: new AbortController().signal })
    expect(result.items[0]).toMatchObject({
      id: "3",
      value: 3,
      account,
      quality: { counterFreshness: "unknown" },
      drilldown: {
        evidence: { command: "stats messages evidence" },
        show: { command: "messages show", arguments: { message: "msg:fixture/owner/room/3" } },
      },
    })
    const selection = result.items[0]?.drilldown.selection
    expect(JSON.stringify(selection)).not.toMatch(/signal|stemmer/)
    expect(await readRankingSelection(store, selection)).toEqual(selection)
    expect(result).toMatchObject({
      page: 1,
      limit: 2,
      total: 3,
      ranking: { normalizationVersion: 1, counters: "cumulative_snapshots" },
    })
  })
  it("discloses field freshness and invalidates a cursor when only observation time changes", async () => {
    const { store, service } = await setup()
    const before = Date.now() - 2000
    await store.updateCounterObservations?.(account, "room", "3", {
      views: { value: 3, observedAt: new Date(before).toISOString(), source: "remote_fetch" },
    })
    const ranked = await service.top("messages", { measure: "views", limit: 1 })
    expect(ranked.items[0]).toMatchObject({
      quality: { counterFreshness: "fresh" },
      counterObservations: expect.arrayContaining([
        expect.objectContaining({ counter: "views", value: 3, observedAt: new Date(before).toISOString() }),
      ]),
    })
    const authors = await service.top("contacts", { measure: "reactions", limit: 3 })
    const alice = authors.items.find((row) => row.id === "alice")
    const options = { component: "reactions", limit: 1 }
    const page = await service.evidence("contacts", "alice", alice?.drilldown.selection, options)
    expect(page.nextCursor).toBeTruthy()
    await store.updateCounterObservations?.(account, "room", "2", {
      reactions: { value: 2, observedAt: new Date(Date.now() - 1000).toISOString(), source: "remote_fetch" },
    })
    await expect(
      service.evidence("contacts", "alice", alice?.drilldown.selection, {
        ...options,
        cursor: page.nextCursor ?? undefined,
      }),
    ).rejects.toMatchObject({ details: { reason: "evidence_changed" } })
  })

  it("records repeatable ranking parameters rather than results", async () => {
    const { store, service } = await setup()
    const result = await service.top("contacts", { weights: { messages: 1, words: 0 }, minMessages: 2, limit: 10 })
    const record = (await store.searchHistory(1))[0]
    expect(record).toMatchObject({
      command: "author-top",
      params: { target: "contacts", weights: { messages: 1, words: 0 }, minMessages: 2 },
    })
    expect(JSON.stringify(record?.params)).not.toContain("Synthetic fixture")
    expect(record?.params).not.toHaveProperty("items")
    expect(result.items[0]).toMatchObject({ id: "alice", value: 100, ranking: { score: 100 } })
  })
  it("rechecks held accounts and versioned query syntax on a supplied selector", async () => {
    const { store, service } = await setup()
    const selection = (await service.top("messages", { limit: 1 })).items[0]?.drilldown.selection
    const changed = JSON.parse(JSON.stringify(selection))
    changed.execution.accounts[0].account = "not-held"
    await expect(readRankingSelection(store, changed)).rejects.toThrow("not held")
    const malformed = JSON.parse(JSON.stringify(selection))
    malformed.execution.root.field = "invented"
    await expect(readRankingSelection(store, malformed)).rejects.toThrow()
    await expect(readRankingSelection(store, "{}")).rejects.toThrow("invalid")
    await expect(readRankingSelection(store, " ".repeat(65 * 1024))).rejects.toThrow("64 KiB")
  })
  it("rejects malformed selector fields rather than coercing or retaining unrelated data", async () => {
    const { store, service } = await setup()
    const original = (await service.top("messages", { limit: 1 })).items[0]?.drilldown.selection
    for (const patch of [
      { target: ["messages"] },
      { options: { measure: "views", resultBody: "not a selector" } },
      { options: { measure: ["views"] } },
    ]) {
      await expect(readRankingSelection(store, { ...original, ...patch })).rejects.toThrow("invalid")
    }
    const changed = JSON.parse(JSON.stringify(original))
    changed.execution.root.operator = { toString: "not a function" }
    await expect(readRankingSelection(store, changed)).rejects.toThrow("invalid")
  })
  it("keeps resolved date boundaries pinned when replaying a selector", async () => {
    const { store, service } = await setup()
    const result = await service.top("messages", { text: "date:[2026-10-07 TO 2026-10-08}", timezone: "UTC", limit: 1 })
    const selection = await readRankingSelection(store, result.items[0]?.drilldown.selection)
    expect(selection.execution.root).toMatchObject({
      resolution: { date: { lower: Date.parse("2026-10-07T00:00:00Z"), upper: Date.parse("2026-10-08T00:00:00Z") } },
    })
  })
  it("pages contributing messages and rejects a changed or swapped cursor", async () => {
    const { store, service } = await setup()
    const row = (await service.top("contacts", { measure: "messages", limit: 10 })).items[0]
    if (!row) throw new Error("fixture row missing")
    const first = await service.evidence("contacts", row.id, row.drilldown.selection, {
      component: "messages",
      limit: 1,
    })
    expect(first).toMatchObject({ total: 2, included: 1, hasMore: true })
    const second = await service.evidence("contacts", row.id, row.drilldown.selection, {
      component: "messages",
      limit: 1,
      cursor: first.nextCursor ?? "",
    })
    expect(second.items.map(({ message }) => message.id)).toEqual(["2"])
    expect(second.hasMore).toBe(false)
    const one = (await store.messages(account, "room", { limit: 10 })).items.find(({ id }) => id === "1")
    if (!one) throw new Error("fixture message missing")
    await store.saveMessages(account, "room", [{ ...one, text: "Changed synthetic fixture" }], { via: "history" })
    await expect(
      service.evidence("contacts", row.id, row.drilldown.selection, {
        component: "messages",
        limit: 1,
        cursor: first.nextCursor ?? "",
      }),
    ).rejects.toThrow("changed")
    await expect(
      service.evidence("contacts", "wrong", row.drilldown.selection, { component: "messages", limit: 1 }),
    ).rejects.toThrow("match")
    await expect(
      service.evidence("contacts", row.id, row.drilldown.selection, { component: "invented", limit: 1 }),
    ).rejects.toThrow("component")
  })
  it("returns direct reply and answer pairs from the same scoped calculation", async () => {
    const { store, service } = await setup()
    const all = (await store.messages(account, "room", { limit: 10 })).items
    const question = all.find(({ id }) => id === "1")
    const answer = all.find(({ id }) => id === "3")
    if (!question || !answer) throw new Error("fixture messages missing")
    await store.saveMessages(
      account,
      "room",
      [
        { ...question, text: "Synthetic question?" },
        {
          ...answer,
          replyToId: "1",
          providerMetadata: { graph: { version: 1, reply: { chatId: "room", messageId: "1" } } },
        },
      ],
      { via: "history" },
    )
    const post = (await service.top("messages", { measure: "replies", limit: 10 })).items.find(({ id }) => id === "1")
    if (!post) throw new Error("fixture post missing")
    const replies = await service.evidence("messages", "msg:fixture/owner/room/1", post.drilldown.selection, {
      component: "replies",
      limit: 20,
    })
    expect(replies.items[0]).toMatchObject({ message: { id: "3" }, related: { id: "1" }, contribution: 1 })
    const person = (await service.top("contacts", { measure: "answers", limit: 10 })).items.find(
      ({ id }) => id === "bob",
    )
    if (!person) throw new Error("fixture person missing")
    const answers = await service.evidence("contacts", "bob", person.drilldown.selection, {
      component: "answers",
      limit: 20,
    })
    expect(answers.items[0]).toMatchObject({ message: { id: "3" }, related: { id: "1" }, contribution: 1 })
  })
  it("replays pinned metric options without replacing them with defaults", async () => {
    const { service } = await setup()
    const original = await service.top("messages", { measure: "views", limit: 1 })
    const replay = await service.top("messages", { selection: original.items[0]?.drilldown.selection, limit: 3 })
    expect(replay.ranking.measure).toBe("views")
    expect(replay.items.map(({ id }) => id)).toEqual(["3", "2", "1"])
    const scored = await service.top("messages", {
      selection: original.items[0]?.drilldown.selection,
      weights: { reactions: 1 },
      limit: 3,
    })
    expect(scored.ranking).toMatchObject({ measure: "score", weights: { reactions: 1 } })
    const measured = await service.top("messages", {
      selection: scored.items[0]?.drilldown.selection,
      measure: "views",
      limit: 3,
    })
    expect(measured.ranking.measure).toBe("views")
  })
  it("keeps invalid reaction snapshots unknown in contributing evidence", async () => {
    const { service, store } = await setup()
    const one = (await store.messages(account, "room", { limit: 10 })).items.find(({ id }) => id === "1")
    if (!one) throw new Error("fixture message missing")
    await store.saveMessages(account, "room", [{ ...one, reactions: { total: -1, mine: null, counts: [] } }], {
      via: "history",
    })
    const row = (await service.top("contacts", { measure: "reactions", limit: 10 })).items.find(
      ({ id }) => id === "alice",
    )
    if (!row) throw new Error("fixture row missing")
    expect(row).toMatchObject({ value: 2, quality: { reactions: "partial" } })
    const evidence = await service.evidence("contacts", "alice", row.drilldown.selection, {
      component: "reactions",
      limit: 20,
    })
    expect(evidence.items.map(({ contribution }) => contribution)).toEqual([null, 2])
  })
  it("refuses an oversized evidence row with a usable locator instruction", async () => {
    const { service, store } = await setup()
    const one = (await store.messages(account, "room", { limit: 10 })).items.find(({ id }) => id === "1")
    if (!one) throw new Error("fixture message missing")
    await store.saveMessages(account, "room", [{ ...one, text: "x".repeat(70 * 1024) }], { via: "history" })
    const row = (await service.top("contacts", { measure: "messages", limit: 10 })).items[0]
    if (!row) throw new Error("fixture row missing")
    await expect(
      service.evidence("contacts", row.id, row.drilldown.selection, { component: "messages", limit: 20 }),
    ).rejects.toThrow("messages show")
  })
  it("expands a channel to its held discussion and keeps replay scope pinned", async () => {
    const { service, store } = await setup()
    await store.saveChats(account, [
      {
        id: "channel",
        title: "Synthetic channel",
        kind: "channel",
        unreadCount: null,
        lastMessageAt: null,
        participantsCount: null,
      },
      {
        id: "discussion",
        title: "Synthetic discussion",
        kind: "group",
        unreadCount: null,
        lastMessageAt: null,
        participantsCount: null,
      },
    ])
    const template = (await store.messages(account, "room", { limit: 1 })).items[0]
    if (!template) throw new Error("fixture message missing")
    await store.saveMessages(
      account,
      "channel",
      [
        {
          ...template,
          id: "post",
          chatId: "channel",
          senderId: "channel",
          senderIsChat: true,
          providerMetadata: { graph: { version: 1, reply: null, discussionChatId: "discussion" } },
        },
      ],
      { via: "history" },
    )
    await store.saveMessages(
      account,
      "discussion",
      [
        {
          ...template,
          id: "copy",
          chatId: "discussion",
          senderId: "channel",
          senderIsChat: true,
          providerMetadata: {
            graph: { version: 1, reply: null, discussionSource: { chatId: "channel", messageId: "post" } },
          },
        },
        {
          ...template,
          id: "comment",
          chatId: "discussion",
          senderId: "bob",
          providerMetadata: { graph: { version: 1, reply: { chatId: "discussion", messageId: "copy" } } },
        },
      ],
      { via: "history" },
    )
    const found = await service.top("messages", {
      chat: "channel",
      messageKind: "comments",
      measure: "reactions",
      limit: 10,
    })
    expect(found.expandedDiscussionChats).toEqual(["discussion"])
    expect(found.items.map(({ id }) => id)).toEqual(["comment"])
    const replay = await service.top("messages", { selection: found.items[0]?.drilldown.selection, limit: 10 })
    expect(replay.items.map(({ id }) => id)).toEqual(["comment"])
  })
  it("bounds serialized fingerprint bytes including JSON escaping", async () => {
    const { service, store } = await setup()
    const messages = (await store.messages(account, "room", { limit: 10 })).items.filter(
      ({ senderId }) => senderId === "alice",
    )
    await store.saveMessages(
      account,
      "room",
      messages.map((message) => ({ ...message, text: "\u0000".repeat(710_000) })),
      { via: "history" },
    )
    const row = (await service.top("contacts", { measure: "messages", limit: 10 })).items[0]
    if (!row) throw new Error("fixture row missing")
    await expect(
      service.evidence("contacts", row.id, row.drilldown.selection, { component: "messages", limit: 1 }),
    ).rejects.toThrow("fingerprint budget")
  })
  it("preserves exclusive date flags through saved selection serialization and replay", async () => {
    const { service, deps } = await setup()
    const original = await service.top("messages", {
      text: "date:[2026-10-07 TO 2026-10-08}",
      measure: "views",
      timezone: "UTC",
      limit: 1,
    })
    const selection = original.items[0]?.drilldown.selection
    if (!selection) throw new Error("fixture selection missing")
    const searches = searchesService(deps)
    await searches.create("exclusive-date", {
      selection,
      target: "messages",
      ...selection.options,
      timezone: "UTC",
      language: "lucene",
    })
    const saved = (await searches.resolve("exclusive-date", {})).params
    const replay = await service.top("messages", { ...saved, weights: { reactions: 1 }, measure: undefined, limit: 3 })
    expect(replay.items.map(({ id }) => id)).toEqual(["3", "2", "1"])
    expect(replay.items[0]?.drilldown.selection.execution.root).toMatchObject({
      upper_inclusive: false,
      resolution: { date: { upper_inclusive: false } },
    })
  })
})
