import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { openCache } from "./open.js"
import { openStore } from "./store.js"

it("combines canonical and alias automatic claims and retains manual labels across replay", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "auto-tag-aliases-")), "fixture.db")
  const store = await openStore({ path, now: () => 3000 })
  try {
    const key = { provider: "example", account: "AliceExample" }
    await store.chats.saveChats(key, [
      {
        id: "1",
        title: "Alice Example channel",
        kind: "channel",
        unreadCount: 0,
        lastMessageAt: null,
        participantsCount: null,
      },
    ])
    const tag = await store.knowledge.createTag("onboarding")
    await store.knowledge.addVocabularyAlias({ kind: "tag", id: String(tag.id) }, "arrival")
    await store.knowledge.addTags(key, { type: "chat", id: "1" }, ["onboarding"])
    const matches = [
      { tag: "onboarding", score: 0.3, fields: ["title"] },
      { tag: "arrival", score: 0.6, fields: ["description", "title"] },
    ]
    await store.chats.replaceAutoTags(key, "1", "invented", matches)
    await store.chats.replaceAutoTags(key, "1", "invented", matches)
    const database = await openCache(path)
    try {
      const claims = database.prepare("SELECT tag_id,score,fields FROM auto_tag_claims").all()
      expect(claims).toHaveLength(1)
      expect(claims[0]?.tag_id).toBe(tag.id)
      expect(claims[0]?.score).toBe(0.6)
      expect(JSON.parse(String(claims[0]?.fields))).toEqual(["title", "description"])
    } finally {
      database.close()
    }
    expect(await store.knowledge.tags(key, { type: "chat", id: "1" })).toEqual(["onboarding"])
    await store.chats.replaceAutoTags(key, "1", "invented", [])
    expect(await store.knowledge.tags(key, { type: "chat", id: "1" })).toEqual(["onboarding"])
  } finally {
    await store.close()
  }
})
