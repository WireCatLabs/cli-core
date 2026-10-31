import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseLucene } from "@wirecat/cli-base/query"
import * as v from "valibot"
import { afterEach, describe, expect, it, vi } from "vitest"
import { messageHitItem } from "../cli/messenger/search-answers.js"
import type { Message } from "../domain/models.js"
import { ENTITIES } from "../entities/index.js"
import { QUERY_LIMITS } from "../search/lucene/types.js"
import type { StoreContext } from "../store/sqlite/open.js"
import { directReplies } from "../store/sqlite/search.js"
import { type MessageStore, openStore } from "../store/store.js"
import type { FoundMessage } from "./messages.js"
import { searchStore } from "./messages-archive-search.js"
import { FOLLOW_UP_HITS } from "./messages-discovery.js"

const account = { provider: "synthetic", account: "500" }
const stores: MessageStore[] = []
afterEach(async () => {
  for (const s of stores.splice(0)) await s.close()
})
const msg = (id: string, text: string, extra: Partial<Message> = {}): Message => ({
  id,
  text,
  chatId: "101",
  senderId: "700",
  senderName: "Synthetic",
  timestamp: "2026-10-08T12:00:00.000Z",
  editedAt: null,
  outgoing: false,
  attachments: [],
  replyTo: null,
  forwardedFrom: null,
  reactions: null,
  ...extra,
})
const open = async () => {
  const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "discovery-test-")), "synthetic.db") })
  stores.push(store)
  await store.chats.saveChats(
    account,
    ["101", "102"].map((id) => ({
      id,
      title: "Synthetic",
      kind: "group" as const,
      unreadCount: 0,
      lastMessageAt: null,
      participantsCount: 10,
    })),
  )
  await store.messages.saveMessages(
    account,
    "101",
    [
      msg("1", "Helix export: what time should the daily export run?"),
      msg("2", "At 06:45 UTC.", { replyToId: "1" }),
      msg("3", "At 02:00 UTC.", { replyToId: "1", senderId: "701" }),
      msg("4", "At 01:00 UTC.", { replyToId: "1", timestamp: "2026-10-07T12:00:00.000Z" }),
      msg("5", "Helix logs expire after 21 days."),
    ],
    { via: "synthetic" },
  )
  await store.searchIndex.fillSearchIndex({})
  await store.searchIndex.fillStems({})
  return store
}
const request = (text: string) => ({ text, discover: true, limit: 10, timezone: "UTC" })
const ids = (result: { items: { id: string }[] }) => result.items.map((m) => m.id)

