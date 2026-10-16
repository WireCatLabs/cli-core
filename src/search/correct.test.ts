import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { openStore } from "../store/store.js"
import { correctWords, editDistance, maxEdits, type Vocabulary } from "./correct.js"

const vocabulary = (words: Record<string, number>): Vocabulary & { asked: string[][] } => {
  const asked: string[][] = []
  return {
    asked,
    knownTerms: async (terms) =>
      new Set(terms.filter((term) => Object.keys(words).some((word) => word.startsWith(term.toLowerCase())))),
    termCandidates: async (trigrams, { shortest, longest }) => {
      asked.push(trigrams)
      return Object.entries(words)
        .filter(([term]) => term.length >= shortest && term.length <= longest)
        .map(([term, docs]) => ({ term, docs }))
    },
  }
}

describe("editDistance", () => {
  it.each([
    ["valenca", "valencia", 1],
    ["valecnia", "valencia", 1],
    ["kitten", "sitting", 3],
    ["tie", "the", 1],
    ["empadronamineto", "empadronamiento", 1],
  ])("%s → %s is %i", (a, b, distance) => {
    expect(editDistance(a, b, 3)).toBe(distance)
  })

  it("gives up past the limit", () => {
    expect(editDistance("abc", "xyzw", 1)).toBe(2)
  })
})

describe("correctWords", () => {
  it("**corrects only words the store does not know**, to the nearest, then the most frequent", async () => {
    const store = vocabulary({ valencia: 85, valence: 3, valenciana: 40, piso: 300 })

    expect(await correctWords(store, ["piso", "valenca"])).toEqual(new Map([["valenca", ["valencia", "valence"]]]))
  })

  it("**leaves a word that begins a known one**: квартир is not a typo of квартира", async () => {
    expect(await correctWords(vocabulary({ квартира: 9, квартиру: 4 }), ["квартир"])).toEqual(new Map())
  })

  it("allows one edit up to four letters, two above, and leaves numbers and far words alone", async () => {
    expect(maxEdits("tie")).toBe(1)
    expect(maxEdits("valencia")).toBe(2)
    const store = vocabulary({ tiempo: 50, valencia: 85 })
    expect(await correctWords(store, ["tim", "2026", "zzzzzz"])).toEqual(new Map())
    expect(store.asked).toHaveLength(2)
  })

  it("keeps at most five of the nearest", async () => {
    const store = vocabulary(
      Object.fromEntries(["casa", "caja", "cama", "cara", "capa", "cala"].map((word, index) => [word, index])),
    )

    expect((await correctWords(store, ["cava"])).get("cava")).toEqual(["cala", "capa", "cara", "cama", "caja"])
  })
})

describe("correctWords over the store", () => {
  it("**corrects valenca to valencia** from the messages held, and not to a word only a deleted message had", async () => {
    const account = { provider: "telegram", account: "100" }
    const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "correct-")), "messages.db") })
    await store.chats.saveChats(account, [
      { id: "1", title: "Chat", kind: "group", unreadCount: 0, lastMessageAt: null, participantsCount: null },
    ])
    const message = (id: string, text: string) => ({
      id,
      chatId: "1",
      senderId: "7",
      senderName: "Ana",
      timestamp: "2026-09-01T10:00:00.000Z",
      editedAt: null,
      text,
      outgoing: false,
      attachments: [],
      replyTo: null,
      forwardedFrom: null,
      reactions: null,
    })
    await store.messages.saveMessages(account, "1", [message("1", "Piso en Valencia"), message("2", "Valenza")], {
      via: "history",
    })
    await store.searchIndex.fillSearchIndex()
    await store.messages.markDeleted(account, ["2"], { chatId: "1" })

    expect(await correctWords(store.searchIndex, ["piso", "valenca"])).toEqual(new Map([["valenca", ["valencia"]]]))
    await store.close()
  })
})
