import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Command } from "commander"
import { afterEach, describe, expect, it } from "vitest"
import { WORDPRESS_CONTENT, wordpressApi, wordpressFake } from "../../../test/fixtures/wordpress-content.js"
import { provide } from "../../cli/context.js"
import type { AppIdentity } from "../../ports/app.js"
import type { Level } from "../../sends/permissions.js"
import { type MessageStore, openStore } from "../../store/store.js"
import type { AccountKey } from "../../store/types.js"
import { contentSourceFromManifest, contentWriterFromManifest } from "../manifest/index.js"
import type { ContentSource } from "../source.js"
import { exampleContentRows, fakeContentSource } from "../testing/index.js"
import type { ContentWriter } from "../writer.js"
import { addContentCommands } from "./index.js"

const APP: AppIdentity = {
  command: "blog",
  appName: "example-blog-cli",
  envPrefix: "BLOG",
  description: "synthetic",
  version: "1.0.0",
}
const ACCOUNT = { provider: "fake-blog", account: "blog.example.com" }
const NOW = Date.UTC(2026, 10, 18)

const opened: MessageStore[] = []
afterEach(async () => {
  for (const store of opened.splice(0)) await store.close()
})

type Answer = Record<string, unknown> & { items: Record<string, unknown>[]; item: Record<string, unknown> }

const setup = async (
  permissions: Record<string, Level> = {},
  over?: { source: ContentSource; writer: ContentWriter; account: AccountKey },
) => {
  const home = mkdtempSync(join(tmpdir(), "content-cli-"))
  const store = await openStore({ path: join(home, "store.db") })
  opened.push(store)
  const source = fakeContentSource({ rows: exampleContentRows(), clock: () => NOW })
  const env = { HOME: home, XDG_DATA_HOME: home, XDG_STATE_HOME: home, BLOG_STATE_DIR: home }
  const writes = () => ({
    writer: over?.writer ?? source.writer,
    app: APP,
    env,
    settings: () => ({ profile: "work", permissions, permissionSources: {} }),
  })
  const cli = async (...args: string[]): Promise<Answer> => {
    let data = ""
    const root = new Command("blog")
      .exitOverride()
      .configureOutput({ writeErr: () => undefined, writeOut: () => undefined })
      .option("--json")
      .option("--yes")
      .option("--dry-run")
    addContentCommands(root, {
      app: APP,
      open: async () => ({
        account: over?.account ?? ACCOUNT,
        store,
        source: () => over?.source ?? source,
        writes,
        env,
      }),
      writes: true,
      now: () => NOW,
    })
    provide(root, { streams: { data: (text: string) => (data += text), diagnostic: () => {} }, env } as never)
    await root.parseAsync([...args, "--json"], { from: "user" })
    return JSON.parse(data) as Answer
  }
  return { cli, store, source }
}

const ids = (answer: Answer) => answer.items.map((one) => one.external_id)

