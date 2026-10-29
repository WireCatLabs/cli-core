import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { parseLucene } from "@wirecat/cli-base/query"
import { describe, expect, it } from "vitest"
import type { Message } from "../domain/models.js"
import { searchStore } from "../services/messages-archive-search.js"
import { type AccountKey, MENTION_QUERY, openStore } from "./store.js"

const OWNER: AccountKey = { provider: "max", account: "1" }
const OTHER: AccountKey = { provider: "telegram", account: "2" }

const message = (id: string, text: string, sent = "2026-10-01T10:00:00.000Z"): Message => ({
  id,
  chatId: "-1",
  senderId: "7",
  senderName: "Ana",
  timestamp: sent,
  editedAt: null,
  text,
  outgoing: false,
  attachments: [],
  replyTo: null,
  forwardedFrom: null,
  reactions: null,
})

const fresh = async () => {
  const path = join(mkdtempSync(join(tmpdir(), "mentions-")), "messages.db")
  return { path, store: await openStore({ path, now: () => Date.parse("2026-10-13T20:00:00Z") }) }
}

const q = (text: string) => parseLucene(text, { ...MENTION_QUERY, defaultField: "value" })

const kinds = (items: { kind: string; value: string }[]) => items.map(({ kind, value }) => `${kind} ${value}`)

describe("mentions", () => {
  it("finds them as messages are written, again on an edit, and drops them with the message", async () => {
    const { store } = await fresh()
    await store.messages.saveMessages(OWNER, "-1", [message("1", "звони +7 900 000-00-01 или пиши ana@example.com")], {
      via: "history",
    })
    expect(kinds((await store.mentions.mentions(OWNER, undefined, { offset: 0 })).items)).toEqual([
      "phone +79000000001",
      "email ana@example.com",
    ])

    await store.messages.saveMessages(OWNER, "-1", [message("1", "теперь только https://example.org/a?utm_source=x")], {
      via: "update",
    })
    expect(kinds((await store.mentions.mentions(OWNER, undefined, { offset: 0 })).items)).toEqual([
      "url https://example.org/a",
    ])

    await store.messages.markDeleted(OWNER, ["1"], { chatId: "-1" })
    expect((await store.mentions.mentions(OWNER, undefined, { offset: 0 })).items).toEqual([])
    await store.close()
  })

  it("filters by kind, site and value, and pages", async () => {
    const { store } = await fresh()
    await store.messages.saveMessages(
      OWNER,
      "-1",
      [
        message("1", "https://docs.google.com/document/d/1SyntheticFileId_abc/edit", "2026-10-01T10:00:00.000Z"),
        message("2", "https://drive.google.com/file/d/2SyntheticFileId_xyz/view", "2026-10-02T10:00:00.000Z"),
        message("3", "https://example.com and 89000000001", "2026-10-03T10:00:00.000Z"),
      ],
      { via: "history" },
    )
    const site = await store.mentions.mentions(OWNER, q("kind:url domain:docs.google.com"), { offset: 0 })
    expect(site.items.map(({ messageId }) => messageId)).toEqual(["2", "1"])
    expect(kinds((await store.mentions.mentions(OWNER, q("kind:document"), { offset: 0 })).items)).toEqual([
      "document 2SyntheticFileId_xyz",
      "document 1SyntheticFileId_abc",
    ])
    expect((await store.mentions.mentions(OWNER, q("89000000001"), { offset: 0 })).items).toHaveLength(1)
    const first = await store.mentions.mentions(OWNER, undefined, { limit: 2, offset: 0 })
    expect(first.hasMore).toBe(true)
    expect(first.items).toHaveLength(2)
    await store.close()
  })

  it("reads only the bound account, and shows what was written around a mention", async () => {
    const { store } = await fresh()
    await store.messages.saveMessages(OWNER, "-1", [message("1", "Номер: 8 (900) 000-00-01, после обеда")], {
      via: "history",
    })
    await store.messages.saveMessages(OTHER, "-1", [message("1", "тот же 89000000001")], { via: "history" })
    const [mine] = (await store.mentions.mentions(OWNER, undefined, { offset: 0 })).items
    expect(mine?.written).toBe("8 (900) 000-00-01")
    expect(await store.mentions.mention(OTHER, mine?.id ?? 0)).toBeUndefined()
    expect(await store.mentions.mention(OWNER, mine?.id ?? 0)).toMatchObject({
      before: "Номер: ",
      after: ", после обеда",
      sameValue: 1,
    })
    await store.close()
  })

  it("rebuilds messages stored before mentions existed and keeps a decision", async () => {
    const { path, store } = await fresh()
    await store.messages.saveMessages(
      OWNER,
      "-1",
      [message("1", "ana@example.com"), message("2", "+7 900 000-00-01")],
      {
        via: "history",
      },
    )
    expect((await store.mentions.mentionsState()).rebuiltAt).toBeNull()
    await store.close()

    const raw = new DatabaseSync(path)
    raw.exec("UPDATE mentions SET status = 'dismissed', author = 'owner' WHERE kind = 'email'")
    raw.exec("DELETE FROM mentions WHERE kind = 'phone'")
    raw.close()

    const reopened = await openStore({ path, now: () => Date.parse("2026-10-13T21:00:00Z") })
    expect(await reopened.mentions.rebuildMentions()).toEqual({
      messages: 2,
      attachments: 0,
      documents: 0,
      notes: 0,
      emails: 0,
      mentions: 2,
    })
    const items = (await reopened.mentions.mentions(OWNER, undefined, { offset: 0 })).items
    expect(items.map(({ kind, status }) => `${kind} ${status}`).sort()).toEqual(["email dismissed", "phone found"])
    expect(await reopened.mentions.mentionsState()).toEqual({ pending: 0, rebuiltAt: "2026-10-13T21:00:00.000Z" })

    expect(await reopened.mentions.rebuildMentions({ kinds: ["phone"] })).toMatchObject({
      messages: 2,
      attachments: 0,
      mentions: 1,
    })
    expect((await reopened.mentions.mentions(OWNER, q("kind:email"), { offset: 0 })).items[0]?.status).toBe("dismissed")
    await reopened.close()
  })
})

