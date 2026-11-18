import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { rollBackTo } from "../testing/older-store.js"
import { openCache } from "./open.js"
import { resetContentPostWords } from "./sqlite/content.js"
import { openStore } from "./store.js"

const SITE = { provider: "example-blog", account: "blog.example.com" }

it("gives a version 70 file a place for content copies, with their words, versions and tags", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "version-71-")), "wirecat.db")
  const store = await openStore({ path })
  await store.close()

  const old = await openCache(path)
  rollBackTo(old, 71)
  expect(old.prepare("SELECT 1 FROM sqlite_master WHERE name = 'content_posts'").get()).toBeUndefined()
  old.close()

  const upgraded = await openStore({ path })
  try {
    await upgraded.content.save(SITE, "term", [{ externalId: "t1", kind: "tag", name: "Refunds", slug: "refunds" }], 1)
    await upgraded.content.save(
      SITE,
      "post",
      [{ externalId: "p1", title: "Refund the invoice", body: "How we refund.", status: "published", terms: ["t1"] }],
      1,
    )
    expect((await upgraded.content.find({ words: ["refund"] })).items).toHaveLength(1)
    await upgraded.content.save(SITE, "post", [{ externalId: "p1", title: "Close the ticket", status: "draft" }], 2)
    expect((await upgraded.content.find({ words: ["invoice"] })).items).toHaveLength(0)
    expect((await upgraded.content.find({ words: ["ticket"] })).items).toHaveLength(1)
    expect((await upgraded.content.revisions(SITE, "p1")).map((one) => [one.title, one.status, one.reason])).toEqual([
      ["Refund the invoice", "published", "sync"],
    ])
  } finally {
    await upgraded.close()
  }

  const database = await openCache(path)
  expect(
    database
      .prepare("SELECT t.name FROM taggings g JOIN canonical_tags t ON t.id = g.tag_id WHERE g.taggable_type = 'post'")
      .all(),
  ).toEqual([{ name: "refunds" }])
  expect(resetContentPostWords(database)).toBe(1)
  database.close()
  const again = await openStore({ path })
  try {
    expect((await again.content.find({ words: ["ticket"] })).items).toHaveLength(1)
  } finally {
    await again.close()
  }
})
