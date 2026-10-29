import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { Attachment, Message } from "../domain/models.js"
import { type AccountKey, type MessageStore, openStore } from "../store/store.js"
import { searchStore } from "./messages-archive-search.js"

const account: AccountKey = { provider: "telegram", account: "100" }
const live: MessageStore[] = []
afterEach(async () => {
  for (const store of live.splice(0)) await store.close()
})

const voice: Attachment[] = [{ kind: "voice", mime: "audio/ogg" }]
const message = (id: string, text: string, attachments: Attachment[] = []): Message => ({
  id,
  chatId: "1",
  senderId: "200",
  senderName: "alice",
  timestamp: new Date(Date.UTC(2026, 0, 1, 10, Number(id))).toISOString(),
  editedAt: null,
  text,
  outgoing: false,
  attachments,
  replyTo: null,
  forwardedFrom: null,
  reactions: null,
})

/** Voice notes 1–3 and typed messages 4–5, each transcript as speech recognition heard it. */
const seeded = async (
  transcripts: Record<string, string>,
  typed: Record<string, string> = {},
  recorded: Attachment[] = voice,
) => {
  const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "transcript-words-")), "messages.db") })
  live.push(store)
  await store.chats.saveChats(account, [
    { id: "1", title: "Chat", kind: "group", unreadCount: 0, lastMessageAt: null, participantsCount: null },
  ])
  await store.messages.saveMessages(
    account,
    "1",
    [
      ...Object.keys(transcripts).map((id) => message(id, "", recorded)),
      ...Object.entries(typed).map(([id, text]) => message(id, text)),
    ],
    { via: "history" },
  )
  for (const [id, text] of Object.entries(transcripts))
    await store.messages.keepTranscript(account, "1", id, text, "gigaam-v3")
  return store
}
const search = (store: MessageStore, text: string) => searchStore(store, account, { limit: 20, text })
const ids = (found: { items: { id: string }[] }) => found.items.map(({ id }) => id).sort()

describe("voice-note transcripts", () => {
  it("**are found for an audio file someone sent**, not only a voice note", async () => {
    const store = await seeded({ "1": "jugamos a las seis" }, {}, [{ kind: "audio", mime: "audio/mp4" }])
    expect(ids(await search(store, "transcript:jugamos"))).toEqual(["1"])
  })

  it("**are found in another form of a word**, and not under exact:", async () => {
    const store = await seeded({ "1": "мы вчера позвонили риелтору насчёт квартиры" })
    expect(ids(await search(store, "transcript:риелтор"))).toEqual(["1"])
    const found = await search(store, "риелтор")
    expect(ids(found)).toEqual(["1"])
    expect(found.items[0]).toMatchObject({ matchedIn: "transcript" })
    expect(found.items[0]?.match).toBeUndefined()
    expect(ids(await search(store, "exact:риелтор"))).toEqual([])
  })

  it("**widen a word to a spelling recognition garbled, and say so**; typed text does not", async () => {
    const store = await seeded({ "1": "надо срочно найти реелтора на завтра" }, { "4": "надо срочно найти реелтора" })
    const found = await search(store, "риелтор")
    expect(ids(found)).toEqual(["1"])
    expect(found.items[0]).toMatchObject({ matchedIn: "transcript", match: "corrected" })
    expect(found.corrections).toEqual([{ from: "риелтор", to: ["реелтора"] }])
    expect(ids(await search(store, "transcript:риелтор"))).toEqual(["1"])
    expect(ids(await search(store, "exact:риелтор"))).toEqual([])
  })

  it("rank the typed form before a garbled spelling", async () => {
    const store = await seeded({ "1": "надо найти риелтора", "2": "надо найти реелтора" })
    expect((await search(store, "риелтор")).items.map(({ id }) => id)).toEqual(["1", "2"])
  })

  it("never widen a number word, nor a real word one edit away", async () => {
    const store = await seeded({ "1": "встреча через девять дней", "2": "давай поговорим завтра" })
    expect(ids(await search(store, "десять"))).toEqual([])
    expect(ids(await search(store, "договор"))).toEqual([])
  })

  it("**widen English and Spanish words too**, never to a real word nor a number", async () => {
    const store = await seeded({
      "1": "we need the budjet by friday",
      "2": "the cast was great",
      "3": "necesito el presupesto y nuebe copias",
    })
    expect(ids(await search(store, "budget"))).toEqual(["1"])
    expect(ids(await search(store, "cost"))).toEqual([])
    expect(ids(await search(store, "presupuesto"))).toEqual(["3"])
    expect(ids(await search(store, "nueve"))).toEqual([])
  })

  it("index a transcript written after the first search", async () => {
    const store = await seeded({ "1": "пока ничего" })
    expect(ids(await search(store, "риелтор"))).toEqual([])
    await store.messages.keepTranscript(account, "1", "1", "позвонили риелтору", "gigaam-v3")
    expect(ids(await search(store, "риелтор"))).toEqual(["1"])
  })
})
