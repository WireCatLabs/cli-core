import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { Message } from "../domain/models.js"
import { type MessageStore, openStore } from "../store/store.js"
import { adminStatisticsService } from "./admin-statistics.js"
import { storedDeps } from "./deps.js"
import { searchesService } from "./searches.js"

const account = { provider: "fixture", account: "owner" }
const stores: MessageStore[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const store of stores.splice(0)) await store.close()
})
const message = (
  id: string,
  text: string,
  day: number,
  sender = "member",
  reply?: string,
  chatId = "room",
): Message => ({
  id,
  chatId,
  senderId: sender,
  senderName: sender,
  timestamp: `2026-10-${String(day).padStart(2, "0")}T10:00:00Z`,
  editedAt: null,
  text,
  outgoing: false,
  reactions: null,
  attachments: [],
  replyTo: null,
  forwardedFrom: null,
  providerMetadata: { graph: { version: 1, reply: reply ? { chatId: "room", messageId: reply } : null } },
  ...(reply ? { replyToId: reply } : {}),
})
const save = (store: MessageStore, chat: string, messages: Message[]) =>
  store.messages.saveMessages(account, chat, messages, { via: "test" })
const setup = async () => {
  vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-08T12:00:00Z"))
  const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "admin-stats-")), "fixture.db") })
  stores.push(store)
  await store.chats.saveChats(account, [
    {
      id: "room",
      title: "Synthetic room",
      kind: "group",
      unreadCount: null,
      lastMessageAt: null,
      participantsCount: null,
    },
    {
      id: "channel",
      title: "Synthetic channel",
      kind: "channel",
      unreadCount: null,
      lastMessageAt: null,
      participantsCount: null,
    },
  ])
  await save(store, "room", [
    message("q", "Synthetic question?", 1),
    message("talk", "Synthetic next speaker", 2, "admin"),
    message("a", "Synthetic explicit response", 3, "admin", "q"),
    message("wait", "Synthetic waiting question?", 4),
    message("self", "Synthetic self reply", 5, "member", "wait"),
    message("url", "https://example.invalid/?q=1", 6),
  ])
  const deps = storedDeps(
    {
      provider: "fixture",
      app: { command: "fixture", envPrefix: "FIXTURE", configName: "fixture", stateName: "fixture" },
      chatArgument: "stored chat",
      savedChatId: "me",
    } as never,
    store,
    account,
    { check() {}, record() {} },
  )
  return { store, deps, service: adminStatisticsService(deps) }
}

