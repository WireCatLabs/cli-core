import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Command } from "commander"
import { afterEach, describe, expect, it } from "vitest"
import { WORDPRESS_CONTENT, wordpressApi, wordpressFake } from "../../../test/fixtures/wordpress-content.js"
import { type MessageStore, openStore } from "../../store/store.js"
import { syncContent } from "../sync.js"
import { contentSourceContract, contentWriteContract } from "../testing/index.js"
import { contentSourceFromManifest, contentWriterFromManifest, parseContentManifest } from "./index.js"

const api = wordpressApi()
const SITE = "example.com"

const wordpress = (options: Parameters<typeof wordpressFake>[0] = {}) => {
  let siteNow = Date.UTC(2026, 10, 17)
  const fake = wordpressFake({
    clock: () => {
      siteNow += 1000
      return siteNow
    },
    ...options,
  })
  const source = contentSourceFromManifest(WORDPRESS_CONTENT, {
    api,
    call: fake.call,
    site: SITE,
    now: () => siteNow,
  })
  const writer = contentWriterFromManifest(WORDPRESS_CONTENT, {
    api,
    write: fake.write,
    command: new Command("wp"),
    source,
  })
  const skewed = (skew: number) =>
    contentSourceFromManifest(WORDPRESS_CONTENT, { api, call: fake.call, site: SITE, now: () => siteNow + skew })
  return { fake, source, writer, skewed, later: (ms: number) => (siteNow += ms) }
}

describe("contentSourceContract over WordPress, from configuration only", () => {
  for (const { name, run } of contentSourceContract(() => {
    const { fake, source, skewed } = wordpress()
    return {
      source,
      held: { author: ["1", "2"], term: ["7", "1"], post: ["10", "11", "12"] },
      deadCursor: { kind: "post", cursor: "not a time" },
      faults: {
        skewed,
        change: () => {
          fake.touch(11)
          return { kind: "post", id: "11" }
        },
        trash: () => {
          fake.trash(11)
          return "11"
        },
        remove: () => {
          fake.remove(12)
          return { kind: "post", id: "12" }
        },
      },
    }
  }))
    it(name, run)
})

describe("contentWriteContract over WordPress, from configuration only", () => {
  for (const { name, run } of contentWriteContract(() => {
    const { fake, writer } = wordpress()
    return {
      writer,
      loseNextAnswer: () => fake.loseNextAnswer(),
      requests: () => fake.writes.length,
      changeElsewhere: (id) => fake.touch(Number(id)),
    }
  }))
    it(name, run)
})

describe("WordPress from configuration", () => {
  const opened: MessageStore[] = []
  afterEach(async () => {
    for (const store of opened.splice(0)) await store.close()
  })
  const account = { provider: "wordpress", account: SITE }

  it("maps a WordPress post: statuses, GMT times as UTC, terms of both kinds, blocks as Markdown marked lossy", async () => {
    const { source } = wordpress()
    const post = await source.get("post", "10")
    expect(post).toMatchObject({
      externalId: "10",
      type: "post",
      status: "published",
      title: "Version 2 is out",
      channel: "site",
      publishedAt: Date.UTC(2026, 10, 1, 0, 0, 10),
      terms: ["7", "1"],
      authors: ["1"],
      lossy: true,
    })
    expect(post?.body).toContain("**version 2**")
    expect((await source.get("post", "11"))?.lossy).toBe(false)
    expect(await source.get("post", "12")).toMatchObject({ type: "page", status: "published" })
  })

  it("syncs into the store, then sees a trashed post as trashed and a deleted one as deleted", async () => {
    const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "wp-content-")), "wirecat.db") })
    opened.push(store)
    const { fake, source, later } = wordpress()
    const first = await syncContent(source, store, account, { now: Date.UTC(2026, 10, 17) })
    expect(first.state).toBe("complete")
    expect((await store.content.list(account, "post")).items.map((one) => one.record.externalId).sort()).toEqual([
      "10",
      "11",
      "12",
    ])
    fake.trash(11)
    fake.remove(12)
    later(60_000)
    await syncContent(source, store, account, { now: Date.UTC(2026, 10, 18, 0, 2) })
    expect((await store.content.get(account, "post", "11"))?.record.status).toBe("trashed")
    expect((await store.content.list(account, "post")).items.map((one) => one.record.externalId).sort()).toEqual([
      "10",
      "11",
    ])
  })

  it("marks deleted only a post a read says is gone, not one a list of ids skipped", async () => {
    const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "wp-content-")), "wirecat.db") })
    opened.push(store)
    const { fake, source } = wordpress()
    await syncContent(source, store, account, { now: Date.UTC(2026, 10, 17) })
    const listed = fake.call.withHeaders
    // A post deleted between two pages moves the next one onto the page already read: a list misses it.
    fake.call.withHeaders = async (operation, input) => {
      const answer = await listed(operation, input)
      if (input.query._fields !== "id") return answer
      return { ...answer, body: (answer.body as { id: number }[]).filter((one) => one.id !== 11) }
    }
    const report = await syncContent(source, store, account, { now: Date.UTC(2026, 10, 18, 1) })
    expect(report.synced.find((one) => one.kind === "post")).toMatchObject({ pass: "complete", unlisted: 0 })
    expect(await store.content.count(account, "post")).toBe(3)
  })

  it("holds the deletions when a contributor is refused the trash, and says why", async () => {
    const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "wp-content-")), "wirecat.db") })
    opened.push(store)
    await syncContent(wordpress().source, store, account, { now: Date.UTC(2026, 10, 17) })
    const report = await syncContent(wordpress({ contributor: 2 }).source, store, account, {
      now: Date.UTC(2026, 10, 18, 1),
    })
    expect(report.gaps.map((one) => one.scope)).toContain("edit_others_posts")
    expect(report.synced.find((one) => one.kind === "post")).toMatchObject({ pass: "held", unlisted: 0 })
    expect(await store.content.count(account, "post")).toBe(3)
  })

  it("writes terms by their kind as WordPress's integer ids, and a body as HTML", async () => {
    const { fake, source } = wordpress()
    const sent: unknown[] = []
    const writer = contentWriterFromManifest(WORDPRESS_CONTENT, {
      api,
      write: (command, operation, input) => {
        sent.push(JSON.parse(input.body ?? "{}"))
        return fake.write(command, operation, input)
      },
      command: new Command("wp"),
      source,
    })
    await writer.update("11", { terms: ["7", "1"], body: "Some *new* text." }, { operationId: "op-1" })
    expect(sent).toEqual([{ tags: [7], categories: [1], content: { raw: expect.stringContaining("<em>new</em>") } }])
  })

  it("names the place of a mistake in the manifest, with the nearest operation", () => {
    const wrong = structuredClone(WORDPRESS_CONTENT)
    const [posts] = wrong.entities.post
    if (posts) posts.list.operation = "getWpV2Post"
    expect(() => parseContentManifest(wrong, api)).toThrow(/entities\.post\.0\.list\.operation.*getWpV2Posts/)
    const writing = structuredClone(WORDPRESS_CONTENT)
    writing.writes.update.operation = "getWpV2PostsById"
    expect(() => parseContentManifest(writing, api)).toThrow(/writes\.update.*is a read/)
  })
})