describe("deciding a mention", () => {
  const status = async (store: Awaited<ReturnType<typeof openStore>>, value: string) =>
    (await store.mentions.mentions(OWNER, q(value), { offset: 0 })).items.map((one) => one.status)

  it("gives a phone an identity owned by a person, everywhere it is written and in later messages", async () => {
    const { store } = await fresh()
    await store.people.savePeople(OWNER, [{ id: "7", name: "Ana" }])
    const ana = await store.people.personOf({ provider: "max", id: "7" })
    await store.messages.saveMessages(
      OWNER,
      "-1",
      [message("1", "+7 900 000-00-01"), message("2", "или 89000000001")],
      {
        via: "history",
      },
    )
    const [one] = (await store.mentions.mentions(OWNER, q("kind:phone"), { offset: 0 })).items

    const decided = await store.mentions.confirmMention(OWNER, one?.id ?? 0, `person:${ana?.uid}`, { by: "owner" })

    expect(decided).toMatchObject({ kind: "phone", value: "+79000000001", status: "linked", mentions: 2 })
    expect(await status(store, "89000000001")).toEqual(["linked", "linked"])
    const owner = await store.people.personOf({ provider: "phone", id: "+79000000001" })
    expect(owner?.uid).toBe(ana?.uid)

    await store.messages.saveMessages(
      OWNER,
      "-1",
      [message("3", "тот же 8 900 000-00-01", "2026-10-02T10:00:00.000Z")],
      {
        via: "update",
      },
    )
    expect(await status(store, "89000000001")).toEqual(["linked", "linked", "linked"])
    await store.close()
  })

  it("keeps a confirmed owner and when it was found when phone_countries gives a bare number its country", async () => {
    const { path, store } = await fresh()
    await store.people.savePeople(OWNER, [{ id: "7", name: "Ana" }])
    const ana = await store.people.personOf({ provider: "max", id: "7" })
    await store.messages.saveMessages(OWNER, "-1", [message("1", "móvil 612 345 678")], { via: "history" })
    const [bare] = (await store.mentions.mentions(OWNER, q("kind:phone"), { offset: 0 })).items
    expect(bare?.value).toBe("612345678")
    await store.mentions.confirmMention(OWNER, bare?.id ?? 0, `person:${ana?.uid}`, { by: "owner" })

    const firstFound = () => {
      const raw = new DatabaseSync(path)
      const row = raw.prepare("SELECT created_at FROM mentions").get()
      raw.close()
      return row
    }
    const before = firstFound()
    const settings = new DatabaseSync(path)
    settings
      .prepare("INSERT INTO store_settings (key, value, at) VALUES ('phoneCountries', ?, ?)")
      .run(JSON.stringify(["es", "ru"]), Date.now())
    settings.close()
    await store.mentions.rebuildMentions({ kinds: ["phone"] })

    const [read] = (await store.mentions.mentions(OWNER, q("kind:phone"), { offset: 0 })).items
    expect(read).toMatchObject({ value: "+34612345678", status: "linked" })
    expect((await store.people.personOf({ provider: "phone", id: "+34612345678" }))?.uid).toBe(ana?.uid)
    expect(firstFound()).toEqual(before)
    const found = async (text: string) =>
      (await searchStore(store, OWNER, { text, limit: 10 })).items.map(({ id }) => id)
    expect(await found('phone:"612345678"')).toEqual(["1"])
    expect(await found('phone:"+34 612 34 56 78"')).toEqual(["1"])
    await store.close()
  })

  it("links a t.me link to the stored chat it names, by id or by username, and explains one it cannot", async () => {
    const { path, store } = await fresh()
    await store.messages.saveMessages(
      OWNER,
      "-1001234567890",
      [{ ...message("1", "пост https://t.me/c/1234567890/5"), chatId: "-1001234567890" }],
      {
        via: "history",
      },
    )
    await store.messages.saveMessages(OWNER, "-1", [message("2", "канал t.me/book_club и t.me/joinchat/AbCdEf")], {
      via: "history",
    })
    const raw = new DatabaseSync(path)
    raw.prepare("UPDATE chats SET username = 'Book_Club' WHERE external_id = '-1'").run()
    raw.close()
    await store.mentions.rebuildMentions({ kinds: ["url"] })

    const links = (await store.mentions.mentions(OWNER, q("kind:url"), { offset: 0 })).items
    const status = (value: string) => links.find((one) => one.value === value)
    expect(status("https://t.me/c/1234567890/5")).toMatchObject({ status: "linked", author: "rules" })
    expect(status("https://t.me/book_club")).toMatchObject({ status: "linked" })
    expect(status("https://t.me/book_club")?.target).toMatch(/^chat:/)
    const invite = status("https://t.me/joinchat/AbCdEf")
    expect(invite?.status).toBe("found")
    await expect(store.mentions.confirmMention(OWNER, invite?.id ?? 0, undefined, { by: "owner" })).rejects.toThrow(
      /t\.me/,
    )
    await store.close()
  })

  it("links an address that already is someone's identity without asking", async () => {
    const { path, store } = await fresh()
    await store.people.savePeople(OWNER, [{ id: "8", name: "Bo" }])
    await store.close()
    const raw = new DatabaseSync(path)
    const person = raw.prepare("SELECT person_id FROM identity_links").get()?.person_id
    raw
      .prepare("INSERT INTO identities (provider, external_id, created_at, updated_at) VALUES ('email', ?, 1, 1)")
      .run("bo@example.com")
    raw
      .prepare(
        "INSERT INTO identity_links (identity_id, person_id, method, confidence, created_at, author, updated_at) " +
          "SELECT id, ?, 'mail', 1, 1, 'owner', 1 FROM identities WHERE external_id = 'bo@example.com'",
      )
      .run(Number(person))
    raw.close()

    const reopened = await openStore({ path })
    await reopened.messages.saveMessages(OWNER, "-1", [message("1", "пиши Bo@Example.com")], { via: "history" })
    expect(await status(reopened, "kind:email")).toEqual(["linked"])
    await reopened.close()
  })

  it("dismisses a value everywhere and keeps it dismissed when it comes again", async () => {
    const { store } = await fresh()
    await store.messages.saveMessages(
      OWNER,
      "-1",
      [message("1", "https://example.com/a"), message("2", "https://example.com/a")],
      {
        via: "history",
      },
    )
    const [one] = (await store.mentions.mentions(OWNER, q("kind:url"), { offset: 0 })).items

    expect(await store.mentions.rejectMention(OWNER, one?.id ?? 0, { by: "claude-code" })).toMatchObject({
      status: "dismissed",
      mentions: 2,
    })
    await store.messages.saveMessages(
      OWNER,
      "-1",
      [message("3", "снова https://example.com/a", "2026-10-02T10:00:00.000Z")],
      {
        via: "update",
      },
    )
    expect(await status(store, "kind:url")).toEqual(["dismissed", "dismissed", "dismissed"])
    await store.close()
  })

  it("refuses a phone without a person, a link, and another account's mention", async () => {
    const { store } = await fresh()
    await store.messages.saveMessages(OWNER, "-1", [message("1", "+7 900 000-00-01 https://example.com")], {
      via: "history",
    })
    const [phone, link] = (await store.mentions.mentions(OWNER, undefined, { offset: 0 })).items.sort((a, b) =>
      a.kind.localeCompare(b.kind),
    )
    await expect(store.mentions.confirmMention(OWNER, phone?.id ?? 0, undefined, { by: "owner" })).rejects.toThrow(
      /person:<uid>/,
    )
    await expect(store.mentions.confirmMention(OWNER, link?.id ?? 0, undefined, { by: "owner" })).rejects.toThrow(
      /reject it/,
    )
    await expect(store.mentions.rejectMention(OTHER, phone?.id ?? 0, { by: "owner" })).rejects.toThrow(/no mention/)
    await store.close()
  })
})

