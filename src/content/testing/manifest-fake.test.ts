import { Command } from "commander"
import { afterEach, describe, expect, it } from "vitest"
import { WORDPRESS_CONTENT, wordpressApi } from "../../../test/fixtures/wordpress-content.js"
import { serviceApiCall } from "../../cli/service-api-call.js"
import { contentSourceFromManifest, contentWriterFromManifest } from "../manifest/index.js"
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
      held: { author: ["1", "2"], term: ["7", "1"], post: ["10", "11", "12"] },
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
  it("pages a list by the page count header, and refuses a page past the last", async () => {
    const { fake } = built()
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
