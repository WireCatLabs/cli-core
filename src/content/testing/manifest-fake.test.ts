import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Command } from "commander"
import { afterEach, describe, expect, it } from "vitest"
import { WORDPRESS_CONTENT, wordpressApi } from "../../../test/fixtures/wordpress-content.js"
import { serviceApiCall } from "../../cli/service-api-call.js"
import { openStore } from "../../store/store.js"
import { contentSourceFromManifest, contentWriterFromManifest } from "../manifest/index.js"
import { syncContent } from "../sync.js"
import { contentSourceContract, contentWriteContract } from "./index.js"
import { type ContentManifestFake, contentManifestFake } from "./manifest-fake.js"

const api = wordpressApi()
const fakes: ContentManifestFake[] = []

afterEach(() => {
  // A call the fake refused is one the manifest does not make: the source would fail on the real service.
  expect(fakes.splice(0).flatMap((fake) => fake.refusals)).toEqual([])
})

const built = () => {
  let now = Date.parse("2026-11-17T00:00:00Z")
  const fake = contentManifestFake(WORDPRESS_CONTENT, {
    api,
    clock: () => {
      now += 1000
      return now
    },
  })
  fakes.push(fake)
  const source = (skew = 0) =>
    contentSourceFromManifest(WORDPRESS_CONTENT, {
      api,
      call: fake.call,
      site: "blog.example.test",
      now: () => now + skew,
    })
  const writer = contentWriterFromManifest(WORDPRESS_CONTENT, {
    api,
    write: fake.write,
    command: new Command("blog"),
    source: source(),
  })
  return { fake, source: source(), skewed: source, writer }
}

describe("contentSourceContract over the content fake of a WordPress manifest", () => {
  for (const { name, run } of contentSourceContract(() => {
    const { fake, source, skewed } = built()
    return {
      source,
      held: { author: fake.ids("author"), term: fake.ids("term"), post: fake.ids("post") },
      deadCursor: { kind: "post", cursor: "not a time" },
      faults: {
        skewed,
        change: () => {
          fake.touch("post", "11")
          return { kind: "post", id: "11" }
        },
        trash: () => {
          fake.trash("11")
          return "11"
        },
        remove: () => {
          fake.remove("post", "12")
          return { kind: "post", id: "12" }
        },
      },
    }
  }))
    it(name, run)
})

// A CLI's test runs the fake on its own clock, the real one, as its sync does.
describe("contentSourceContract over the content fake on its default clock", () => {
  for (const { name, run } of contentSourceContract(() => {
    const fake = contentManifestFake(WORDPRESS_CONTENT, { api })
    fakes.push(fake)
    const source = (skew = 0) =>
      contentSourceFromManifest(WORDPRESS_CONTENT, {
        api,
        call: fake.call,
        site: "blog.example.test",
        now: () => Date.now() + skew,
      })
    return {
      source: source(),
      held: { author: fake.ids("author"), term: fake.ids("term"), post: fake.ids("post") },
      faults: {
        skewed: source,
        change: () => {
          fake.touch("post", "11")
          return { kind: "post", id: "11" }
        },
        trash: () => {
          fake.trash("11")
          return "11"
        },
      },
    }
  }))
    it(name, run)
})

describe("contentWriteContract over the content fake of a WordPress manifest", () => {
  for (const { name, run } of contentWriteContract(() => {
    const { fake, writer } = built()
    return {
      writer,
      loseNextAnswer: () => fake.loseNextAnswer(),
      requests: () => fake.writes.length,
      changeElsewhere: (id) => fake.touch("post", id),
    }
  }))
    it(name, run)
})

describe("contentManifestFake over HTTP", () => {
  it("syncs every kind through the api group's call, the rights read at its literal route", async () => {
    const fake = contentManifestFake(WORDPRESS_CONTENT, { api })
    fakes.push(fake)
    const call = serviceApiCall({
      manifest: api,
      service: "WordPress",
      serverVariables: { site: "blog.example.test" },
      token: () => "editor:pw",
      fetch: fake.fetch,
    })
    const source = contentSourceFromManifest(WORDPRESS_CONTENT, { api, call, site: "blog.example.test" })
    const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "content-fake-")), "wirecat.db") })
    const account = { provider: "wordpress", account: "blog.example.test" }
    try {
      const report = await syncContent(source, store, account)
      expect(report).toMatchObject({ state: "complete" })
      expect((await store.content.list(account, "post")).items.map((one) => one.record.externalId).sort()).toEqual(
        fake.ids("post").sort(),
      )
      expect(report.gaps ?? []).toEqual([])
    } finally {
      await store.close()
    }
  })

  it("answers a site with a path of its own, and no route by its last segments alone", async () => {
    const fake = contentManifestFake(WORDPRESS_CONTENT, { api })
    const ok = await fake.fetch("https://b.blog.test/news/wp-json/wp/v2/tags?context=edit&per_page=100&orderby=id")
    expect(ok.status).toBe(200)
    const stray = await fake.fetch("https://b.blog.test/wp-json/wp/v2/users/5/wp/v2/posts")
    expect(stray.status).toBe(404)
    expect(fake.refusals).toEqual(["GET /wp-json/wp/v2/users/5/wp/v2/posts"])
    fake.refusals.length = 0
  })

  it("puts a list and a row where the source manifest's call reads them", async () => {
    const author = WORDPRESS_CONTENT.entities.author[0] as (typeof WORDPRESS_CONTENT.entities.author)[0]
    const wrapped = {
      ...WORDPRESS_CONTENT,
      entities: {
        ...WORDPRESS_CONTENT.entities,
        author: [{ ...author, list: { ...author.list, items: "data" }, get: { ...author.get, items: "data" } }],
      },
    }
    const fake = contentManifestFake(wrapped, { api })
    fakes.push(fake)
    const source = contentSourceFromManifest(wrapped, { api, call: fake.call, site: "blog.example.test" })
    const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "content-fake-")), "wirecat.db") })
    const account = { provider: "wordpress", account: "blog.example.test:1" }
    try {
      expect(await syncContent(source, store, account)).toMatchObject({ state: "complete" })
      expect((await store.content.list(account, "author")).items.map((one) => one.record.externalId).sort()).toEqual(
        fake.ids("author").sort(),
      )
      const id = fake.ids("author")[0] as string
      expect(
        await fake.call("getWpV2UsersById", { path: { id }, query: { context: "edit" }, headers: {}, fields: {} }),
      ).toMatchObject({ data: { id: Number(id) } })
    } finally {
      await store.close()
    }
  })

  it("pages a list by the page count header, and refuses a page past the last", async () => {
    const { fake } = built()
    expect(fake.ids("post")).toEqual(["10", "11", "12"])
    const call = serviceApiCall({
      manifest: api,
      service: "WordPress",
      serverVariables: { site: "blog.example.test" },
      token: () => "editor:pw",
      fetch: fake.fetch,
    })
    const query = { context: "edit", status: "publish,future,draft,pending,private,trash", per_page: "100" }
    const first = await call.withHeaders("getWpV2Posts", {
      path: {},
      query: { ...query, orderby: "id", order: "asc", page: "1" },
      headers: {},
      fields: {},
    })
    expect(first.body).toHaveLength(2)
    expect(first.headers.get("x-wp-totalpages")).toBe("1")
    await expect(
      call("getWpV2Posts", {
        path: {},
        query: { ...query, orderby: "id", order: "asc", page: "2" },
        headers: {},
        fields: {},
      }),
    ).rejects.toMatchObject({ code: "validation_error" })
  })
})