describe("places", () => {
  it("finds an address in a message as an undecided place, its postcode and city in the span", async () => {
    const { store } = await fresh()
    await store.messages.saveMessages(OWNER, "-1", [message("1", "Жду на C/ Colón 5, 46004 Valencia")], {
      via: "history",
    })

    const [place] = (await store.mentions.mentions(OWNER, q("kind:place"), { offset: 0 })).items
    expect(place).toMatchObject({
      value: "calle colón 5, valencia",
      status: "found",
      written: "C/ Colón 5, 46004 Valencia",
    })
    expect((await store.mentions.mentions(OWNER, q("kind:phone"), { offset: 0 })).items).toEqual([])
    await store.close()
  })

  it("makes a confirmed address a place, links it everywhere, and links a later mention of it by rule", async () => {
    const { store } = await fresh()
    await store.messages.saveMessages(OWNER, "-1", [message("1", "офис: Calle Mayor, 12")], { via: "history" })
    const [first] = (await store.mentions.mentions(OWNER, q("kind:place"), { offset: 0 })).items
    await expect(store.mentions.confirmMention(OWNER, first?.id ?? 0, "person:1", { by: "owner" })).rejects.toThrow(
      /place of its own/,
    )

    expect(await store.mentions.confirmMention(OWNER, first?.id ?? 0, undefined, { by: "owner" })).toMatchObject({
      status: "linked",
      target: "place:1",
    })
    await store.messages.saveMessages(OWNER, "-1", [message("3", "встречаемся на Calle Mayor 12")], { via: "history" })
    const later = (await store.mentions.mentions(OWNER, q("kind:place"), { offset: 0 })).items.find(
      (one) => one.messageId === "3",
    )
    expect(later).toMatchObject({ status: "linked", target: "place:1", author: "rules" })
    expect(await store.mentions.places({ offset: 0 })).toEqual({
      items: [{ id: 1, address: "Calle Mayor, 12", mentions: 2 }],
      hasMore: false,
    })
    await store.close()
  })

  it("keeps a place confirmed before values carried the city, through a rebuild and in later mentions", async () => {
    const { path, store } = await fresh()
    await store.messages.saveMessages(OWNER, "-1", [message("1", "офис: Calle Mayor 12, Madrid")], { via: "history" })
    const raw = new DatabaseSync(path)
    raw.prepare("UPDATE mentions SET value = 'calle mayor 12' WHERE kind = 'place'").run()
    raw.close()
    const [old] = (await store.mentions.mentions(OWNER, q("kind:place"), { offset: 0 })).items
    await store.mentions.confirmMention(OWNER, old?.id ?? 0, undefined, { by: "owner" })

    await store.mentions.rebuildMentions({ kinds: ["place"] })
    await store.messages.saveMessages(OWNER, "-1", [message("2", "ждём на Calle Mayor 12, Madrid")], { via: "history" })
    await store.messages.saveMessages(OWNER, "-1", [message("3", "Calle Mayor 12, Valencia")], { via: "history" })
    const rows = (await store.mentions.mentions(OWNER, q("kind:place"), { offset: 0 })).items
    expect(rows.map(({ messageId, value, status, target }) => [messageId, value, status, target]).sort()).toEqual([
      ["1", "calle mayor 12, madrid", "linked", "place:1"],
      ["2", "calle mayor 12, madrid", "linked", "place:1"],
      ["3", "calle mayor 12, valencia", "found", null],
    ])
    await store.close()
  })
})

