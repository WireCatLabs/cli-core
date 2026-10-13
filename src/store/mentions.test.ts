import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { parseLucene } from "@wirecat/cli-base/query"
import { describe, expect, it } from "vitest"
import type { Message } from "../domain/models.js"
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
