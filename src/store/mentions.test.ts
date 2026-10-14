import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { parseLucene } from "@wirecat/cli-base/query"
import { describe, expect, it } from "vitest"
import type { Message } from "../domain/models.js"
import { searchStore } from "../services/messages.js"
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
    await store.saveMessages(OWNER, "-1", [message("1", "звони +7 900 000-00-01 или пиши ana@example.com")], {
      via: "history",
    })
    expect(kinds((await store.mentions(OWNER, undefined, { offset: 0 })).items)).toEqual([
      "phone +79000000001",
      "email ana@example.com",
    ])

    await store.saveMessages(OWNER, "-1", [message("1", "теперь только https://example.org/a?utm_source=x")], {
      via: "update",
    })
    expect(kinds((await store.mentions(OWNER, undefined, { offset: 0 })).items)).toEqual(["url https://example.org/a"])

    await store.markDeleted(OWNER, ["1"], { chatId: "-1" })
    expect((await store.mentions(OWNER, undefined, { offset: 0 })).items).toEqual([])
    await store.close()
  })

  it("filters by kind, site and value, and pages", async () => {
    const { store } = await fresh()
    await store.saveMessages(
      OWNER,
      "-1",
      [
        message("1", "https://docs.google.com/document/d/1SyntheticFileId_abc/edit", "2026-10-01T10:00:00.000Z"),
        message("2", "https://drive.google.com/file/d/2SyntheticFileId_xyz/view", "2026-10-02T10:00:00.000Z"),
        message("3", "https://example.com and 89000000001", "2026-10-03T10:00:00.000Z"),
      ],
      { via: "history" },
    )
    const site = await store.mentions(OWNER, q("kind:url domain:docs.google.com"), { offset: 0 })
    expect(site.items.map(({ messageId }) => messageId)).toEqual(["2", "1"])
    expect(kinds((await store.mentions(OWNER, q("kind:document"), { offset: 0 })).items)).toEqual([
      "document 2SyntheticFileId_xyz",
      "document 1SyntheticFileId_abc",
    ])
    expect((await store.mentions(OWNER, q("89000000001"), { offset: 0 })).items).toHaveLength(1)
    const first = await store.mentions(OWNER, undefined, { limit: 2, offset: 0 })
    expect(first.hasMore).toBe(true)
    expect(first.items).toHaveLength(2)
    await store.close()
  })

  it("reads only the bound account, and shows what was written around a mention", async () => {
    const { store } = await fresh()
    await store.saveMessages(OWNER, "-1", [message("1", "Ольга: 8 (900) 000-00-01, после обеда")], { via: "history" })
    await store.saveMessages(OTHER, "-1", [message("1", "тот же 89000000001")], { via: "history" })
    const [mine] = (await store.mentions(OWNER, undefined, { offset: 0 })).items
    expect(mine?.written).toBe("8 (900) 000-00-01")
    expect(await store.mention(OTHER, mine?.id ?? 0)).toBeUndefined()
    expect(await store.mention(OWNER, mine?.id ?? 0)).toMatchObject({
      before: "Ольга: ",
      after: ", после обеда",
      sameValue: 1,
    })
    await store.close()
  })

  it("rebuilds messages stored before mentions existed and keeps a decision", async () => {
    const { path, store } = await fresh()
    await store.saveMessages(OWNER, "-1", [message("1", "ana@example.com"), message("2", "+7 900 000-00-01")], {
      via: "history",
    })
    expect((await store.mentionsState()).rebuiltAt).toBeNull()
    await store.close()

    const raw = new DatabaseSync(path)
    raw.exec("UPDATE mentions SET status = 'dismissed', author = 'owner' WHERE kind = 'email'")
    raw.exec("DELETE FROM mentions WHERE kind = 'phone'")
    raw.close()

    const reopened = await openStore({ path, now: () => Date.parse("2026-10-13T21:00:00Z") })
    expect(await reopened.rebuildMentions()).toEqual({ messages: 2, mentions: 2 })
    const items = (await reopened.mentions(OWNER, undefined, { offset: 0 })).items
    expect(items.map(({ kind, status }) => `${kind} ${status}`).sort()).toEqual(["email dismissed", "phone found"])
    expect(await reopened.mentionsState()).toEqual({ pending: 0, rebuiltAt: "2026-10-13T21:00:00.000Z" })

    expect(await reopened.rebuildMentions({ kinds: ["phone"] })).toEqual({ messages: 2, mentions: 1 })
    expect((await reopened.mentions(OWNER, q("kind:email"), { offset: 0 })).items[0]?.status).toBe("dismissed")
    await reopened.close()
  })
})