describe("mention fields in a message search", () => {
  const found = async (store: Awaited<ReturnType<typeof openStore>>, text: string) =>
    (await searchStore(store, OWNER, { text, limit: 100 })).items.map(({ id }) => id).sort()

  it("finds a phone written any way, an address, a link and a site; a dismissed value is not found", async () => {
    const { store } = await fresh()
    await store.messages.saveMessages(
      OWNER,
      "-1",
      [
        message("1", "звони +7 900 000-00-01"),
        message("2", "или 8 (900) 000-00-01, или ana@example.com"),
        message("3", "смета https://docs.google.com/document/d/1SyntheticFileId_abc/edit?utm_source=x"),
        message("4", "и https://example.com/a"),
      ],
      { via: "history" },
    )

    expect(await found(store, 'phone:"89000000001"')).toEqual(["1", "2"])
    expect(await found(store, 'email:"Ana@Example.com"')).toEqual(["2"])
    expect(await found(store, "domain:docs.google.com")).toEqual(["3"])
    expect(await found(store, 'url:"https://example.com/a#top"')).toEqual(["4"])
    expect(await found(store, 'phone:89000000001 -email:"ana@example.com"')).toEqual(["1"])

    const [link] = (await store.mentions.mentions(OWNER, q("kind:url domain:example.com"), { offset: 0 })).items
    await store.mentions.rejectMention(OWNER, link?.id ?? 0, { by: "owner" })
    expect(await found(store, "domain:example.com")).toEqual(["2"])
    expect(await found(store, 'url:"https://example.com/a"')).toEqual([])
    await store.close()
  })
})

describe("mentions in files and voice notes", () => {
  it("finds them in a file's text and a transcript, lists them with the message, and drops them with the text", async () => {
    const { store } = await fresh()
    await store.messages.saveMessages(
      OWNER,
      "-1",
      [
        { ...message("1", "смета во вложении"), attachments: [{ kind: "file", name: "a.pdf" }] },
        { ...message("2", "голосовое"), attachments: [{ kind: "voice" }] },
      ],
      { via: "history" },
    )
    const attached = await store.attachments.fileAttachments(OWNER, { limit: 10 })
    const file = attached.find((one) => one.messageId === "1")
    const voice = attached.find((one) => one.messageId === "2")
    await store.attachments.keepAttachmentText(file?.pk ?? 0, {
      text: "Подрядчик: ana@example.com",
      origin: "extracted",
      extractor: "plain",
    })
    await store.attachments.keepAttachmentText(voice?.pk ?? 0, {
      text: "перезвони на +7 900 000-00-01",
      origin: "extracted",
      extractor: "speech:whisper",
    })
    await store.messages.saveMessages(OWNER, "-1", [message("3", "ещё")], { via: "update" })

    const items = (await store.mentions.mentions(OWNER, undefined, { offset: 0 })).items
    expect(items.map(({ kind, field, messageId, written }) => [kind, field, messageId, written]).sort()).toEqual([
      ["email", "file_text", "1", "ana@example.com"],
      ["phone", "transcript", "2", "+7 900 000-00-01"],
    ])
    const found = async (text: string) =>
      (await searchStore(store, OWNER, { text, limit: 10 })).items.map(({ id }) => id)
    expect(await found('phone:"89000000001"')).toEqual(["2"])
    expect(await found('email:"ana@example.com"')).toEqual(["1"])

    expect(await store.mentions.rebuildMentions()).toMatchObject({ messages: 3, attachments: 2, mentions: 2 })
    await store.attachments.keepAttachmentText(file?.pk ?? 0, { text: "ничего", origin: "agent", extractor: "agent" })
    await store.messages.saveMessages(OWNER, "-1", [message("4", "ещё раз")], { via: "update" })
    expect((await store.mentions.mentions(OWNER, q("kind:email"), { offset: 0 })).items).toEqual([])
    await store.close()
  })
})