describe("administrator stored reports", () => {
  it("does not close waiting questions because an admin speaks next; explicit later replies ignore root query filters", async () => {
    const { service } = await setup()
    const found = await service.report("responses", {
      text: "date:[2026-10-01 TO 2026-10-01] AND from:member",
      answerers: ["admin", "person:fixture/owner/zero"],
      limit: 20,
    })
    expect(found.summary).toMatchObject({ questions: 1, answered: 1, noObservedAnswer: 0 })
    expect(found.items.find((one) => one.id === "admin")).toMatchObject({
      answered: 1,
      medianMilliseconds: 2 * 86_400_000,
      p90Milliseconds: 2 * 86_400_000,
    })
    expect(found.items.find((one) => one.id === "zero")).toMatchObject({
      answered: 0,
      medianMilliseconds: null,
      p90Milliseconds: null,
      status: "unknown",
      identityKnown: false,
    })
    expect(found.quality).toMatchObject({ counterFreshness: "unknown", answererRoles: "user_selected_identities" })
    const waiting = await service.report("unanswered", { chat: "room", olderThan: "1h", limit: 20 })
    expect(waiting.items.map((one) => one.message)).toEqual(["msg:fixture/owner/room/wait"])
    expect(waiting.items[0]).toMatchObject({ status: "no-observed-answer" })
  })
  it("resolves names, aliases and usernames locally, rejects guesses and preserves a pinned identity after renaming", async () => {
    const { service, store } = await setup()
    await store.roster.saveRoster(account, "room", {
      members: [
        { id: "admin", name: "Alex Rivera", username: "alex_rivera", role: "member" },
        { id: "other", name: "Alex Kim", username: "alex_kim", role: "member" },
        { id: "opaque/x", name: "Quiet member", username: null, role: "member" },
      ],
      complete: false,
      participants: 3,
    })
    await store.people.setContactAlias(account, "admin", "Project lead")
    for (const reference of ["Alex Rivera", "@alex_rivera", "Project lead", "Rivera"]) {
      const found = await service.report("responses", { answerers: [reference], limit: 20 })
      expect(found.items[0]).toMatchObject({ id: "admin", answered: 1, identityKnown: true, status: "observed" })
      const row = found.items[0]
      if (!row) throw new Error("missing resolved row")
      await store.people.setContactAlias(account, "admin", "New alias")
      expect(
        (
          await service.evidence("contacts", "admin", row.drilldown.arguments.selection, {
            component: "report",
            limit: 20,
          })
        ).items[0]?.message.id,
      ).toBe("a")
      await store.people.setContactAlias(account, "admin", "Project lead")
    }
    await expect(service.report("responses", { answerers: ["Alex"], limit: 20 })).rejects.toMatchObject({
      code: "validation_error",
      details: {
        total: 2,
        candidates: expect.arrayContaining([expect.objectContaining({ id: "admin", account: "owner" })]),
      },
    })
    await expect(service.report("responses", { answerers: ["identity9"], limit: 20 })).rejects.toMatchObject({
      code: "not_found",
    })
    expect((await service.report("responses", { answerers: ["opaque/x"], limit: 20 })).items[0]).toMatchObject({
      answered: 0,
      identityKnown: true,
      status: "observed",
    })
    expect((await service.report("responses", { answerers: ["999"], limit: 20 })).items[0]).toMatchObject({
      answered: 0,
      identityKnown: false,
      status: "unknown",
    })
  })
  it("does not choose between matching names in different selected accounts", async () => {
    const { service, store } = await setup()
    await store.messages.saveMessages(
      { provider: "fixture", account: "other-owner" },
      "room",
      [message("other-q", "Another question?", 1, "admin")],
      { via: "test" },
    )
    await expect(
      service.report("responses", { source: "fixture", answerers: ["admin"], limit: 20 }),
    ).rejects.toMatchObject({ code: "validation_error", details: { total: 2 } })
    const scoped = await service.report("responses", { answerers: ["person:fixture/owner/admin"], limit: 20 })
    expect(scoped.items[0]).toMatchObject({ account, id: "admin", answered: 1 })
  })
  it("returns bounded question-answer evidence and rejects changed context on continuation", async () => {
    const { service, store } = await setup()
    await save(store, "room", [
      message("q2", "Another synthetic question?", 4),
      message("a2", "Another explicit answer", 5, "admin", "q2"),
    ])
    const found = await service.report("responses", { answerers: ["admin"], limit: 20 })
    const row = found.items[0]
    if (!row) throw Error("missing response row")
    const first = await service.evidence("contacts", row.id, row.drilldown.arguments.selection, {
      component: "report",
      limit: 1,
    })
    expect(first).toMatchObject({ total: 2, included: 1, hasMore: true })
    expect(first.items?.[0]).toMatchObject({
      message: { id: "a" },
      related: { id: "q" },
      contribution: 2 * 86_400_000,
    })
    expect(Buffer.byteLength(JSON.stringify(first.items))).toBeLessThanOrEqual(65536)
    const next = await service.evidence("contacts", row.id, JSON.stringify(row.drilldown.arguments.selection), {
      component: "report",
      limit: 1,
      cursor: first.nextCursor ?? "",
    })
    expect(next).toMatchObject({ included: 1, hasMore: false, nextCursor: null })
    await save(store, "room", [message("a2", "Edited synthetic response", 5, "admin", "q2")])
    await expect(
      service.evidence("contacts", row.id, row.drilldown.arguments.selection, {
        component: "report",
        limit: 1,
        cursor: first.nextCursor ?? "",
      }),
    ).rejects.toThrow("changed")
  })
  it("distinguishes a selected administrator response from another member reply and excludes future questions", async () => {
    const { service, store } = await setup()
    await save(store, "room", [
      message("other", "Synthetic other answer", 5, "helper", "wait"),
      message("future", "Synthetic future question?", 9),
    ])
    expect(
      (await service.report("unanswered", { answerers: ["admin"], olderThan: "1h", limit: 20 })).items,
    ).toHaveLength(1)
    expect((await service.report("unanswered", { olderThan: "1h", limit: 20 })).items).toHaveLength(0)
    expect((await service.report("unanswered", { limit: 20 })).summary.excludedFuture).toBe(1)
  })
  it("separates known joins and first observations and keeps newcomer windows bounded", async () => {
    const { store, service } = await setup()
    await store.roster.saveRoster(account, "room", {
      members: [
        { id: "member", name: "Synthetic member", username: null, role: "member", joinedAt: "2026-10-01T00:00:00Z" },
        { id: "unknown", name: "Synthetic unknown", username: null, role: "member" },
      ] as never,
      complete: false,
      participants: null,
    })
    const found = await service.report("newcomers", {
      chat: "room",
      sinceTime: "2026-10-01T00:00:00Z",
      within: "7d",
      limit: 20,
    })
    expect(found.summary.unknownJoin).toBe(1)
    expect(found.items).toHaveLength(1)
    expect(found.items[0]).toMatchObject({
      personId: "member",
      questions: 2,
      answered: 1,
      pending: false,
      status: "partial",
    })
    const row = found.items[0]
    if (!row) throw Error("missing newcomer")
    const evidence = await service.evidence("contacts", row.id, row.drilldown.arguments.selection, {
      component: "report",
      limit: 20,
    })
    expect(evidence.items).toHaveLength(2)
  })
  it("returns viewed posts without adding comment snapshots to stored discussion counts", async () => {
    const { store, service } = await setup()
    const post = {
      ...message("post", "Synthetic post", 1, "publisher", undefined, "channel"),
      providerMetadata: { views: 100, comments: 4, graph: { version: 1, reply: null, discussionChatId: "room" } },
    }
    await save(store, "channel", [
      post,
      { ...post, id: "unknown", providerMetadata: { graph: { version: 1, reply: null } } },
    ])
    const found = await service.report("discussion", { chat: "channel", minViews: 50, maxReplies: 0, limit: 20 })
    expect(found.summary.missingViews).toBe(1)
    expect(found.items[0]).toMatchObject({ views: 100, observedReplies: 0, commentSnapshot: 4, status: "partial" })
    const row = found.items[0]
    if (!row) throw Error("missing discussion")
    expect(
      (
        await service.evidence("messages", row.id, row.drilldown.arguments.selection, {
          component: "report",
          limit: 20,
        })
      ).items?.[0]?.message.id,
    ).toBe("post")
    await save(store, "room", [
      {
        ...message("copy", "Synthetic copy", 1, "publisher"),
        providerMetadata: {
          graph: { version: 1, reply: null, discussionSource: { chatId: "channel", messageId: "post" } },
        },
      },
      message("comment", "Synthetic discussion", 2, "reader", "copy"),
    ])
    expect((await service.report("discussion", { chat: "channel", maxReplies: 0, limit: 20 })).items).toHaveLength(0)
    expect(
      (await service.report("discussion", { chat: "channel", maxReplies: 1, limit: 20 })).items[0]?.observedReplies,
    ).toBe(1)
  })
  it("validates report options and evidence scope before store execution", async () => {
    const { service } = await setup()
    for (const input of [
      { limit: 0 },
      { limit: 101 },
      { limit: 1, olderThan: "bad" },
      { limit: 1, within: "0d" },
      { limit: 1, minViews: -1 },
      { limit: 1, syncFirst: {} },
      { limit: 1, sinceTime: "2026-10-08T00:00:00Z", untilTime: "2026-10-01T00:00:00Z" },
    ])
      await expect(service.report("unanswered", input)).rejects.toThrow()
    await expect(service.report("responses", { limit: 20 })).rejects.toThrow("answerer")
    await expect(service.report("newcomers", { limit: 20 })).rejects.toThrow("one stored chat")
    await expect(service.report("responses", { answerers: ["person:fixture/other/admin"], limit: 20 })).rejects.toThrow(
      "outside",
    )
    const found = await service.report("unanswered", { limit: 20 }),
      row = found.items[0]
    if (!row) throw Error("missing waiting")
    await expect(
      service.evidence("messages", "wrong", row.drilldown.arguments.selection, { component: "report", limit: 20 }),
    ).rejects.toThrow("reference")
    await expect(
      service.evidence("messages", row.id, row.drilldown.arguments.selection, { component: "answers", limit: 20 }),
    ).rejects.toThrow("component")
    await expect(
      service.evidence(
        "messages",
        row.id,
        { ...row.drilldown.arguments.selection, version: 2 },
        { component: "report", limit: 20 },
      ),
    ).rejects.toThrow("version")
    await expect(
      service.evidence("messages", row.id, row.drilldown.arguments.selection, {
        component: "report",
        limit: 20,
        cursor: "bad",
      }),
    ).rejects.toThrow("cursor")
  })
  it("repeats saved report scope and preserves typed overrides without storing bodies", async () => {
    const { service, store, deps } = await setup()
    const found = await service.report("unanswered", { chat: "room", answerers: ["admin"], olderThan: "1h", limit: 20 })
    const row = found.items[0]
    if (!row) throw Error("missing report row")
    const searches = searchesService(deps)
    const saved = await searches.create("waiting", { selection: row.drilldown.arguments.selection })
    expect(saved.command).toBe("admin-statistics")
    expect(JSON.stringify(saved.params)).not.toContain("Synthetic")
    const rerun = await service.report("unanswered", { saved: "waiting", limit: 20 })
    expect(rerun.items.map((one) => one.id)).toEqual(found.items.map((one) => one.id))
    expect((await service.report("unanswered", { saved: "waiting", olderThan: "30d", limit: 20 })).items).toHaveLength(
      0,
    )
    await expect(service.report("discussion", { saved: "waiting", limit: 20 })).rejects.toThrow("another report kind")
    await expect(service.report("unanswered", { saved: "missing", limit: 20 })).rejects.toThrow("not found")
    await expect(service.report("unanswered", { saved: "waiting", source: "fixture", limit: 20 })).rejects.toThrow(
      "resolved query",
    )
    const history = await store.searches.searchHistory(10)
    expect(history.every((one) => one.command === "admin-statistics")).toBe(true)
  })
  it("refuses oversized evidence bodies and supports cancellation", async () => {
    const { store, service } = await setup()
    await save(store, "room", [message("large", `Synthetic large question?${"x".repeat(70_000)}`, 2)])
    const found = await service.report("unanswered", { limit: 20 }),
      row = found.items.find((one) => one.id.endsWith("/large"))
    if (!row) throw Error("missing large")
    await expect(
      service.evidence("messages", row.id, row.drilldown.arguments.selection, { component: "report", limit: 20 }),
    ).rejects.toThrow("64 KiB")
    const abort = new AbortController()
    abort.abort()
    await expect(service.report("unanswered", { limit: 20, signal: abort.signal })).rejects.toThrow("aborted")
  })
})
