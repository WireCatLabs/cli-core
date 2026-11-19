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
  it("keeps the status a refusal's details name, without the service's text", async () => {
    // WordPress 6.9.4 to an author who lists pages with a private status (checked on a local site, 2026-11-19).
    const wordpress = {
      code: "rest_invalid_param",
      message: "Invalid parameter(s): status",
      data: {
        status: 400,
        params: { status: "Status is forbidden." },
        details: { status: { code: "rest_forbidden_status", message: "Status is forbidden.", data: { status: 403 } } },
      },
    }
    let answer: unknown = wordpress
    const call = serviceApiCall({
      manifest: { operations: [listPosts], servers: [{ url: "https://host.test/wp-json" }] },
      service: "WordPress",
      fetch: async () => Response.json(answer, { status: 400 }),
    })
    const refused = await call("list-posts", input).catch((error: unknown) => error)
    expect(refused).toMatchObject({ code: "validation_error", details: { status: 400, inner_status: 403 } })
    expect(JSON.stringify(refused)).not.toContain("forbidden")
    answer = { code: "rest_invalid_param", data: { status: 400 } }
    const plain = await call("list-posts", input).catch((error: unknown) => error)
    expect(plain).toMatchObject({ code: "validation_error" })
    expect((plain as { details: Record<string, unknown> }).details.inner_status).toBeUndefined()
  })

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
        servers: [{ url: "https://{site}/wp-json", variables: { site: { default: "" } } }],
        securitySchemes: { applicationPassword: { type: "http", scheme: "basic" } },
        security: [{ applicationPassword: [] }],
      },
      service: "WordPress",
      serverVariables: { site: "host.test/blog" },
      token: () => "editor:pw",
      fetch: async (url, init) => {
        asked.push({ url: String(url), redirect: init?.redirect })
        return new Response(null, {
          status: 302,
          headers: { location: "https://host.test/other/wp-json/wp/v2/posts?key=k" },
        })
      },
    })
    const refused = (await call("list-posts", input).catch((error: unknown) => error)) as Error
    // The owner sees where the site went, to sign in there if it moved; a key in its query stays out.
    expect(refused.message).toContain("moved list-posts to https://host.test/other/wp-json/wp/v2/posts (HTTP 302)")
    expect(refused.message).not.toContain("key=k")
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