describe("a shared contact card's phone", () => {
  const card = { name: "Ana Ruiz", firstName: "Ana", lastName: "Ruiz", phone: "34600123456", userId: "42" }

  it("is a phone mention of field contact, found when the card is stored and again by a rebuild", async () => {
    const { store } = await fresh()
    await store.messages.saveMessages(
      OWNER,
      "-1",
      [{ ...message("1", ""), attachments: [{ kind: "contact", name: "Ana Ruiz", contact: card }] }],
      { via: "history" },
    )
    await store.messages.saveMessages(OWNER, "-1", [message("2", "ещё")], { via: "update" })

    const listed = async () =>
      (await store.mentions.mentions(OWNER, q("kind:phone"), { offset: 0 })).items.map(
        ({ kind, field, messageId, value }) => [kind, field, messageId, value],
      )
    expect(await listed()).toEqual([["phone", "contact", "1", "34600123456"]])
    expect(
      (await searchStore(store, OWNER, { text: 'phone:"34600123456"', limit: 10 })).items.map(({ id }) => id),
    ).toEqual(["1"])

    expect(await store.mentions.rebuildMentions()).toMatchObject({ attachments: 1, mentions: 1 })
    expect(await listed()).toEqual([["phone", "contact", "1", "34600123456"]])
    await store.close()
  })
})

describe("an organization's number", () => {
  it("is owned by the organization apart from any person, and later mentions of it are linked", async () => {
    const { path, store } = await fresh()
    const shop = await store.knowledge.addOrganization({ kind: "company", name: "Synthetic Shop" })
    await store.messages.saveMessages(OWNER, "-1", [message("1", "магазин: +7 900 000-00-02")], { via: "history" })
    const [phone] = (await store.mentions.mentions(OWNER, q("kind:phone"), { offset: 0 })).items

    expect(
      await store.mentions.confirmMention(OWNER, phone?.id ?? 0, `organization:${shop.id}`, { by: "owner" }),
    ).toMatchObject({
      status: "linked",
      target: expect.stringMatching(/^identity:/),
    })
    expect(await store.people.personOf({ provider: "phone", id: "+79000000002" })).toBeUndefined()
    await store.messages.saveMessages(OWNER, "-1", [message("2", "тот же 89000000002", "2026-10-02T10:00:00.000Z")], {
      via: "update",
    })
    expect(
      (await store.mentions.mentions(OWNER, q("89000000002"), { offset: 0 })).items.map((one) => one.status),
    ).toEqual(["linked", "linked"])
    await expect(
      store.mentions.confirmMention(OWNER, phone?.id ?? 0, "organization:999", { by: "owner" }),
    ).rejects.toThrow(/no organization/)
    await store.close()

    const raw = new DatabaseSync(path)
    expect(raw.prepare("SELECT method, author FROM organization_identities").all()).toEqual([
      { method: "mention", author: "owner" },
    ])
    raw.close()
  })
})

