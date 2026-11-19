import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Readable } from "node:stream"
import { captureStreams } from "@wirecat/cli-base"
import { memoryKeyring } from "@wirecat/cli-base/testing"
import { afterEach, expect, it } from "vitest"
import { WORDPRESS_CONTENT, wordpressApi } from "../../test/fixtures/wordpress-content.js"
import { recalledAccount } from "../cli/messenger/accounts.js"
import { run } from "../cli/program.js"
import { serviceApiCall } from "../cli/service-api-call.js"
import { settingsFor } from "../cli/settings.js"
import { tokenSessionCommand } from "../cli/token-session.js"
import { openStore } from "../store/store.js"
import type { AccountKey } from "../store/types.js"
import { contentSourceFromManifest } from "./manifest/index.js"
import { syncContent } from "./sync.js"
import { contentManifestFake } from "./testing/manifest-fake.js"

const app = { command: "blog", appName: "blog-cli", envPrefix: "BLOG", description: "synthetic", version: "1.0.0" }
const api = wordpressApi()
const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const setup = () => {
  const root = mkdtempSync(join(tmpdir(), "site-accounts-"))
  roots.push(root)
  const env = { HOME: root, BLOG_STATE_DIR: join(root, "state"), BLOG_CONFIG_DIR: join(root, "config") }
  const keyring = memoryKeyring()
  const configuration = settingsFor(app)
  const definition = {
    app,
    configuration,
    commands: () => [
      tokenSessionCommand({
        app,
        service: "Blog",
        resolveSettings: configuration.resolveSettings,
        site: { example: "blog.example.com" },
        // Every site's first admin is user 1.
        verify: async () => ({ id: "1", account: { id: "1" } }),
      }),
    ],
  }
  const start = async (profile: string, site: string) => {
    const code = await run([profile, "session", "start", "--site", site, "--json"], definition, {
      streams: captureStreams(),
      env,
      keyring,
      tty: false,
      stdin: Readable.from(["token\n"]),
    })
    expect(code).toBe(0)
    const account = recalledAccount(app, "wordpress", profile, env)
    if (!account) throw new Error(`${profile} remembered no account`)
    return account
  }
  return { start, root }
}

it("two sites with the same user id are two accounts, and a sync of one deletes nothing of the other", async () => {
  const { start, root } = setup()
  const a = await start("personal", "a.blog.test")
  const b = await start("work", "b.blog.test/news")
  expect(a).toEqual({ provider: "wordpress", account: "a.blog.test:1" })
  expect(b).toEqual({ provider: "wordpress", account: "b.blog.test/news:1" })

  const store = await openStore({ path: join(root, "wirecat.db") })
  const sync = async (site: string, account: AccountKey, fake = contentManifestFake(WORDPRESS_CONTENT, { api })) => {
    const call = serviceApiCall({
      manifest: api,
      service: "WordPress",
      serverVariables: { site },
      token: () => "editor:pw",
      fetch: fake.fetch,
    })
    return syncContent(contentSourceFromManifest(WORDPRESS_CONTENT, { api, call, site }), store, account)
  }
  const ids = async (account: AccountKey) =>
    (await store.content.list(account, "post")).items.map((one) => one.record.externalId).sort()
  try {
    expect(await sync("a.blog.test", a)).toMatchObject({ state: "complete" })
    const before = await ids(a)
    const fakeB = contentManifestFake(WORDPRESS_CONTENT, { api })
    fakeB.remove("post", "12")
    expect(await sync("b.blog.test/news", b as NonNullable<typeof b>, fakeB)).toMatchObject({ state: "complete" })
    expect(await ids(b as NonNullable<typeof b>)).toEqual(fakeB.ids("post").sort())
    expect(await ids(a)).toEqual(before)
    expect(before).toContain("12")
  } finally {
    await store.close()
  }
})

it("one site under two spellings is one account", async () => {
  const { start } = setup()
  const one = await start("personal", "https://Blog.Example.TEST/news/")
  const two = await start("work", "blog.example.test/news")
  expect(one).toEqual(two)
  expect(one.account).toBe("blog.example.test/news:1")
})
