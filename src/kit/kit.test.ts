import { describe, expect, it } from "vitest"
import type { Chat } from "../domain/models.js"
import type { MessengerAdapter } from "../ports/messenger.js"
import {
  type ContractCase,
  contractCases,
  contractSeed,
  digitIds,
  type FakeAdapter,
  fakeAdapter,
  type Seed,
  wordIds,
} from "./index.js"

const runAll = (cases: ContractCase[]) => {
  for (const one of cases)
    it(one.name, async (context) => {
      const result = await one.run()
      if (result) context.skip(result.skipped)
    })
}

const failing = async (cases: ContractCase[], name: string) => {
  const found = cases.find((one) => one.name.startsWith(name))
  if (!found) throw new Error(`no case ${name}`)
  await expect(found.run()).rejects.toThrow()
}

describe("the fake adapter keeps every promise of the port", () => {
  describe("with word ids, paging by time", () => {
    runAll(contractCases({ connect: fakeAdapter, ids: wordIds, orderBy: "time" }))
  })
  describe("with whole-number ids, paging by id", () => {
    runAll(contractCases({ connect: fakeAdapter, ids: digitIds }))
  })
  describe("pushing its history", () => {
    runAll(contractCases({ connect: (seed) => fakeAdapter(seed, { feed: true }), ids: wordIds, orderBy: "time" }))
  })
})