describe("known people's names", () => {
  const from = (id: string, sender: string, text: string, chatId = "-1"): Message => ({
    ...message(id, text),
    chatId,
    senderId: sender,
  })
  const named = async () => {
    const { path, store } = await fresh()
    await store.people.savePeople(OWNER, [
      { id: "7", name: "Arkady Belkin" },
      { id: "8", name: "Аркадий Смирнов" },
    ])
    const belkin = await store.people.personOf({ provider: "max", id: "7" })
    const smirnov = await store.people.personOf({ provider: "max", id: "8" })
    return { path, store, belkin: `person:${belkin?.uid}`, smirnov: `person:${smirnov?.uid}` }
  }
  const names = async (store: Awaited<ReturnType<typeof openStore>>) =>
    (await store.mentions.mentions(OWNER, q("kind:person-name"), { offset: 0 })).items
      .map(({ messageId, written, status, target }) => `${messageId} ${written} ${status} ${target}`)
      .sort()

  it("links a name by rule only to the one person it fits who wrote in that chat", async () => {
    const { store, belkin } = await named()
    await store.messages.saveMessages(OWNER, "-1", [from("1", "7", "Аркадий придёт, Смирнову передам")], {
      via: "history",
    })
    await store.messages.saveMessages(OWNER, "-2", [from("2", "9", "Белкину привет", "-2")], { via: "history" })

    expect(await names(store)).toEqual([`1 Аркадий linked ${belkin}`, "1 Смирнову found null", "2 Белкину found null"])
    const [smirnov] = (
      await store.mentions.mentions(OWNER, q("kind:person-name status:found"), { offset: 0 })
    ).items.filter((one) => one.messageId === "1")
    expect((await store.mentions.mention(OWNER, smirnov?.id ?? 0))?.candidates).toHaveLength(1)
    await store.close()
  })

  it("decides a name where it is written, keeps the decision on a rebuild, and finds the person's messages", async () => {
    const { store, smirnov } = await named()
    await store.messages.saveMessages(
      OWNER,
      "-2",
      [from("1", "9", "Смирнов звонил", "-2"), from("2", "9", "Смирнов это фирма", "-2")],
      { via: "history" },
    )
    const [call, firm] = (await store.mentions.mentions(OWNER, q("kind:person-name"), { offset: 0 })).items.sort(
      (a, b) => a.messageId.localeCompare(b.messageId),
    )

    expect(await store.mentions.confirmMention(OWNER, call?.id ?? 0, smirnov, { by: "owner" })).toMatchObject({
      mentions: 1,
    })
    expect(await store.mentions.rejectMention(OWNER, firm?.id ?? 0, { by: "owner" })).toMatchObject({ mentions: 1 })
    await store.mentions.rebuildMentions({ kinds: ["person-name"] })
    expect(await names(store)).toEqual([`1 Смирнов linked ${smirnov}`, "2 Смирнов dismissed null"])

    const found = await searchStore(store, OWNER, { text: `mentions:"${smirnov}"`, limit: 10 })
    expect(found.items.map(({ id }) => id)).toEqual(["1"])
    const [dismissed] = (await store.mentions.mentions(OWNER, q("kind:person-name status:dismissed"), { offset: 0 }))
      .items
    await expect(store.mentions.confirmMention(OWNER, dismissed?.id ?? 0, undefined, { by: "owner" })).rejects.toThrow(
      /person:<uid>/,
    )
    await store.close()
  })

  it("keeps a known name in its place and finds an unknown one beside it, undecided", async () => {
    const { store, belkin } = await named()
    await store.messages.saveMessages(OWNER, "-1", [from("1", "7", "Аркадий и Ольга Петровна придут")], {
      via: "history",
    })

    expect(await names(store)).toEqual([`1 Аркадий linked ${belkin}`, "1 Ольга Петровна found null"])
    await store.close()
  })

  it("takes an account's own identity for the owner, so the owner's name is nobody's in a text", async () => {
    const { store, belkin } = await named()
    await store.people.savePeople(OWNER, [{ id: "1", name: "Viacheslav Ptsarev" }])
    const stray = await store.people.personOf({ provider: "max", id: "1" })
    await store.accounts.saveAccount(OWNER, { name: null })
    const owner = await store.people.personOf({ provider: "max", id: "1" })
    expect(owner?.uid).not.toBe(stray?.uid)
    await store.accounts.saveAccount(OWNER, { name: null })
    expect((await store.people.personOf({ provider: "max", id: "1" }))?.uid).toBe(owner?.uid)

    await store.people.savePeople(OTHER, [{ id: "5", name: "Viacheslav" }])
    const linked = await store.people.linkToOwner({ provider: "telegram", id: "5" })
    expect(linked.uid).toBe(owner?.uid)
    await store.messages.saveMessages(OWNER, "-1", [from("1", "7", "Ptsarev и Белкин придут")], { via: "history" })
    expect(await names(store)).toEqual([`1 Белкин linked ${belkin}`])
    await store.close()
  })

  it("finds a person by the owner's own name for their contact", async () => {
    const { store, belkin } = await named()
    await store.people.setContactAlias(OWNER, "7", "Кузнечик")
    await store.messages.saveMessages(OWNER, "-1", [from("1", "7", "Кузнечику привет")], { via: "history" })

    expect(await names(store)).toEqual([`1 Кузнечику linked ${belkin}`])
    await store.close()
  })

  it("decides a name in every undecided place of its chat with --all-in-chat, and nowhere else", async () => {
    const { store, smirnov } = await named()
    await store.messages.saveMessages(
      OWNER,
      "-2",
      [
        from("1", "9", "Смирнов звонил", "-2"),
        from("2", "9", "Смирнов это фирма", "-2"),
        from("3", "9", "Смирнов придёт", "-2"),
      ],
      { via: "history" },
    )
    await store.messages.saveMessages(OWNER, "-3", [from("4", "9", "Смирнов тут", "-3")], { via: "history" })
    const byMessage = async () =>
      Object.fromEntries(
        (await store.mentions.mentions(OWNER, q("kind:person-name"), { offset: 0 })).items.map((one) => [
          one.messageId,
          one,
        ]),
      )
    const before = await byMessage()
    await store.mentions.rejectMention(OWNER, before["2"]?.id ?? 0, { by: "owner" })

    expect(
      await store.mentions.confirmMention(OWNER, before["1"]?.id ?? 0, smirnov, { by: "owner", inChat: true }),
    ).toMatchObject({
      mentions: 2,
    })
    const after = await byMessage()
    expect([after["1"]?.status, after["2"]?.status, after["3"]?.status, after["4"]?.status]).toEqual([
      "linked",
      "dismissed",
      "linked",
      "found",
    ])
    await store.close()
  })

  it("leaves the kinds a later build finds when it reads a text again", async () => {
    const { path, store } = await fresh()
    await store.messages.saveMessages(OWNER, "-1", [message("1", "+7 900 000-00-01")], { via: "history" })
    await store.close()
    const raw = new DatabaseSync(path)
    raw
      .prepare(
        "INSERT INTO mentions (kind, source_type, source_id, source_field, start_offset, end_offset, value, method, " +
          "version, confidence, status, created_at, updated_at) SELECT 'vehicle', 'message', id, 'text', 0, 2, 'x', " +
          "'rules', 1, 0.5, 'found', 1, 1 FROM messages",
      )
      .run()
    raw.close()

    const reopened = await openStore({ path })
    await reopened.mentions.rebuildMentions()
    const raw2 = new DatabaseSync(path)
    expect(raw2.prepare("SELECT kind FROM mentions ORDER BY kind").all()).toEqual([
      { kind: "phone" },
      { kind: "vehicle" },
    ])
    raw2.close()
    await reopened.close()
  })
})