describe("archive discovery", () => {
  it("finds partial wording and direct replies without a conversation rebuild or archive snapshot", async () => {
    const store = await open()
    const found = await searchStore(store, account, request("What time does Helix export run?"))
    expect(ids(found)).toContain("2")
    expect(found.items.find((m) => m.id === "2")?.discovery?.parent).toBe("msg:synthetic/500/101/1")
    expect(found.query?.discovery).toMatchObject({ method: "lexical-partial", repliesAdded: 3 })
    expect(found.query?.discovery?.queries).toEqual(["(time OR helix OR export OR run)"])
    const partial = await searchStore(store, account, request("What is Helix ultraviolet retention?"))
    expect(partial.items.length).toBeGreaterThan(0)
    expect(partial.items.every((m) => m.discovery?.missingTerms.includes("ultraviolet"))).toBe(true)
    expect(
      (await searchStore(store, account, { ...request("What time does Helix export run?"), discover: false })).items,
    ).toEqual([])
  })
  it("reads a question mark as punctuation when the planner leaves the question as written", async () => {
    const store = await open()
    for (const text of ["Why do Helix logs expire?", "Почему Helix logs expire?"]) {
      const found = await searchStore(store, account, request(text))
      expect(found.query?.discovery?.method).toBe("lexical-partial")
      expect(ids(found)).toContain("5")
    }
  })
  it("does not fail on the colon of a time or a ratio in a question", async () => {
    const store = await open()
    for (const text of ["Do Helix logs expire before 22:00?", "Helix logs at a 1:1 ratio expire when?"])
      await expect(searchStore(store, account, request(text))).resolves.toBeDefined()
  })
  it("keeps the colons of a quoted timestamp in a date filter", async () => {
    const store = await open()
    const found = await searchStore(
      store,
      account,
      request('Can operators run Helix export? date:["2020-01-01T21:30:00Z" TO "2099-01-01T21:30:00Z"]'),
    )
    expect(ids(found)).toContain("2")
  })
  it("retrieves partial evidence for permission questions while retaining sender filters", async () => {
    const store = await open()
    for (const text of ["Can operators run Helix export?", "Могут операторы выполнить Helix export?"]) {
      const query = request(`${text} from:700`)
      const found = await searchStore(store, account, query)
      expect(found.query?.discovery?.method).toBe("lexical-partial")
      expect(ids(found)).toContain("2")
      expect(ids(found)).not.toContain("3")
      expect(await searchStore(store, account, { ...query, discover: false })).toMatchObject({ items: [] })
    }
  })
  it("preserves used correction provenance for keyword discovery", async () => {
    const store = await open()
    await store.messages.saveMessages(account, "101", [msg("6", "Helix rollout confirmed")], { via: "synthetic" })
    await store.searchIndex.fillSearchIndex({})
    await store.searchIndex.fillStems({})
    const found = await searchStore(store, account, request("Helix rolluot"))
    expect(found.items.find((m) => m.id === "6")?.match).toBe("corrected")
    expect(found.corrections).toEqual([{ from: "rolluot", to: ["rollout"] }])
  })
  it("retains eligible replies when the lexical shortlist is full", async () => {
    const store = await open()
    await store.messages.saveMessages(
      account,
      "101",
      Array.from({ length: 400 }, (_, n) => msg(String(2000 + n), "Helix export discussion heading")),
      { via: "synthetic" },
    )
    await store.searchIndex.fillSearchIndex({})
    await store.searchIndex.fillStems({})
    const found = await searchStore(store, account, request("What time does Helix export run?"))
    expect(ids(found)).toContain("2")
    expect(found.query?.discovery?.candidates).toBeLessThanOrEqual(300)
    expect(found.query?.discovery?.truncated).toBe(true)
  })
  it("checks both parent and reply against sender, date, chat and only filters", async () => {
    const store = await open()
    const scoped = await searchStore(
      store,
      account,
      request("What time does Helix export run? chat:101 from:700 date:2026-10-08"),
    )
    expect(ids(scoped)).toContain("2")
    expect(ids(scoped)).not.toContain("3")
    expect(ids(scoped)).not.toContain("4")
    const childOnly = await searchStore(store, account, {
      ...request("What time does Helix export run?"),
      only: [{ ...account, chatId: "101", id: "2" }],
    })
    expect(childOnly.items).toEqual([])
    const parentOnly = await searchStore(store, account, {
      ...request("What time does Helix export run?"),
      only: [{ ...account, chatId: "101", id: "1" }],
    })
    expect(ids(parentOnly)).toEqual(["1"])
    const fromChild = await searchStore(store, account, request("What time does Helix export run? from:701"))
    expect(ids(fromChild)).not.toContain("3")
  })
  it("isolates accounts/chats and excludes deleted parents and children", async () => {
    const store = await open()
    const other = { provider: "synthetic", account: "600" }
    await store.chats.saveChats(other, [
      { id: "101", title: "Other", kind: "group", unreadCount: 0, lastMessageAt: null, participantsCount: 10 },
    ])
    await store.messages.saveMessages(
      other,
      "101",
      [msg("1", "Helix export foreign parent"), msg("9", "Foreign reply", { replyToId: "1" })],
      { via: "synthetic" },
    )
    await store.messages.saveMessages(
      account,
      "102",
      [
        msg("1", "Other project export", { chatId: "102" }),
        msg("9", "Other chat reply", { chatId: "102", replyToId: "1" }),
      ],
      { via: "synthetic" },
    )
    await store.messages.markDeleted(account, ["3"], { chatId: "101" })
    const replies = await store.messages.directReplies?.([{ account, chatId: "101", id: "1" }], 100)
    expect(replies?.items.map((m) => m.id)).toEqual(["2", "4"])
    await store.messages.markDeleted(account, ["1"], { chatId: "101" })
    expect((await store.messages.directReplies?.([{ account, chatId: "101", id: "1" }], 100))?.items).toEqual([])
  })
  it.each([
    "Helix AND export",
    '"Helix export"',
    "Helix OR logs",
    "Helix NOT logs",
    "exact:Helix",
    "Helix*",
    "(Helix export)",
  ])("preserves explicit syntax %s", async (text) => {
    const store = await open()
    const strict = await searchStore(store, account, { ...request(text), discover: false })
    expect(await searchStore(store, account, request(text))).toEqual(strict)
  })
  it("preserves exact/newest/AST and surrounding context", async () => {
    const store = await open()
    for (const strict of [{ exact: true }, { newest: true }, { text: undefined, ast: parseLucene("Helix export") }]) {
      const q = { ...request("Helix export"), ...strict }
      expect(await searchStore(store, account, q)).toEqual(await searchStore(store, account, { ...q, discover: false }))
    }
    expect(
      (await searchStore(store, account, { ...request("What time does Helix export run?"), context: 1 })).items[0]
        ?.context?.length,
    ).toBeGreaterThan(0)
  })
  it("enforces input, cancellation and bounded reply bodies", async () => {
    const store = await open()
    for (const extra of [{ limit: 0 }, { context: 21 }, { backend: "server" as const }])
      await expect(searchStore(store, account, { ...request("Helix export"), ...extra })).rejects.toThrow()
    const controller = new AbortController()
    controller.abort()
    await expect(
      searchStore(store, account, { ...request("Helix export"), signal: controller.signal }),
    ).rejects.toThrow("aborted")
    const context = {
      database: { prepare: vi.fn(() => ({ all: () => [{ pk: 1, bytes: QUERY_LIMITS.bodyBytes + 1 }] })) },
    } as unknown as StoreContext
    expect(() => directReplies(context, [{ account, chatId: "101", id: "1" }], 100)).toThrow("bodyBytes")
  })
})