describe("the contract cases catch an adapter that breaks a promise", () => {
  const broken = (change: (fake: FakeAdapter) => Partial<MessengerAdapter>) =>
    contractCases({
      orderBy: "time",
      waitMs: 20,
      connect: (seed: Seed) => {
        const fake = fakeAdapter(seed)
        return { ...fake, ...change(fake) }
      },
    })

  it("history newest first", async () => {
    const cases = broken((fake) => ({
      history: async (chat, window) => {
        const page = await fake.history(chat, window)
        return { ...page, items: page.items.toReversed() }
      },
    }))
    await failing(cases, "history answers the newest page")
  })

  it("a repeated send id sent twice", async () => {
    const cases = broken((fake) => ({
      send: (chat, text, options) =>
        fake.send(chat, text, { ...options, sendId: `${options.sendId}-${Math.random()}` }),
    }))
    await failing(cases, "a repeated send id")
    await failing(cases, "send answers the message sent")
  })

  it("an ambiguous title answered with one of the chats", async () => {
    const cases = broken((fake) => ({
      resolve: async (chat) => fake.resolve(chat === "Twins" ? (contractSeed().chats[2]?.id ?? chat) : chat),
    }))
    await failing(cases, "resolve refuses a title two chats share")
  })

  it("an id nobody has answered as another chat, but not taken as a chat of kind unknown", async () => {
    const unknown = (id: string): Chat => ({
      id,
      title: null,
      kind: "unknown",
      unreadCount: null,
      lastMessageAt: null,
      participantsCount: null,
    })
    const known = (fake: MessengerAdapter) => (chat: string) =>
      contractSeed().chats.some((one) => one.id === chat) ? fake.resolve(chat) : null
    const lenient = broken((fake) => ({ resolve: async (chat) => (await known(fake)(chat)) ?? unknown(chat) }))
    await expect(lenient.find((one) => one.name.startsWith("resolve refuses a chat"))?.run()).resolves.toBeUndefined()

    const wrong = broken((fake) => ({
      resolve: async (chat) => (await known(fake)(chat)) ?? fake.resolve("Book club"),
    }))
    await failing(wrong, "resolve refuses a chat")
  })

  it("a library error instead of a CliError", async () => {
    const cases = broken(() => ({
      history: async () => {
        throw new TypeError("Cannot read properties of undefined")
      },
    }))
    await failing(cases, "a read of a chat that does not exist")
  })

  it("an id as a number", async () => {
    const cases = broken((fake) => ({ me: async () => ({ ...(await fake.me()), id: 1 as unknown as string }) }))
    await failing(cases, "ids are strings")
  })

  it("a read that marks the chat read", async () => {
    const cases = broken((fake) => ({
      chat: async (chat) => {
        await fake.markRead?.(chat)
        return fake.chat(chat)
      },
    }))
    await failing(cases, "reads change nothing")
  })

  it("an optional method that is not a function", async () => {
    const cases = broken(() => ({ edit: "soon" as unknown as MessengerAdapter["edit"] }))
    await failing(cases, "capability()")
  })

  it("word ids while the store pages by id", async () => {
    await failing(contractCases({ connect: fakeAdapter }), "a messenger whose store pages by id")
  })

  it("a watch that never says it is listening", async () => {
    const cases = broken(() => ({
      watch: (_, signal) => new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve())),
    }))
    await expect(cases.find((one) => one.name.startsWith("watch"))?.run()).rejects.toThrow(/never called onReady/)
  })

  it("a feed that pushes a chat the seed does not have, or never ends", async () => {
    const stranger = broken(() => ({
      feed: async (onBatch) => {
        onBatch({ chats: [{ ...contractSeed().chats[0], id: "chat-elsewhere" } as Chat] })
      },
    }))
    await expect(stranger.find((one) => one.name.startsWith("feed"))?.run()).rejects.toThrow(/not in the seed/)
    const endless = broken(() => ({
      feed: (onBatch) => {
        onBatch({})
        return new Promise<void>(() => {})
      },
    }))
    await expect(endless.find((one) => one.name.startsWith("feed"))?.run()).rejects.toThrow(/did not end/)
  })

  it("skips the feed case for an adapter that does not push its history", async () => {
    expect(
      await contractCases({ connect: fakeAdapter })
        .find((one) => one.name.startsWith("feed"))
        ?.run(),
    ).toEqual({
      skipped: "the adapter has no feed",
    })
  })

  it("skips every server read case, together, for an adapter without them, and fails it unless its history is in the store", async () => {
    const without = () => ({ chats: undefined, history: undefined, around: undefined, contact: undefined })
    const serverCases = broken(without)
    expect(await serverCases.find((one) => one.name.startsWith("around answers"))?.run()).toEqual({
      skipped: "the adapter has no server reads (chats, history, around, contact)",
    })
    await expect(
      serverCases.find((one) => one.name.startsWith("a messenger whose history is on the server"))?.run(),
    ).rejects.toThrow(/history: "store"/)

    const storeCases = contractCases({
      history: "store",
      connect: (seed: Seed) => ({ ...fakeAdapter(seed), ...without() }),
    })
    expect(storeCases.some((one) => one.name.startsWith("a messenger whose history is on the server"))).toBe(false)
    for (const name of ["send answers", "ids are strings", "a read of a chat that does not exist"])
      expect(await storeCases.find((one) => one.name.startsWith(name))?.run()).toBeUndefined()
  })

  it("skips a case for an optional method the adapter lacks", async () => {
    const cases = broken(() => ({ historyAfter: undefined }))
    expect(await cases.find((one) => one.name.startsWith("historyAfter"))?.run()).toEqual({
      skipped: "the adapter has no historyAfter",
    })
  })
})