describe("mentions outside a chat", () => {
  const by = { by: "owner" }
  const MAIL = [{ provider: "email", account: "a@example.com" }]

  const seeded = async () => {
    const { path, store } = await fresh()
    await store.messages.saveMessages(OWNER, "-1", [message("1", "her number +7 900 000-00-01")], { via: "history" })
    const raw = new DatabaseSync(path)
    raw.exec(`INSERT INTO accounts (id, provider, external_id, created_at, updated_at) VALUES
        (90, 'email', 'a@example.com', 1, 1), (91, 'email', 'b@example.com', 1, 1);
      INSERT INTO email_threads (id, account_id, external_id, created_at, updated_at) VALUES (1, 90, 't1', 1, 1),
        (2, 91, 't2', 1, 1);
      INSERT INTO persons (id, name, created_at, updated_at) VALUES (40, 'Olga', 1, 1), (41, 'Ivan', 1, 1);
      INSERT INTO identities (id, provider, external_id, created_at, updated_at) VALUES
        (40, 'email', 'olga@example.org', 1, 1), (41, 'email', 'ivan@example.org', 1, 1);
      INSERT INTO identity_links (identity_id, person_id, method, confidence, author, created_at, updated_at) VALUES
        (40, 40, 'test', 1, 'rules', 1, 1), (41, 41, 'test', 1, 'rules', 1, 1);
      INSERT INTO emails (id, account_id, email_thread_id, external_id, subject, from_identity_id, from_address, sent_at,
        body_text, created_at, updated_at) VALUES
        (1, 90, 1, 'e1', 'Invoice', 40, 'olga@example.org', 100, 'Olga, tel +7 900 000-00-01', 1, 1),
        (2, 90, 1, 'e2', 'Again', 40, 'olga@example.org', 200, 'Olga, tel +7 900 000-00-01', 1, 1),
        (3, 90, 1, 'e3', 'Fwd', 41, 'ivan@example.org', 300, 'see +7 900 000-00-01', 1, 1),
        (4, 91, 2, 'e4', 'Other box', 41, 'ivan@example.org', 400, 'call +7 900 000-00-09', 1, 1);
      INSERT INTO documents (id, account_id, external_id, kind, title, body, created_at, updated_at)
        VALUES (5, 90, 'd1', 'file', 'Price list', 'see https://example.org/a', 1, 1);
      INSERT INTO notes (id, notable_type, notable_id, title, body, created_at, updated_at)
        VALUES (6, 'person', 40, 'Olga', 'ana@example.com', 1, 1);`)
    raw.close()
    await store.mentions.rebuildMentions()
    return store
  }

  it("lists each kind of text with what names it, and mail only of the named accounts", async () => {
    const store = await seeded()
    const listed = async (source: "document" | "note" | "email", mail = MAIL) =>
      (await store.sourceMentions.list(source, undefined, { offset: 0 }, mail)).items.map(
        ({ kind, value, source: s }) => `${kind} ${value} ${s.title} ${s.from}`,
      )
    expect(await listed("document")).toEqual(["url https://example.org/a Price list null"])
    expect(await listed("note")).toEqual(["email ana@example.com Olga null"])
    expect(await listed("email")).toEqual([
      "phone +79000000001 Fwd ivan@example.org",
      "phone +79000000001 Again olga@example.org",
      "phone +79000000001 Invoice olga@example.org",
    ])
    expect(await listed("email", [])).toEqual([])
    const messenger = (await store.mentions.mentions(OWNER, undefined, { offset: 0 })).items
    expect(messenger.map(({ messageId, written }) => `${messageId} ${written}`)).toEqual(["1 +7 900 000-00-01"])
    const page = await store.sourceMentions.list("email", q("kind:phone"), { offset: 0, limit: 1 }, MAIL)
    expect(page.hasMore).toBe(true)
  })

  it("offers the people whose mail carries a number, most letters first, in mail and in a message", async () => {
    const store = await seeded()
    const [mail] = (await store.sourceMentions.list("email", undefined, { offset: 0 }, MAIL)).items
    const shown = await store.sourceMentions.show(Number(mail?.id), MAIL)
    expect(shown).toMatchObject({ written: "+7 900 000-00-01", sameValue: 3, candidates: ["person:40", "person:41"] })
    expect(await store.sourceMentions.show(Number(mail?.id), [])).toBeUndefined()
    const [inChat] = (await store.mentions.mentions(OWNER, q("kind:phone"), { offset: 0 })).items
    expect((await store.mentions.mention(OWNER, Number(inChat?.id)))?.candidates).toEqual(["person:40", "person:41"])
  })

  it("decides a value found in mail everywhere, and refuses a chat-wide decision outside a chat", async () => {
    const store = await seeded()
    const [mail] = (await store.sourceMentions.list("email", undefined, { offset: 0 }, MAIL)).items
    expect(await store.sourceMentions.confirm(Number(mail?.id), "person:40", by, MAIL)).toMatchObject({
      status: "linked",
      mentions: 4,
    })
    const [inChat] = (await store.mentions.mentions(OWNER, q("kind:phone"), { offset: 0 })).items
    expect(inChat?.status).toBe("linked")
    const [note] = (await store.sourceMentions.list("note", undefined, { offset: 0 }, [])).items
    await expect(store.sourceMentions.reject(Number(note?.id), { by: "owner", inChat: true }, [])).rejects.toThrow(
      /not in a chat/,
    )
    expect(await store.sourceMentions.reject(Number(note?.id), by, [])).toMatchObject({ status: "dismissed" })
    await expect(store.sourceMentions.reject(Number(inChat?.id), by, MAIL)).rejects.toThrow(/no mention/)
  })
})