describe("content commands", () => {
  it("syncs, then lists by status and type, shows a post with names, and searches", async () => {
    const { cli } = await setup()
    expect((await cli("sync")).item).toMatchObject({ state: "complete", provider: "fake-blog", channels: 1 })
    expect(ids(await cli("posts", "list", "status:draft"))).toEqual(["11"])
    expect(ids(await cli("posts", "list", "status:draft", "status:published")).sort()).toEqual(["10", "11", "12"])
    expect(ids(await cli("posts", "list", "type:page"))).toEqual(["12"])
    expect(ids(await cli("posts", "list", "term:tag-7"))).toEqual(["10"])
    const shown = (await cli("posts", "show", "10")).item
    expect(shown).toMatchObject({
      title: "Version 2 is out",
      body: "We shipped **version 2**.",
      terms_named: [
        { external_id: "tag-7", name: "Releases" },
        { external_id: "cat-1", name: "News" },
      ],
      untrusted: expect.arrayContaining(["title", "body"]),
    })
    expect(ids(await cli("posts", "search", "pricing"))).toEqual(["11"])
    expect(ids(await cli("terms", "list")).sort()).toEqual(["cat-1", "tag-7"])
    expect((await cli("channels", "list")).items[0]).toMatchObject({ network: "fake-blog" })
  })

  it("writes a draft from a Markdown file, publishes it once, and keeps what it replaced", async () => {
    const { cli, source } = await setup()
    await cli("sync")
    const file = join(mkdtempSync(join(tmpdir(), "content-text-")), "post.md")
    writeFileSync(file, "# Hello\n\nA new post.")
    const made = (await cli("posts", "create", "--title", "Hello", "--body-file", file, "--yes")).item as {
      post: { external_id: string; status: string }
    }
    expect(made.post.status).toBe("draft")
    const id = made.post.external_id
    expect(((await cli("posts", "publish", id, "--yes")).item as { post: { status: string } }).post.status).toBe(
      "published",
    )
    expect((await cli("posts", "publish", id, "--yes")).item).toMatchObject({ unchanged: true })
    expect(source.publishes.get(id)).toBe(1)
    await cli("posts", "update", id, "--title", "Hello again", "--yes")
    const versions = (await cli("posts", "show", id)).item.versions as { title: string; reason: string }[]
    expect(versions.map((one) => one.reason)).toEqual(["write", "write"])
  })

  it("refuses to publish when the profile denies posts.publish, and sends nothing", async () => {
    const { cli, source } = await setup({ "posts.publish": "deny" })
    await cli("sync")
    await expect(cli("posts", "publish", "11", "--yes")).rejects.toThrow(/posts\.publish/)
    await expect(cli("posts", "schedule", "11", "--at", "2026-12-01T09:00:00Z", "--yes")).rejects.toThrow(
      /posts\.publish/,
    )
    await expect(cli("posts", "update", "10", "--title", "Public edit", "--yes")).rejects.toThrow(/posts\.publish/)
    expect(source.requests).toEqual([])
    // A scheduled post whose time passed is published by WordPress on any edit (RISK-9.b); the copy may still say
    // draft, so the write reads the post again first.
    await source.writer.schedule("11", NOW - 60_000, { operationId: "elsewhere" })
    await expect(cli("posts", "update", "11", "--title", "Missed schedule", "--yes")).rejects.toThrow(/posts\.publish/)
    expect(source.requests).toEqual(["schedule"])
  })

  it("refuses a schedule in the past and a body over blocks without --replace-body", async () => {
    const { cli, source, store } = await setup()
    await cli("sync")
    const file = join(mkdtempSync(join(tmpdir(), "content-text-")), "flat.md")
    writeFileSync(file, "Flat text.")
    await expect(cli("posts", "schedule", "11", "--at", "2020-01-01T00:00:00Z", "--yes")).rejects.toThrow()
    await store.content.save(ACCOUNT, "post", [{ externalId: "10", status: "published", lossy: true }], NOW)
    await expect(cli("posts", "update", "10", "--body-file", file, "--yes")).rejects.toThrow(/--replace-body/)
    expect(source.requests).toEqual([])
  })

  it("over WordPress from configuration: a publish or an edit of a public post without posts.publish sends nothing", async () => {
    const api = wordpressApi()
    const site = wordpressFake({ clock: () => NOW })
    const source = contentSourceFromManifest(WORDPRESS_CONTENT, {
      api,
      call: site.call,
      site: "example.com",
      now: () => NOW,
    })
    const writer = contentWriterFromManifest(WORDPRESS_CONTENT, {
      api,
      write: site.write,
      command: new Command("wp"),
      source,
      site: "example.com",
    })
    const { cli } = await setup(
      { "posts.publish": "deny" },
      { source, writer, account: { provider: "wordpress", account: "example.com" } },
    )
    await cli("sync")
    await expect(cli("posts", "publish", "11", "--yes")).rejects.toThrow(/posts\.publish/)
    // Scheduled on the site after the sync, its time already past: WordPress publishes it on any edit (RISK-9.b).
    Object.assign(site.rows.find((one) => one.id === 11) ?? {}, { status: "future", date_gmt: "2026-11-17T00:00:00" })
    await expect(cli("posts", "update", "11", "--title", "Missed schedule", "--yes")).rejects.toThrow(/posts\.publish/)
    expect(site.writes).toEqual([])
  })
})
