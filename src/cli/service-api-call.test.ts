import type { ManifestOperation } from "@wirecat/cli-base/codegen"
import { describe, expect, it } from "vitest"
import { serviceApiCall } from "./service-api-call.js"
import { nextPage, underBase } from "./service-api-manifest.js"

const listPosts: ManifestOperation = {
  id: "list-posts",
  command: "list-posts",
  binding: { kind: "http", method: "GET", path: "/wp/v2/posts" },
  effect: "read",
  tags: [],
  parameters: [{ name: "page", in: "query", required: false, schema: { type: "integer" } }],
  pagination: {
    style: "page",
    page: { in: "query", name: "page" },
    items: "",
    start: 1,
    pagesHeader: "x-wp-totalpages",
  },
}
const createPost: ManifestOperation = {
  ...listPosts,
  id: "create-post",
  command: "create-post",
  binding: { kind: "http", method: "POST", path: "/wp/v2/posts" },
  effect: "write",
}
const input = { path: {}, query: {}, headers: {}, fields: {} }

describe("a source's read through the manifest", () => {
  it("gives the headers with the body, where WordPress counts its pages, and stops at the last", async () => {
    const asked: string[] = []
    const call = serviceApiCall({
      manifest: { operations: [listPosts, createPost], servers: [{ url: "https://host.test/blog/wp-json" }] },
      service: "WordPress",
      fetch: async (url) => {
        asked.push(String(url))
        return Response.json([{ id: 1 }], { headers: { "X-WP-TotalPages": "2" } })
      },
    })
    const first = await call.withHeaders("list-posts", input)
    expect(first.body).toEqual([{ id: 1 }])
    const step = nextPage(
      listPosts.pagination as NonNullable<ManifestOperation["pagination"]>,
      input,
      first.body,
      first.headers,
    )
    expect(step).toEqual({ items: [{ id: 1 }], next: { input: { ...input, query: { page: "2" } } } })
    const last = nextPage(
      listPosts.pagination as NonNullable<ManifestOperation["pagination"]>,
      { ...input, query: { page: "2" } },
      first.body,
      first.headers,
    )
    expect(last).toEqual({ items: [{ id: 1 }] })
    expect(await call("list-posts", input)).toEqual([{ id: 1 }])
    expect(asked).toEqual(["https://host.test/blog/wp-json/wp/v2/posts", "https://host.test/blog/wp-json/wp/v2/posts"])
    await expect(call.withHeaders("create-post", input)).rejects.toMatchObject({ code: "configuration_error" })
  })

  it("follows no redirect with a site's sign-in, as the host is shared with other sites", async () => {
    const asked: { url: string; redirect: string | undefined }[] = []
    const call = serviceApiCall({
      manifest: {
        operations: [listPosts],
        servers: [{ url: "https://{site}/wp-json", variables: { site: {} } }],
        securitySchemes: { applicationPassword: { type: "http", scheme: "basic" } },
        security: [{ applicationPassword: [] }],
      },
      service: "WordPress",
      serverVariables: { site: "host.test/blog" },
      token: () => "editor:pw",
      fetch: async (url, init) => {
        asked.push({ url: String(url), redirect: init?.redirect })
        return new Response(null, { status: 302, headers: { location: "/other/wp-json/wp/v2/posts" } })
      },
    })
    await expect(call("list-posts", input)).rejects.toBeDefined()
    expect(asked).toEqual([{ url: "https://host.test/blog/wp-json/wp/v2/posts", redirect: "manual" }])
  })

  it("keeps a site's address by its path: host/blog never reaches host/other or host/blogx", () => {
    const base = "https://host.test/blog/wp-json"
    expect(underBase(new URL("https://host.test/blog/wp-json/wp/v2/posts?page=2"), base)).toBe(true)
    expect(underBase(new URL("https://host.test/other/wp-json/wp/v2/posts"), base)).toBe(false)
    expect(underBase(new URL("https://host.test/blog/wp-jsonx/posts"), base)).toBe(false)
    expect(underBase(new URL("https://evil.test/blog/wp-json/posts"), base)).toBe(false)
  })
})
