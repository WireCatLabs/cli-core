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

  it("keeps the posts a contributor may not read, each read once more by its id, and says why", async () => {
    const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "wp-content-")), "wirecat.db") })
    opened.push(store)
    await syncContent(wordpress().source, store, account, { now: Date.UTC(2026, 10, 17) })
    const report = await syncContent(wordpress({ contributor: 2 }).source, store, account, {
      now: Date.UTC(2026, 10, 18, 1),
    })
    expect(report.gaps.map((one) => one.scope)).toEqual(expect.arrayContaining(["edit_others_posts", "edit_pages"]))
    expect(report.synced.find((one) => one.kind === "post")).toMatchObject({
      state: "complete",
      pass: "complete",
      unlisted: 0,
    })
    expect(report.gaps.map((one) => one.message)).toContainEqual(
      expect.stringContaining("would not give this sign-in every post"),
    )
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

  it("passes the keys the content command checked to the api writer, with the call's own key", async () => {
    const { fake, source } = wordpress()
    const confirmed: (readonly string[])[] = []
    const writer = contentWriterFromManifest(WORDPRESS_CONTENT, {
      api,
      write: (command, operation, input, keys) => {
        confirmed.push(keys)
        return fake.write(command, operation, input)
      },
      command: new Command("wp"),
      source,
    })
    await writer.publish("11", { operationId: "op-1", confirmed: ["posts.publish"] })
    await writer.update("11", { title: "t" }, { operationId: "op-2" })
    const own = `api.${api.operations.find((one) => one.id === WORDPRESS_CONTENT.writes.update.operation)?.command}`
    expect(confirmed).toEqual([["posts.publish", own], []])
  })

  it("passes the page route's own key for the action the owner said yes to", async () => {
    const { fake, source } = wordpress()
    const confirmed: (readonly string[])[] = []
    const routed = {
      ...api,
      operations: api.operations.map((one) =>
        one.id === "postWpV2PagesById"
          ? { ...one, permissions: [{ key: "pages.publish", values: { status: ["publish", "future"] } }] }
          : one,
      ),
    }
    const writer = contentWriterFromManifest(WORDPRESS_CONTENT, {
      api: routed,
      write: (command, operation, input, keys) => {
        confirmed.push(keys)
        return fake.write(command, operation, input)
      },
      command: new Command("wp"),
      source,
    })
    await writer.unpublish("12", { operationId: "op-1" })
    await writer.publish("12", { operationId: "op-2", confirmed: ["posts.publish"] })
    const own = `api.${api.operations.find((one) => one.id === "postWpV2PagesById")?.command}`
    expect(confirmed).toEqual([[], ["posts.publish", "pages.publish", own]])
  })

  it("takes a yes to publish or unpublish as a yes to the update route's key, and a yes to update as no more", async () => {
    const { fake, source } = wordpress()
    const confirmed: (readonly string[])[] = []
    const routed = {
      ...api,
      operations: api.operations.map((one) =>
        one.id === "postWpV2PagesById"
          ? {
              ...one,
              permissions: [{ key: "posts.update" }, { key: "pages.publish", values: { status: ["publish"] } }],
            }
          : one,
      ),
    }
    const writer = contentWriterFromManifest(WORDPRESS_CONTENT, {
      api: routed,
      write: (command, operation, input, keys) => {
        confirmed.push(keys)
        return fake.write(command, operation, input)
      },
      command: new Command("wp"),
      source,
    })
    await writer.unpublish("12", { operationId: "op-1", confirmed: ["posts.unpublish"] })
    await writer.publish("12", { operationId: "op-2", confirmed: ["posts.publish"] })
    await writer.update("12", { title: "t" }, { operationId: "op-3", confirmed: ["posts.update"] })
    const own = `api.${api.operations.find((one) => one.id === "postWpV2PagesById")?.command}`
    expect(confirmed).toEqual([
      ["posts.unpublish", "posts.update", own],
      ["posts.publish", "posts.update", "pages.publish", own],
      ["posts.update", own],
    ])
  })

  // FIND-2816: one `writes` named the posts route, and a page could only be read.
  it("writes a page by the page calls, and keeps it a page in the answer", async () => {
    const { fake, writer } = wordpress()
    const made = await writer.createDraft(
      { type: "page", title: "Contact", body: "Write to us." },
      { operationId: "a" },
    )
    expect(made).toMatchObject({ type: "page", title: "Contact", status: "draft" })
    const updated = await writer.update(made.externalId, { title: "Contact us" }, { operationId: "b" })
    expect(updated).toMatchObject({ type: "page", title: "Contact us" })
    expect(await writer.publish("12", { operationId: "c" })).toMatchObject({ type: "page", status: "published" })
    expect(await writer.unpublish("12", { operationId: "d" })).toMatchObject({ type: "page", status: "draft" })
    expect(await writer.trash("12", { operationId: "e" })).toMatchObject({ type: "page", status: "trashed" })
    expect(await writer.trash(made.externalId, { operationId: "f", force: true })).toBeNull()
    expect(fake.writes).toEqual([
      "postWpV2Pages",
      "postWpV2PagesById",
      "postWpV2PagesById",
      "deleteWpV2PagesById",
      "deleteWpV2PagesById",
    ])
    await expect(writer.update("12", { terms: ["7"] }, { operationId: "g" })).rejects.toMatchObject({
      details: { reason: "content.write-unsupported" },
    })
  })

  it("refuses a page write when the manifest names no page calls", async () => {
    const { page: _, ...writes } = WORDPRESS_CONTENT.writes
    const { fake, source } = wordpress()
    const writer = contentWriterFromManifest(
      { ...WORDPRESS_CONTENT, writes },
      { api, write: fake.write, command: new Command("wp"), source },
    )
    await expect(writer.update("12", { title: "t" }, { operationId: "a" })).rejects.toMatchObject({
      details: { reason: "content.write-unsupported" },
    })
    await expect(writer.createDraft({ type: "page", title: "t" }, { operationId: "b" })).rejects.toMatchObject({
      details: { reason: "content.write-unsupported" },
    })
    expect(fake.writes).toEqual([])
  })

  it("names the place of a mistake in the manifest, with the nearest operation", () => {
    const wrong = structuredClone(WORDPRESS_CONTENT)
    const [posts] = wrong.entities.post
    if (posts) posts.list.operation = "getWpV2Post"
    expect(() => parseContentManifest(wrong, api)).toThrow(/entities\.post\.0\.list\.operation.*getWpV2Posts/)
    const writing = structuredClone(WORDPRESS_CONTENT)
    writing.writes.update.operation = "getWpV2PostsById"
    expect(() => parseContentManifest(writing, api)).toThrow(/writes\.update.*is a read/)
    const needing = structuredClone(WORDPRESS_CONTENT) as unknown as {
      entities: { post: { optional: { needs: { operation: string } } }[] }
    }
    const [, pages] = needing.entities.post
    if (pages) pages.optional.needs.operation = "postWpV2Posts"
    expect(() => parseContentManifest(needing, api)).toThrow(/entities\.post\.1\.optional\.needs.*is a write/)
    const paging = structuredClone(WORDPRESS_CONTENT) as unknown as { writes: { page: { update: { path: object } } } }
    paging.writes.page.update.path = {}
    expect(() => parseContentManifest(paging, api)).toThrow(/writes\.page\.update.*\{id\}/)
  })
})
