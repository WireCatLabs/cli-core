import assert from "node:assert/strict"
import { runBudget } from "../../background/budget.js"
import type { ContractCase } from "../../meetings/index.js"
import type { MessageStore } from "../../store/store.js"
import type { AccountKey } from "../../store/types.js"
import { type ContentSyncOptions, syncContent } from "../sync.js"
import {
  exampleContentRows,
  type FakeContentSource,
  type FakeContentSourceOptions,
  fakeContentSource,
} from "./source.js"

/** A fresh, empty store and the content account to sync into it. */
export interface ContentSyncFixture {
  store: MessageStore
  account: AccountKey
}

interface Context extends ContentSyncFixture {
  source: FakeContentSource
  sync: (options?: ContentSyncOptions, source?: FakeContentSource) => ReturnType<typeof syncContent>
  posts: () => Promise<string[]>
  status: (id: string) => Promise<string | undefined>
}

const DAY = 86_400_000

/** What the sync engine does over any store, whatever the source: core runs it, and a CLI may run it over its store. */
export const contentSyncContract = (make: () => ContentSyncFixture | Promise<ContentSyncFixture>): ContractCase[] => {
  let now = Date.UTC(2026, 10, 18)
  const test = (
    name: string,
    check: (context: Context) => Promise<void>,
    fake: Partial<FakeContentSourceOptions> = {},
  ): ContractCase => ({
    name,
    async run() {
      now = Date.UTC(2026, 10, 18)
      const fixture = await make()
      const source = fakeContentSource({ rows: exampleContentRows(), clock: () => now, ...fake })
      const sync = (options: ContentSyncOptions = {}, other = source) =>
        syncContent(other, fixture.store, fixture.account, { now, ...options })
      const posts = async () =>
        (await fixture.store.content.list(fixture.account, "post")).items.map((one) => one.record.externalId).sort()
      const status = async (id: string) => (await fixture.store.content.get(fixture.account, "post", id))?.record.status
      await check({ ...fixture, source, sync, posts, status })
    },
  })
  const later = (days = 2) => {
    now += days * DAY
  }
  return [
    test("copies channels, authors, terms and posts on the first run, and only what changed on the next", async (c) => {
      const first = await c.sync()
      assert.equal(first.state, "complete")
      assert.equal(first.channels, 1)
      assert.deepEqual(await c.posts(), ["10", "11", "12"])
      c.source.touch("post", "11")
      const second = await c.sync()
      const posts = second.synced.find((one) => one.kind === "post")
      assert.equal(posts?.round, "changes")
      assert.equal(posts?.saved, 1, "only the changed post is read again")
    }),
    test("a post moved to the trash stays in the copy with the status trashed; it is not deleted", async (c) => {
      await c.sync()
      c.source.trashed("11")
      later()
      await c.sync()
      assert.deepEqual(await c.posts(), ["10", "11", "12"])
      assert.equal(await c.status("11"), "trashed")
    }),
    test("a post deleted for good is marked deleted by a complete id pass, its last text kept as a version", async (c) => {
      await c.sync()
      c.source.remove("post", "11")
      later()
      const report = await c.sync()
      assert.equal(report.synced.find((one) => one.kind === "post")?.unlisted, 1)
      assert.deepEqual(await c.posts(), ["10", "12"])
      const [kept] = await c.store.content.revisions(c.account, "11")
      assert.equal(kept?.reason, "deleted")
      assert.equal(kept?.title, "Draft about pricing")
    }),
    test("a changed post keeps what it said before as a version", async (c) => {
      await c.sync()
      await c.source.writer.update("10", { body: "We shipped version 2, and 2.1." }, { operationId: "x" })
      await c.sync()
      const [kept] = await c.store.content.revisions(c.account, "10")
      assert.equal(kept?.reason, "sync")
      assert.equal(kept?.body, "We shipped **version 2**.")
    }),
    test("a scheduled post whose time passed is read again until it is published, with no change reported", async (c) => {
      await c.sync()
      await c.source.writer.schedule("11", now + 60_000, { operationId: "x" })
      later()
      await c.sync()
      assert.equal(await c.status("11"), "scheduled", "its time passed, but the source has not sent it out yet")
      c.source.elapse("11")
      later()
      const report = await c.sync()
      assert.equal(report.due, 1)
      assert.equal(await c.status("11"), "published")
    }),
    test("a scheduled post deleted for good before its time is marked deleted when read again", async (c) => {
      await c.sync()
      await c.source.writer.schedule("11", now + 60_000, { operationId: "x" })
      await c.sync()
      c.source.remove("post", "11")
      later(0.01)
      await c.sync({ passEvery: 10 * DAY })
      assert.deepEqual(await c.posts(), ["10", "12"])
    }),
    test(
      "a sign-in that sees only its own posts says so, and the posts it cannot see are not marked deleted",
      async (c) => {
        await c.sync({}, fakeContentSource({ rows: c.source.rows }))
        later()
        const report = await c.sync()
        const posts = report.synced.find((one) => one.kind === "post")
        assert.equal(report.gaps[0]?.scope, "edit_others_posts")
        assert.equal(posts?.pass, "held")
        assert.deepEqual(await c.posts(), ["10", "11", "12"])
      },
      { only: { author: "1" } },
    ),
    test("a list of no ids marks nothing deleted; --rescan lets it through", async (c) => {
      await c.sync()
      for (const id of ["10", "11", "12"]) c.source.remove("post", id)
      later()
      const held = await c.sync()
      assert.equal(held.synced.find((one) => one.kind === "post")?.pass, "held")
      assert.deepEqual(await c.posts(), ["10", "11", "12"])
      const rescan = await c.sync({ rescan: true })
      assert.equal(rescan.synced.find((one) => one.kind === "post")?.pass, "complete")
      assert.deepEqual(await c.posts(), [])
    }),
    test("a site whose address changed holds its deletions until a rescan", async (c) => {
      await c.sync()
      c.source.move("https://other.example.com")
      c.source.remove("post", "11")
      later()
      const report = await c.sync()
      assert.deepEqual(report.moved, [
        { channel: "site", from: "https://blog.example.com", to: "https://other.example.com" },
      ])
      assert.equal(report.synced.find((one) => one.kind === "post")?.pass, "held")
      assert.deepEqual(await c.posts(), ["10", "11", "12"])
      await c.sync({ rescan: true })
      assert.deepEqual(await c.posts(), ["10", "12"])
    }),
    test("an author whose e-mail a read leaves out keeps the stored one; nothing is erased by omission", async (c) => {
      await c.sync()
      const [author] = c.source.rows.author ?? []
      assert.ok(author, "the fake holds an author")
      delete (author as { email?: string | null }).email
      c.source.touch("author", "1")
      await c.sync()
      assert.equal((await c.store.content.get(c.account, "author", "1"))?.record.email, "ada@example.com")
    }),
    test("a renamed term keeps its id; a post that loses a term loses its tag", async (c) => {
      await c.sync()
      const tags = async () => (await c.store.content.get(c.account, "post", "10"))?.record.terms ?? []
      assert.deepEqual(await tags(), ["tag-7", "cat-1"])
      const rows = c.source.rows
      const term = rows.term?.find((one) => one.externalId === "tag-7")
      if (term) term.name = "Release notes"
      c.source.touch("term", "tag-7")
      await c.source.writer.update("10", { terms: ["cat-1"] }, { operationId: "x" })
      await c.sync()
      assert.equal((await c.store.content.get(c.account, "term", "tag-7"))?.record.name, "Release notes")
      assert.deepEqual(await tags(), ["cat-1"])
    }),
    test("two profiles on one site sync into one copy without a post twice", async (c) => {
      await c.sync()
      const other = fakeContentSource({ rows: c.source.rows })
      await c.sync({}, other)
      assert.deepEqual(await c.posts(), ["10", "11", "12"])
      assert.equal(await c.store.content.count(c.account, "post"), 3)
    }),
    test("a run that stops part way goes on from its page in the next one, nothing lost", async (c) => {
      const first = await c.sync({ budget: runBudget({ requests: 3 }) })
      assert.equal(first.state, "partial")
      for (let run = 0; run < 10; run += 1) if ((await c.sync({ budget: runBudget({ requests: 3 }) })).complete) break
      assert.deepEqual(await c.posts(), ["10", "11", "12"])
    }),
    test(
      "numbers are new readings each run, never overwritten; a source without them reads none",
      async (c) => {
        await c.sync()
        later(0.01)
        await c.sync()
        const readings = await c.store.content.metrics(c.account, "10")
        assert.equal(readings.length, 2)
        assert.equal(readings[0]?.views, 42)
      },
      { metrics: { "10": { views: 42, comments: 3 } } },
    ),
  ]
}