describe("deciding a mention", () => {
  const status = async (store: Awaited<ReturnType<typeof openStore>>, value: string) =>
    (await store.mentions(OWNER, q(value), { offset: 0 })).items.map((one) => one.status)

  it("gives a phone an identity owned by a person, everywhere it is written and in later messages", async () => {
    const { store } = await fresh()
    await store.savePeople(OWNER, [{ id: "7", name: "Ana" }])
    const ana = await store.personOf({ provider: "max", id: "7" })
    await store.saveMessages(OWNER, "-1", [message("1", "+7 900 000-00-01"), message("2", "или 89000000001")], {
      via: "history",
    })
    const [one] = (await store.mentions(OWNER, q("kind:phone"), { offset: 0 })).items

    const decided = await store.confirmMention(OWNER, one?.id ?? 0, ana?.uid, "owner")

    expect(decided).toMatchObject({ kind: "phone", value: "+79000000001", status: "linked", mentions: 2 })
    expect(await status(store, "89000000001")).toEqual(["linked", "linked"])
    const owner = await store.personOf({ provider: "phone", id: "+79000000001" })
    expect(owner?.uid).toBe(ana?.uid)

    await store.saveMessages(OWNER, "-1", [message("3", "тот же 8 900 000-00-01", "2026-10-02T10:00:00.000Z")], {
      via: "update",
    })
    expect(await status(store, "89000000001")).toEqual(["linked", "linked", "linked"])
    await store.close()
  })

  it("links an address that already is someone's identity without asking", async () => {
    const { path, store } = await fresh()
    await store.savePeople(OWNER, [{ id: "8", name: "Bo" }])
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
    await reopened.saveMessages(OWNER, "-1", [message("1", "пиши Bo@Example.com")], { via: "history" })
    expect(await status(reopened, "kind:email")).toEqual(["linked"])
    await reopened.close()
  })

  it("dismisses a value everywhere and keeps it dismissed when it comes again", async () => {
    const { store } = await fresh()
    await store.saveMessages(
      OWNER,
      "-1",
      [message("1", "https://example.com/a"), message("2", "https://example.com/a")],
      {
        via: "history",
      },
    )
    const [one] = (await store.mentions(OWNER, q("kind:url"), { offset: 0 })).items

    expect(await store.rejectMention(OWNER, one?.id ?? 0, "claude-code")).toMatchObject({
      status: "dismissed",
      mentions: 2,
    })
    await store.saveMessages(OWNER, "-1", [message("3", "снова https://example.com/a", "2026-10-02T10:00:00.000Z")], {
      via: "update",
    })
    expect(await status(store, "kind:url")).toEqual(["dismissed", "dismissed", "dismissed"])
    await store.close()
  })

  it("refuses a phone without a person, a link, and another account's mention", async () => {
    const { store } = await fresh()
    await store.saveMessages(OWNER, "-1", [message("1", "+7 900 000-00-01 https://example.com")], { via: "history" })
    const [phone, link] = (await store.mentions(OWNER, undefined, { offset: 0 })).items.sort((a, b) =>
      a.kind.localeCompare(b.kind),
    )
    await expect(store.confirmMention(OWNER, phone?.id ?? 0, undefined, "owner")).rejects.toThrow(/person:<uid>/)
    await expect(store.confirmMention(OWNER, link?.id ?? 0, undefined, "owner")).rejects.toThrow(/reject it/)
    await expect(store.rejectMention(OTHER, phone?.id ?? 0, "owner")).rejects.toThrow(/no mention/)
    await store.close()
  })
})

describe("mention fields in a message search", () => {
  const found = async (store: Awaited<ReturnType<typeof openStore>>, text: string) =>
    (await searchStore(store, OWNER, { text, language: "lucene", limit: 100 })).items.map(({ id }) => id).sort()

  it("finds a phone written any way, an address, a link and a site; a dismissed value is not found", async () => {
    const { store } = await fresh()
    await store.saveMessages(
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

    const [link] = (await store.mentions(OWNER, q("kind:url domain:example.com"), { offset: 0 })).items
    await store.rejectMention(OWNER, link?.id ?? 0, "owner")
    expect(await found(store, "domain:example.com")).toEqual(["2"])
    expect(await found(store, 'url:"https://example.com/a"')).toEqual([])
    await store.close()
  })
})