describe("links in mail", () => {
  it("keeps a tracking link once per letter and site, and a message's link whole", async () => {
    const { path, store } = await fresh()
    await store.messages.saveMessages(OWNER, "-1", [message("1", "https://news.example.com/click?id=1")], {
      via: "history",
    })
    const raw = new DatabaseSync(path)
    raw.exec(`INSERT INTO accounts (id, provider, external_id, created_at, updated_at) VALUES (90, 'email', 'a@x.org', 1, 1);
      INSERT INTO email_threads (id, account_id, external_id, created_at, updated_at) VALUES (1, 90, 't1', 1, 1);
      INSERT INTO emails (id, account_id, email_thread_id, external_id, body_text, created_at, updated_at) VALUES
        (1, 90, 1, 'e1', 'https://news.example.com/click?id=1 https://news.example.com/click?id=2 https://example.org/a', 1, 1);`)
    raw.close()
    await store.mentions.rebuildMentions({ kinds: ["url"] })
    const mail = await store.sourceMentions.list("email", undefined, { offset: 0 }, [
      { provider: "email", account: "a@x.org" },
    ])
    expect(mail.items.map(({ value, written }) => `${value} ${written}`)).toEqual([
      "https://news.example.com https://news.example.com/click?id=1",
      "https://example.org/a https://example.org/a",
    ])
    expect((await store.mentions.mentions(OWNER, undefined, { offset: 0 })).items.map(({ value }) => value)).toEqual([
      "https://news.example.com/click?id=1",
    ])
  })

  it("finds a letter by its whole tracking link, by a part of a link and by site", async () => {
    const { path, store } = await fresh()
    const raw = new DatabaseSync(path)
    raw.exec(`INSERT INTO accounts (id, provider, external_id, created_at, updated_at) VALUES (90, 'email', 'a@x.org', 1, 1);
      INSERT INTO email_threads (id, account_id, external_id, created_at, updated_at) VALUES (1, 90, 't1', 1, 1);
      INSERT INTO emails (id, account_id, email_thread_id, external_id, body_text, created_at, updated_at) VALUES
        (1, 90, 1, 'e1', 'read https://news.example.com/click?id=1&utm_source=mail', 1, 1),
        (2, 90, 1, 'e2', 'read https://news.example.com/click?id=2 or https://example.org/Price/list', 1, 1),
        (3, 90, 1, 'e3', 'no link here, id=1', 1, 1);`)
    raw.close()
    await store.mentions.rebuildMentions({ kinds: ["url"] })
    const found = async (field: string, value: string) =>
      (
        await store.queries.matchQuery({
          root: { kind: "predicate", field, operator: "phrase", value, span: { start: 0, end: 1 } } as never,
          accounts: [{ provider: "email", account: "a@x.org" }],
          limit: 10,
          corpus: "mail",
        })
      ).items
        .map(({ id }) => id)
        .sort()

    expect(await found("url", "https://news.example.com/click?id=1")).toEqual(["e1"])
    expect(await found("url", "https://news.example.com/click?id=1&utm_source=mail")).toEqual(["e1"])
    expect(await found("url", "https://news.example.com")).toEqual(["e1", "e2"])
    expect(await found("url", "https://example.org/Price/list")).toEqual(["e2"])
    expect(await found("link", "click?id=2")).toEqual(["e2"])
    expect(await found("link", "price/LIST")).toEqual(["e2"])
    expect(await found("link", "/click")).toEqual(["e1", "e2"])
    expect(await found("link", "id=1")).toEqual(["e1"])
    expect(await found("domain", "example.com")).toEqual(["e1", "e2"])
    await store.close()
  })

  it("finds a message by a part of its link", async () => {
    const { store } = await fresh()
    await store.messages.saveMessages(
      OWNER,
      "-1",
      [
        message("1", "https://news.example.com/click?id=1"),
        message("2", "https://example.org/a"),
        message("3", "https://example.org/a_b and https://example.org/axb"),
      ],
      { via: "history" },
    )
    const found = async (text: string) =>
      (await searchStore(store, OWNER, { text, limit: 10 })).items.map(({ id }) => id).sort()

    expect(await found('link:"click?id=1"')).toEqual(["1"])
    expect(await found("link:example")).toEqual(["1", "2", "3"])
    expect(await found('link:"a_b"')).toEqual(["3"])
    expect(await found('link:"x_b"')).toEqual([])
    expect(await found("link:nothing")).toEqual([])
    await store.close()
  })
})