describe("discovery follow-ups", () => {
  const day = (d: number) => `2026-10-${String(d).padStart(2, "0")}T12:00:00.000Z`
  const project = async () => {
    const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "follow-ups-test-")), "synthetic.db") })
    stores.push(store)
    await store.chats.saveChats(
      account,
      ["101", "102", "103"].map((id) => ({
        id,
        title: { "101": "Supply", "102": "Ops", "103": "General" }[id] ?? id,
        kind: "group" as const,
        unreadCount: 0,
        lastMessageAt: null,
        participantsCount: 10,
      })),
    )
    await store.messages.saveMessages(
      account,
      "101",
      [
        msg("1", "Which supplier for the crates? Contract draft attached.", { timestamp: day(1) }),
        msg("2", "Decision: the supplier is Brightwell, contract for one year.", { timestamp: day(2) }),
        msg("3", "Contract template is in the drive.", { timestamp: day(3) }),
      ],
      { via: "synthetic" },
    )
    await store.messages.saveMessages(
      account,
      "102",
      [
        msg("1", "Brightwell sent a price list.", { chatId: "102", timestamp: day(1) }),
        msg("2", "Contract review moved to Friday.", { chatId: "102", timestamp: day(4) }),
        msg("3", "Brightwell is out, they cannot ship before spring.", { chatId: "102", timestamp: day(5) }),
      ],
      { via: "synthetic" },
    )
    // Common words must be common: in a store of six messages every word would be rare.
    await store.messages.saveMessages(
      account,
      "103",
      ["1", "2", "3", "4"].map((id) =>
        msg(id, "Which supplier is the one for the contract, they say, and what about next year?", {
          chatId: "103",
          timestamp: "2026-09-20T12:00:00.000Z",
        }),
      ),
      { via: "synthetic" },
    )
    await store.searchIndex.fillSearchIndex({})
    await store.searchIndex.fillStems({})
    return store
  }
  const question = request("Which supplier did we pick for the crates?")
  const hitOf = (found: { items: FoundMessage[] }, locator: string) => found.items.find((m) => m.locator === locator)

  it("shows a later message from another chat that shares a rare word with a hit", async () => {
    const store = await project()
    const found = await searchStore(store, account, question)
    const decision = hitOf(found, "msg:synthetic/500/101/2")
    expect(found.items.indexOf(decision as FoundMessage)).toBeLessThan(FOLLOW_UP_HITS)
    expect(decision?.followUps?.map((m) => m.locator)).toEqual(["msg:synthetic/500/102/3"])
    expect(found.query?.discovery?.followUps).toBeGreaterThan(0)
    const item = messageHitItem(decision as FoundMessage)
    expect(item.follow_ups?.[0]).toMatchObject({ ref: "msg:synthetic/500/102/3", chat_title: "Ops" })
    expect(v.safeParse(ENTITIES["message.hit"], item).success).toBe(true)
  })
  it("links no word held by more than three messages, and nothing earlier than the hit", async () => {
    const store = await project()
    const later = await store.messages.laterSharingRare(
      [
        { account, chatId: "101", id: "1" },
        { account, chatId: "102", id: "1" },
      ],
      { rareAt: 3, limit: 20 },
    )
    expect(later[0]).toEqual([])
    expect(later[1]?.map((m) => m.locator)).toEqual(["msg:synthetic/500/102/3", "msg:synthetic/500/101/2"])
  })
  it("keeps to the accounts and filters the search reads", async () => {
    const store = await project()
    const other = { provider: "synthetic", account: "600" }
    await store.chats.saveChats(other, [
      { id: "101", title: "Other", kind: "group", unreadCount: 0, lastMessageAt: null, participantsCount: 10 },
    ])
    await store.messages.markDeleted(account, ["3"], { chatId: "102" })
    await store.messages.saveMessages(
      other,
      "101",
      [msg("7", "Brightwell again, other account.", { timestamp: day(6) })],
      {
        via: "synthetic",
      },
    )
    await store.searchIndex.fillSearchIndex({})
    await store.searchIndex.fillStems({})
    const found = await searchStore(store, account, question)
    expect(hitOf(found, "msg:synthetic/500/101/2")?.followUps).toBeUndefined()
    const scoped = await searchStore(store, account, request("Which supplier did we pick for the crates? chat:101"))
    expect(scoped.items.every((m) => !m.followUps)).toBe(true)
  })
})