describe("the fake adapter's optional groups", () => {
  const seed = contractSeed()
  const busy = seed.messages.filter((message) => message.chatId === seed.busy)
  const own = busy.find((message) => message.outgoing) ?? busy[0]
  const other = busy.find((message) => !message.outgoing) ?? busy[0]
  if (!own || !other) throw new Error("the seed has no messages")

  it("edits only the owner's own message, forwards once per send id and deletes", async () => {
    const fake = fakeAdapter(seed)
    expect((await fake.edit(seed.busy, own.id, "fixed", {})).text).toBe("fixed")
    await expect(fake.edit(seed.busy, other.id, "no", {})).rejects.toMatchObject({ code: "permission_error" })
    const copy = await fake.forward(seed.busy, own.id, seed.dialog, { sendId: "1" })
    expect(await fake.forward(seed.busy, own.id, seed.dialog, { sendId: "1" })).toEqual(copy)
    expect(copy.forwardedFrom?.id).toBe(own.id)
    await fake.delete(seed.dialog, [copy.id], { forEveryone: false })
    await expect(fake.around(seed.dialog, copy.id, { before: 0, after: 0 })).rejects.toMatchObject({
      code: "not_found",
    })
  })

  it("pins, reacts, marks read and keeps a poll", async () => {
    const fake = fakeAdapter(seed)
    await fake.pin(seed.busy, own.id, { notify: false })
    await fake.unpin(seed.busy, own.id)
    await fake.react(seed.busy, own.id, "👍")
    expect((await fake.around(seed.busy, own.id, { before: 0, after: 0 }))[0]?.reactions?.mine).toBe("👍")
    await fake.react(seed.busy, own.id, null)
    await fake.markRead(seed.dialog)
    expect((await fake.resolve(seed.dialog)).unreadCount).toBe(0)

    const { message } = await fake.createPoll(
      seed.busy,
      { question: "When?", answers: ["Mon", "Tue"], multiple: false, anonymous: true },
      { sendId: "7" },
    )
    expect((await fake.vote(seed.busy, message.id, ["1"])).answers.map((answer) => answer.chosen)).toEqual([
      false,
      true,
    ])
    await expect(fake.vote(seed.busy, message.id, ["9"])).rejects.toMatchObject({ code: "validation_error" })
    expect((await fake.closePoll(seed.busy, message.id)).closed).toBe(true)
    expect((await fake.poll(seed.busy, message.id)).question).toBe("When?")
    await expect(fake.poll(seed.busy, own.id)).rejects.toMatchObject({ code: "not_found" })
  })

  it("tells a watcher of a message sent, queues one sent later, and hands over its files", async () => {
    const fake = fakeAdapter(seed)
    const controller = new AbortController()
    const seen: string[] = []
    const watching = fake.watch((event) => seen.push(event.event), controller.signal)
    await fake.send(seed.dialog, "now", {
      sendId: "1",
      attachments: [{ kind: "voice", name: "a.ogg", bytes: new Uint8Array(3) }],
    })
    await fake.send(seed.dialog, "later", { sendId: "2", at: "2030-01-01T00:00:00.000Z" })
    controller.abort()
    await watching
    expect(seen).toEqual(["message"])
    expect((await fake.scheduled(seed.dialog)).map((message) => message.text)).toEqual(["later"])

    const [sent] = (await fake.history(seed.dialog, { limit: 1 })).items
    const download = await fake.download(seed.dialog, sent?.id ?? "")
    expect(download.files.map((file) => file.name)).toEqual(["a.ogg"])
    for await (const _ of download.files[0]?.bytes() ?? []) throw new Error("the fake holds no bytes")
    expect(await fake.transcribe(seed.dialog, sent?.id ?? "")).toEqual({ text: "now", pending: false })
    await expect(fake.transcribe(seed.busy, own.id)).rejects.toMatchObject({ code: "validation_error" })
  })

  it("reads topics, links and pages of history", async () => {
    const fake = fakeAdapter(seed)
    expect(await fake.topics(seed.busy, { offset: 0 })).toEqual({ items: [], hasMore: false })
    await expect(fake.inspect("https://example.invalid/x")).rejects.toMatchObject({ code: "not_found" })
    await expect(fake.history(seed.busy, { limit: 1, before: "nope" })).rejects.toMatchObject({ code: "not_found" })
    const fromTime = await fake.history(seed.busy, { limit: 2, before: busy[2]?.timestamp ?? "" })
    expect(fromTime.items.map((message) => message.id)).toEqual(busy.slice(0, 2).map((message) => message.id))
  })

  it("runs a group: members, admins, settings, links, leaving", async () => {
    const fake = fakeAdapter(seed)
    const group = await fake.createGroup("Hikes", [seed.person], { channel: false })
    expect((await fake.members(group.id, { offset: 0 })).items.map((member) => member.id)).toEqual([
      seed.account?.id,
      seed.person,
    ])
    const [, , bob] = (await fake.members(seed.busy, { offset: 0 })).items
    await fake.addMembers(group.id, [bob?.id ?? ""], {})
    await fake.removeMembers(group.id, [seed.person])
    await fake.addAdmin(group.id, bob?.id ?? "", ["pin"])
    expect(await fake.admins(group.id)).toEqual([bob?.id])
    expect((await fake.members(group.id, { offset: 0, limit: 5 })).items.map((member) => member.role)).toEqual([
      "member",
      "admin",
    ])
    await fake.removeAdmin(group.id, bob?.id ?? "")
    expect(await fake.admins(group.id)).toEqual([])
    const updated = await fake.updateGroup(group.id, {
      title: "Walks",
      description: "Saturdays",
      settings: { allCanPin: true },
    })
    expect([updated.title, updated.description, updated.settings.allCanPin]).toEqual(["Walks", "Saturdays", true])
    expect((await fake.resetInviteLink(group.id)).link).toMatch(/^https:/)
    expect((await fake.group(group.id)).title).toBe("Walks")
    expect((await fake.chatEvents(group.id, { since: 0 })).events).toEqual([])
    expect(await fake.leave(group.id)).toEqual({ chatId: group.id })
    expect(await fake.people(["Ann Lee"])).toEqual([seed.person])
    await expect(fake.join("https://example.invalid/join/x")).rejects.toMatchObject({ code: "not_found" })
    const channel = await fake.createGroup("News", [], { channel: true })
    expect((await fake.chat(channel.id)).members).toBeNull()
  })

  it("keeps folders, contacts and the owner's profile", async () => {
    const fake = fakeAdapter(seed)
    const folder = await fake.createFolder("Work", [seed.busy])
    expect(
      (await fake.updateFolder(folder.id, { title: "Job", add: [seed.dialog], remove: [seed.busy] })).chatIds,
    ).toEqual([seed.dialog])
    expect((await fake.folders()).map((one) => one.title)).toEqual(["Job"])
    await fake.deleteFolder(folder.id)
    await expect(fake.deleteFolder(folder.id)).rejects.toMatchObject({ code: "not_found" })

    await fake.removeContact(seed.person)
    expect((await fake.addressBook()).map((person) => person.id)).not.toContain(seed.person)
    expect(
      (
        await fake.importContacts([
          { phone: "1", name: "Ann Lee" },
          { phone: "2", name: "Nobody" },
        ])
      ).length,
    ).toBe(1)
    await fake.addContact(seed.person)
    await fake.block(seed.person)
    await fake.unblock(seed.person)
    expect((await fake.renameContact(seed.person, "Annie", "L")).name).toBe("Annie L")
    await expect(fake.lookup("+100")).rejects.toMatchObject({ code: "not_found" })
    expect(await fake.sessions()).toHaveLength(1)
    expect(await fake.endOtherSessions()).toHaveLength(1)
    expect((await fake.updateProfile({ firstName: "New", lastName: "Name" })).name).toBe("New Name")
    await fake.logout()
    expect(fake.self()).toBeNull()
    await expect(fake.me()).rejects.toMatchObject({ code: "authentication_error" })
  })

  it("leaves the seed it was given as it was", async () => {
    const mine = contractSeed()
    const before = structuredClone(mine)
    const fake = fakeAdapter(mine)
    await fake.send(mine.dialog, "hi", { sendId: "1" })
    await fake.markRead(mine.dialog)
    expect(mine).toEqual(before)
  })
})
