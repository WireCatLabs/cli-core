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
import { contentSourceContract, contentWriteContract, exampleContentRows } from "./index.js"
import { type ContentManifestFake, type ContentManifestFakeOptions, contentManifestFake } from "./manifest-fake.js"

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

// WordPress 6.9.4 on a local site (2026-11-19): neither role has these rights, and both are refused the users list.
const ROLES = {
  author: ["capabilities.edit_others_posts", "capabilities.edit_pages", "capabilities.edit_others_pages"],
  contributor: ["capabilities.edit_others_posts", "capabilities.edit_pages", "capabilities.edit_others_pages"],
}

describe("a role refused some of a kind's calls", () => {
  const DAY = 86_400_000
  const over = (
    manifest: unknown,
    lacks: readonly string[] = [],
    read: unknown = manifest,
    extra: Partial<ContentManifestFakeOptions> = {},
  ) => {
    let now = Date.parse("2026-11-17T00:00:00Z")
    const fake = contentManifestFake(manifest, {
      api,
      clock: () => (now += 1000),
      lacks,
      denied: lacks.length ? ["getWpV2Users"] : [],
      ...extra,
    })
    fakes.push(fake)
    const call = serviceApiCall({
      manifest: api,
      service: "WordPress",
      serverVariables: { site: "blog.example.test" },
      token: () => "someone:pw",
      fetch: fake.fetch,
    })
    const source = contentSourceFromManifest(read, { api, call, site: "blog.example.test", now: () => now })
    return { fake, source, later: (ms: number) => (now += ms), now: () => now }
  }
  const opened: Awaited<ReturnType<typeof openStore>>[] = []
  afterEach(async () => {
    for (const store of opened.splice(0)) await store.close()
  })
  const store = async () => {
    const one = await openStore({ path: join(mkdtempSync(join(tmpdir(), "content-roles-")), "wirecat.db") })
    opened.push(one)
    return one
  }
  const account = { provider: "wordpress", account: "blog.example.test" }
  const pagesOf = async (copy: Awaited<ReturnType<typeof openStore>>) =>
    (await copy.content.list(account, "post", { type: "page" })).items.map((one) => one.record.externalId)

  for (const [role, lacks] of Object.entries(ROLES))
    it(`syncs the ${role}'s posts, never sends the pages list, and marks no stored page deleted`, async () => {
      const copy = await store()
      const editor = over(WORDPRESS_CONTENT)
      await syncContent(editor.source, copy, account, { now: editor.now() })
      const pages = async () =>
        (await copy.content.list(account, "post", { type: "page" })).items.map((one) => one.record.externalId)
      expect(await pages()).toEqual(["12"])

      const signedIn = over(WORDPRESS_CONTENT, lacks)
      signedIn.later(2 * DAY)
      const first = await syncContent(signedIn.source, copy, account, { now: signedIn.now() })
      // The page the role no longer lists is read by its id, and a refusal keeps it.
      expect(first.synced.find((one) => one.kind === "post")).toMatchObject({ state: "complete", pass: "complete" })
      expect(first.gaps.map((one) => one.scope)).toEqual(
        expect.arrayContaining(["edit_pages", "edit_others_posts", "list_users"]),
      )
      expect(first.gaps.find((one) => one.scope === "edit_pages")?.message).toBe(
        "only an editor or administrator reads the pages",
      )
      expect(await pages()).toEqual(["12"])
      expect((await copy.content.get(account, "post", "12"))?.deletedAt).toBeNull()
      expect(signedIn.fake.refusals).toEqual(["getWpV2PagesById"])
      signedIn.fake.refusals.length = 0

      // The live symptom: an edit after the first sync never reached the copy.
      const row = signedIn.fake.rows.post?.[0]?.find((one) => String(one.id) === "10") as Record<string, unknown>
      row.title = { raw: "Edited elsewhere" }
      signedIn.fake.touch("post", "10")
      signedIn.later(60_000)
      const second = await syncContent(signedIn.source, copy, account, { now: signedIn.now() })
      expect(second.synced.find((one) => one.kind === "post")).toMatchObject({ state: "complete" })
      expect((await copy.content.get(account, "post", "10"))?.record.title).toBe("Edited elsewhere")
    })

  // DEBT-372: a role that sees only its own posts read every post on every sync, and never saw one deleted for good.
  for (const [role, lacks] of Object.entries(ROLES))
    it(`reads only the ${role}'s changes after the first sync, and marks deleted only what a read answers gone`, async () => {
      const copy = await store()
      // One more post of this role's own: a list of none would hold the pass for its own sake.
      const rows = () => {
        const all = exampleContentRows()
        const [own] = all.post ?? []
        return { ...all, post: [...(all.post ?? []), { ...(own as NonNullable<typeof own>), externalId: "13" }] }
      }
      const editor = over(WORDPRESS_CONTENT, [], WORDPRESS_CONTENT, { rows: rows() })
      await syncContent(editor.source, copy, account, { now: editor.now() })

      // Post 11 is another author's draft: this role's lists leave it out, and a read of it is refused.
      const signedIn = over(WORDPRESS_CONTENT, lacks, WORDPRESS_CONTENT, { rows: rows(), hidden: { post: ["11"] } })
      signedIn.later(2 * DAY)
      const first = await syncContent(signedIn.source, copy, account, { now: signedIn.now() })
      expect(first.synced.find((one) => one.kind === "post")).toMatchObject({ state: "complete", pass: "complete" })
      signedIn.fake.refusals.length = 0

      signedIn.later(60_000)
      const second = await syncContent(signedIn.source, copy, account, { now: signedIn.now() })
      expect(second.synced.find((one) => one.kind === "post")).toMatchObject({ round: "changes", state: "complete" })

      signedIn.fake.remove("post", "10")
      signedIn.later(2 * DAY)
      const third = await syncContent(signedIn.source, copy, account, { now: signedIn.now() })
      expect(third.synced.find((one) => one.kind === "post")).toMatchObject({
        round: "changes",
        pass: "complete",
        unlisted: 1,
      })
      expect((await copy.content.get(account, "post", "10"))?.deletedAt).not.toBeNull()
      expect((await copy.content.get(account, "post", "11"))?.deletedAt).toBeNull()
      expect((await copy.content.get(account, "post", "12"))?.deletedAt).toBeNull()
      expect(third.gaps.map((one) => one.message)).toContainEqual(
        expect.stringContaining("would not give this sign-in every post"),
      )
      signedIn.fake.refusals.length = 0
    })

  it("lists everything again once the sign-in gains the right it lacked", async () => {
    const copy = await store()
    const author = over(WORDPRESS_CONTENT, ROLES.author)
    await syncContent(author.source, copy, account, { now: author.now() })
    author.later(60_000)
    const again = await syncContent(author.source, copy, account, { now: author.now() })
    expect(again.synced.find((one) => one.kind === "post")).toMatchObject({ round: "changes" })

    const promoted = over(WORDPRESS_CONTENT)
    promoted.later(author.now() - promoted.now() + 60_000)
    const report = await syncContent(promoted.source, copy, account, { now: promoted.now() })
    expect(report.synced.find((one) => one.kind === "post")).toMatchObject({ round: "full", reset: true })
    expect(await pagesOf(copy)).toEqual(["12"])
  })

  // FIND-2815: without list_users the users list is refused with context=edit, and answered with context=view.
  it("reads the authors in the simpler form a role is answered, a gap that marks none deleted", async () => {
    const copy = await store()
    const editor = over(WORDPRESS_CONTENT)
    await syncContent(editor.source, copy, account, { now: editor.now() })

    const signedIn = over(WORDPRESS_CONTENT, [], WORDPRESS_CONTENT, {
      denied: ["getWpV2Users"],
      hidden: { author: ["2"] },
    })
    signedIn.later(2 * DAY)
    const report = await syncContent(signedIn.source, copy, account, { now: signedIn.now() })
    expect(report.synced.find((one) => one.kind === "author")).toMatchObject({ state: "complete", pass: "complete" })
    expect(report.gaps.find((one) => one.kind === "author")).toMatchObject({
      message: "only an administrator lists every user: these are the authors with published posts",
      scope: "list_users",
    })
    const authors = (await copy.content.list(account, "author")).items
    expect(authors.map((one) => [one.record.externalId, one.deletedAt])).toEqual([
      ["1", null],
      ["2", null],
    ])
  })

  it("holds a scheduled page an editor stored, once its time passed, for a role that may not read it", async () => {
    const copy = await store()
    const editor = over(WORDPRESS_CONTENT)
    const page = editor.fake.rows.post?.[1]?.[0] as Record<string, unknown>
    page.status = "future"
    page.date_gmt = new Date(editor.now() + 3_600_000).toISOString().slice(0, 19)
    await syncContent(editor.source, copy, account, { now: editor.now() })
    expect((await copy.content.get(account, "post", "12"))?.record.status).toBe("scheduled")

    const author = over(WORDPRESS_CONTENT, ROLES.author)
    author.later(2 * DAY)
    const report = await syncContent(author.source, copy, account, { now: author.now() })
    expect(report.synced.find((one) => one.kind === "post")).toMatchObject({ state: "complete", pass: "held" })
    expect((await copy.content.get(account, "post", "12"))?.record.status).toBe("scheduled")
    expect(author.fake.refusals).toEqual(["getWpV2PagesById"])
    author.fake.refusals.length = 0
  })

  it("takes a 400 whose details name 403 as a refusal: a gap, and the other call's posts kept", async () => {
    const [post, page] = WORDPRESS_CONTENT.entities.post as unknown as [object, { optional: object }]
    const { needs: _, ...optional } = page.optional as { needs?: unknown }
    const unguarded = {
      ...WORDPRESS_CONTENT,
      entities: { ...WORDPRESS_CONTENT.entities, post: [post, { ...page, optional }] },
    }
    const { fake, source, now } = over(WORDPRESS_CONTENT, ["capabilities.edit_pages"], unguarded)
    const copy = await store()
    const report = await syncContent(source, copy, account, { now: now() })
    expect(report.synced.find((one) => one.kind === "post")).toMatchObject({ state: "complete" })
    expect(report.gaps.find((one) => one.scope === "edit_others_pages")?.message).toBe(
      "the sign-in may not read every page",
    )
    expect((await copy.content.list(account, "post")).items.map((one) => one.record.externalId).sort()).toEqual([
      "10",
      "11",
    ])
    expect(fake.refusals).toContain("getWpV2Pages")
    fake.refusals.length = 0
  })
})
