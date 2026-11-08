import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { Message } from "../domain/models.js"
import { withoutBotTokens } from "./sqlite/bot-tokens.js"
import { openSqlite } from "./sqlite/open.js"
import { type AccountKey, type MessageStore, openStore } from "./store.js"

// Built at run time, so no secret scanner takes the file for a leak.
const SECRET = "AAtestOnly".padEnd(35, "x")
const TOKEN = `123456789:${SECRET}`
const HIDDEN = "123456789:<bot token hidden>"
const OWNER: AccountKey = { provider: "telegram", account: "100" }
const at = (minute: number) => new Date(Date.UTC(2026, 10, 8, 10, minute)).toISOString()

const stores: MessageStore[] = []
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close()
})

const opened = async (path = join(mkdtempSync(join(tmpdir(), "bot-tokens-")), "wirecat.db")) => {
  const store = await openStore({ path })
  stores.push(store)
  return { store, path }
}

const message = (id: string, chatId: string, fields: Partial<Message> = {}): Message => ({
  id,
  chatId,
  senderId: "93372553",
  senderName: "BotFather",
  timestamp: at(Number(id)),
  editedAt: null,
  text: `message ${id}`,
  outgoing: false,
  attachments: [],
  replyTo: null,
  forwardedFrom: null,
  reactions: null,
  ...fields,
})

const saveChat = (store: MessageStore, id: string, fields: { searchable?: false } = {}) =>
  store.chats.saveChats(OWNER, [
    { id, kind: "dialog", title: id, unreadCount: 0, lastMessageAt: null, participantsCount: null, ...fields },
  ])

const textOf = async (store: MessageStore, chatId: string, id: string) =>
  (await store.messages.message(OWNER, id, { chatId }))?.text

describe("bot tokens in messages", () => {
  it("keep the bot's id and lose the secret, in an API link too, and leave other numbers alone", () => {
    expect(withoutBotTokens(`Use this token: ${TOKEN} to access`)).toBe(`Use this token: ${HIDDEN} to access`)
    expect(withoutBotTokens(`https://api.telegram.org/bot${TOKEN}/getMe`)).toBe(
      `https://api.telegram.org/bot${HIDDEN}/getMe`,
    )
    expect(withoutBotTokens("at 10:30, order 12345678:short")).toBe("at 10:30, order 12345678:short")
  })

  it("are masked in a saved text, a caption, a quote and an edit, and search for the secret finds nothing", async () => {
    const { store } = await opened()
    await saveChat(store, "93372553")
    const quoted = { id: "1", senderId: null, senderName: null, timestamp: null, attachments: [], outgoing: null }
    await store.messages.saveMessages(
      OWNER,
      "93372553",
      [
        message("1", "93372553", { text: `Done! Use this token to access the HTTP API: ${TOKEN}` }),
        message("2", "93372553", {
          text: `token ${TOKEN}`,
          attachments: [{ kind: "photo", mime: "image/jpeg" }],
        }),
        message("3", "93372553", { replyTo: { ...quoted, text: TOKEN }, replyToId: "1" }),
        message("4", "93372553"),
      ],
      { via: "sync" },
    )
    await store.messages.saveMessages(
      OWNER,
      "93372553",
      [message("4", "93372553", { text: `new token ${TOKEN}`, editedAt: at(9) })],
      { via: "sync" },
    )

    expect(await textOf(store, "93372553", "1")).toBe(`Done! Use this token to access the HTTP API: ${HIDDEN}`)
    expect(await textOf(store, "93372553", "2")).toBe(`token ${HIDDEN}`)
    expect((await store.messages.message(OWNER, "3", { chatId: "93372553" }))?.replyTo?.text).toBe(HIDDEN)
    expect(await textOf(store, "93372553", "4")).toBe(`new token ${HIDDEN}`)
    expect((await store.messages.search(SECRET, { limit: 10 })).items).toEqual([])
    expect((await store.messages.search("bot token hidden", { limit: 10 })).items.length).toBeGreaterThan(0)
  })

  it("stored by an older build are masked when the store is next opened, with their search copy and edits", async () => {
    const { store, path } = await opened()
    await saveChat(store, "500")
    await store.messages.saveMessages(OWNER, "500", [message("1", "500"), message("2", "500")], { via: "sync" })
    await store.close()
    stores.splice(0)
    const older = await openSqlite(path)
    older.database
      .prepare("UPDATE messages SET text = ?, normalized_text = lower(?), reply_to = ? WHERE external_id = '1'")
      .run(`token ${TOKEN}`, `token ${TOKEN}`, JSON.stringify({ id: "0", text: TOKEN }))
    older.database
      .prepare(
        `INSERT INTO message_revisions (message_id, text, edited_at, created_at)
          SELECT id, ?, NULL, 0 FROM messages WHERE external_id = '2'`,
      )
      .run(`was ${TOKEN}`)
    older.database.close()

    const { store: reopened } = await opened(path)

    expect(await textOf(reopened, "500", "1")).toBe(`token ${HIDDEN}`)
    expect((await reopened.messages.message(OWNER, "1", { chatId: "500" }))?.replyTo?.text).toBe(HIDDEN)
    expect((await reopened.messages.search(SECRET, { limit: 10 })).items).toEqual([])
    await reopened.close()
    stores.splice(0)
    const after = await openSqlite(path)
    const left = after.database
      .prepare(
        `SELECT (SELECT count(*) FROM message_revisions WHERE text LIKE '%' || ? || '%')
           + (SELECT count(*) FROM messages WHERE text LIKE '%' || ? || '%' OR normalized_text LIKE '%' || ? || '%'
                OR reply_to LIKE '%' || ? || '%') AS n`,
      )
      .get(SECRET, SECRET, SECRET.toLowerCase(), SECRET)
    after.database.close()
    expect(left).toEqual({ n: 0 })
  })
})

describe("a chat saved as not searchable", () => {
  it("stays out of search over all chats, stays hidden when saved again, and is read when named", async () => {
    const { store } = await opened()
    await saveChat(store, "93372553", { searchable: false })
    await saveChat(store, "93372553")
    await saveChat(store, "500")
    await store.messages.saveMessages(OWNER, "93372553", [message("1", "93372553", { text: "newbot done" })], {
      via: "sync",
    })
    await store.messages.saveMessages(OWNER, "500", [message("2", "500", { text: "newbot elsewhere" })], {
      via: "sync",
    })

    expect((await store.messages.search("newbot", { limit: 10 })).items.map((hit) => hit.chatId)).toEqual(["500"])
    expect(await textOf(store, "93372553", "1")).toBe("newbot done")
  })
})
