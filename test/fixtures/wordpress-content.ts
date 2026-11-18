import { readFileSync } from "node:fs"
import { CliError } from "@wirecat/cli-base"
import {
  adaptOpenApi,
  generate,
  type ManifestOperation,
  manifestGenerator,
  wpJsonToOpenApi,
} from "@wirecat/cli-base/codegen"
import type { ApiCommandInput } from "../../src/cli/bot/api.js"
import type { ServiceApiManifest } from "../../src/cli/service-api-manifest.js"

// The routes of posts, pages, tags, categories and users from a plain WordPress 6.9.4 (see wp-json/LICENSE).
const index = JSON.parse(readFileSync(new URL("./wp-json/wp-json-content.json", import.meta.url), "utf8"))

const LISTS = new Set(["getWpV2Posts", "getWpV2Pages", "getWpV2Tags", "getWpV2Categories", "getWpV2Users"])

/**
 * The generated API manifest of those routes, as a WordPress CLI's `pnpm generate` writes it. Collections page by
 * `page` and `per_page`, the answer itself the list: what cli-base's wp-json overrides set on every collection read.
 */
export const wordpressApi = (): ServiceApiManifest => {
  const { document } = wpJsonToOpenApi(index, { namespaces: ["wp/v2"], site: "example.com", version: "6.9.4" })
  const [file] = generate(adaptOpenApi(document), [manifestGenerator({ path: "manifest.ts" })], { banner: [] })
  const content = file?.content ?? ""
  const start = content.indexOf("=", content.indexOf("export const operations")) + 1
  const end = content.indexOf("\n\nexport const", start)
  const operations = (JSON.parse(content.slice(start, end < 0 ? undefined : end)) as ManifestOperation[]).map((one) =>
    LISTS.has(one.id)
      ? {
          ...one,
          pagination: {
            style: "page" as const,
            page: { in: "query" as const, name: "page" },
            limit: { in: "query" as const, name: "per_page" },
            items: "",
            pagesHeader: "x-wp-totalpages",
          } as ManifestOperation["pagination"],
        }
      : one,
  )
  return {
    operations,
    servers: [{ url: "https://{site}/wp-json", variables: { site: { default: "example.com" } } }],
    securitySchemes: { basic: { type: "http", scheme: "basic" } },
    security: [{ basic: [] }],
  }
}

const STATUSES = "publish,future,draft,pending,private,trash"
const per = 100

const posts = (operation: string, type: string) => {
  const list = { operation, query: { context: "edit", status: STATUSES, per_page: per, orderby: "id", order: "asc" } }
  return {
    list,
    changes: {
      operation,
      query: { ...list.query, orderby: "modified", modified_after: "{since}" },
      since: "iso",
      keyset: { field: "modified_gmt" },
    },
    ids: { operation, query: { context: "edit", status: STATUSES, per_page: per, orderby: "id", _fields: "id" } },
    get: { operation: `${operation}ById`, path: { id: "{id}" }, query: { context: "edit" } },
    map: {
      externalId: "id",
      type: { value: type },
      title: "title.raw",
      excerpt: "excerpt.raw",
      url: "link",
      slug: "slug",
      status: {
        path: "status",
        map: {
          publish: "published",
          future: "scheduled",
          draft: "draft",
          pending: "pending",
          private: "private",
          trash: "trashed",
        },
      },
      publishedAt: "date_gmt",
      scheduledFor: "date_gmt",
      updatedAt: "modified_gmt",
      version: "modified_gmt",
      authors: "author",
      terms: { all: ["tags", "categories"] },
    },
    body: { path: "content.raw", format: "wp-blocks", fallback: { path: "content.rendered", format: "html" } },
    optional: { message: "the sign-in may not read every post: a contributor sees its own", scope: "edit_others_posts" },
  }
}

/** WordPress as a content source, in configuration only: no hook. */
export const WORDPRESS_CONTENT = {
  provider: "wordpress",
  kinds: ["author", "term", "post"],
  channel: { kind: "blog", network: "wordpress" },
  entities: {
    author: [
      {
        list: { operation: "getWpV2Users", query: { context: "edit", per_page: per, orderby: "id" } },
        get: { operation: "getWpV2UsersById", path: { id: "{id}" }, query: { context: "edit" } },
        map: { externalId: "id", name: "name", email: "email", slug: "slug" },
        optional: { message: "only an editor or administrator lists the users", scope: "list_users" },
      },
    ],
    term: [
      {
        list: { operation: "getWpV2Tags", query: { context: "edit", per_page: per, orderby: "id" } },
        get: { operation: "getWpV2TagsById", path: { id: "{id}" }, query: { context: "edit" } },
        map: { externalId: "id", kind: { value: "tag" }, name: "name", slug: "slug" },
      },
      {
        list: { operation: "getWpV2Categories", query: { context: "edit", per_page: per, orderby: "id" } },
        get: { operation: "getWpV2CategoriesById", path: { id: "{id}" }, query: { context: "edit" } },
        map: { externalId: "id", kind: { value: "category" }, name: "name", slug: "slug" },
      },
    ],
    post: [posts("getWpV2Posts", "post"), posts("getWpV2Pages", "page")],
  },
  writes: {
    create: { operation: "postWpV2Posts", body: { status: "draft" } },
    update: { operation: "postWpV2PostsById", path: { id: "{id}" } },
    trash: { operation: "deleteWpV2PostsById", path: { id: "{id}" } },
    delete: { operation: "deleteWpV2PostsById", path: { id: "{id}" }, query: { force: true } },
    fields: {
      title: "title",
      body: "content",
      excerpt: "excerpt",
      slug: "slug",
      terms: { tag: "tags", category: "categories" },
    },
    publish: { status: "publish" },
    schedule: { status: "future", date_gmt: "{at}" },
    unpublish: { status: "draft" },
  },
}

type Row = Record<string, unknown>

export interface WordpressFakeOptions {
  /** Each read page holds at most this many rows, whatever `per_page` asks: a small page cuts lists. */
  pageSize?: number
  /** The site's clock, in ms. */
  clock?: () => number
  /** A contributor: others' drafts and the trash are refused with 403, as WordPress refuses `status=trash`. */
  contributor?: number
}

const gmt = (ms: number) => new Date(ms).toISOString().slice(0, 19)

/**
 * A WordPress site in memory, answering the generated operations as WordPress does: `context=edit` fields, statuses
 * named in a comma list, `modified_after` strictly after, a page past the last empty with `X-WP-TotalPages` saying how
 * many there are, 404 for a post deleted for good, the trash a status, and `force=true` deleting for good.
 */
export const wordpressFake = (options: WordpressFakeOptions = {}) => {
  let tick = 0
  const clock = options.clock ?? (() => Date.UTC(2026, 10, 17) + tick++ * 1000)
  const size = options.pageSize ?? 2
  let made = 100
  let lose = false
  const writes: string[] = []
  const users: Row[] = [
    { id: 1, name: "Ada Owner", slug: "ada", email: "ada@example.com" },
    { id: 2, name: "Bob Writer", slug: "bob", email: "bob@example.com" },
  ]
  const tags: Row[] = [{ id: 7, name: "Releases", slug: "releases", taxonomy: "post_tag" }]
  const categories: Row[] = [{ id: 1, name: "News", slug: "news", parent: 0, taxonomy: "category" }]
  const T0 = Date.UTC(2026, 10, 1)
  const post = (id: number, type: string, status: string, title: string, html: string, at: number, extra: Row = {}) => ({
    id,
    type,
    status,
    slug: title.toLowerCase().replaceAll(" ", "-"),
    link: `https://example.com/${type === "page" ? "" : "blog/"}${id}`,
    date_gmt: status === "draft" ? null : gmt(at),
    modified_gmt: gmt(at),
    title: { raw: title, rendered: title },
    content: { raw: html, rendered: html.replace(/<!--[^>]*-->/g, "") },
    excerpt: { raw: "", rendered: "" },
    author: 1,
    tags: [],
    categories: [1],
    ...extra,
  })
  const rows: Row[] = [
    post(10, "post", "publish", "Version 2 is out", "<!-- wp:paragraph --><p>We shipped <strong>version 2</strong>.</p><!-- /wp:paragraph -->", T0 + 10_000, { tags: [7] }),
    post(11, "post", "draft", "Draft about pricing", "<p>Prices change in December.</p>", T0 + 20_000, { author: 2 }),
    post(12, "page", "publish", "About", "<p>Who we are.</p>", T0 + 30_000, { categories: [] }),
  ]
  const typeOf = (operation: string) => (operation.includes("Pages") ? "page" : "post")
  const visible = (row: Row) =>
    options.contributor === undefined || row.author === options.contributor || row.status === "publish"
  const notFound = () => new CliError("not_found", "Invalid post ID.", { reason: "rest_post_invalid_id" })
  const forbidden = () => new CliError("permission_error", "Sorry, you are not allowed to do that.")
  const page = (list: readonly Row[], input: ApiCommandInput) => {
    const at = Number(input.query.page ?? 1)
    const pages = Math.max(1, Math.ceil(list.length / size))
    const body = list.slice((at - 1) * size, at * size)
    return { body, headers: new Headers({ "x-wp-totalpages": String(pages), "x-wp-total": String(list.length) }) }
  }
  const read = (operation: string, input: ApiCommandInput): { body: unknown; headers: Headers } => {
    if (operation === "getWpV2Users") return page(users, input)
    if (operation === "getWpV2Tags") return page(tags, input)
    if (operation === "getWpV2Categories") return page(categories, input)
    if (operation === "getWpV2UsersById" || operation === "getWpV2TagsById" || operation === "getWpV2CategoriesById") {
      const list = operation.includes("Users") ? users : operation.includes("Tags") ? tags : categories
      const found = list.find((one) => String(one.id) === input.path.id)
      if (!found) throw notFound()
      return { body: structuredClone(found), headers: new Headers() }
    }
    if (operation === "getWpV2PostsById" || operation === "getWpV2PagesById") {
      const found = rows.find((one) => String(one.id) === input.path.id && one.type === typeOf(operation))
      if (!found || !visible(found)) throw notFound()
      return { body: structuredClone(found), headers: new Headers() }
    }
    if (operation === "getWpV2Posts" || operation === "getWpV2Pages") {
      const statuses = (input.query.status ?? "publish").split(",")
      if (options.contributor !== undefined && statuses.includes("trash")) throw forbidden()
      const after = input.query.modified_after ? Date.parse(input.query.modified_after) : null
      if (after !== null && Number.isNaN(after)) throw new CliError("validation_error", "Invalid date.")
      const by = input.query.orderby === "modified" ? "modified_gmt" : "id"
      const list = rows
        .filter((one) => one.type === typeOf(operation) && statuses.includes(String(one.status)) && visible(one))
        .filter((one) => after === null || Date.parse(`${one.modified_gmt}Z`) > after)
        .sort((a, b) => String(a[by]).localeCompare(String(b[by]), undefined, { numeric: true }))
        .map((one) => (input.query._fields === "id" ? { id: one.id } : structuredClone(one)))
      return page(list, input)
    }
    throw new CliError("configuration_error", `the fake WordPress does not answer ${operation}`)
  }
  const stamp = (row: Row) => {
    row.modified_gmt = gmt(clock())
  }
  const write = (operation: string, input: ApiCommandInput): unknown => {
    writes.push(operation)
    const body = input.body ? (JSON.parse(input.body) as Row) : {}
    const apply = (row: Row) => {
      for (const [field, value] of Object.entries(body)) {
        if (field === "title" || field === "excerpt") row[field] = { raw: value, rendered: value }
        else if (field === "content") row.content = { raw: value, rendered: value }
        else if (field === "tags" || field === "categories") row[field] = (value as unknown[]).map(Number)
        else row[field] = value
      }
      // WordPress publishes a future post whose date has passed, and dates a published post now.
      if (row.status === "future" && Date.parse(`${String(row.date_gmt).replace(/Z$/, "")}Z`) <= clock()) row.status = "publish"
      if (row.status === "publish" && !row.date_gmt) row.date_gmt = gmt(clock())
      if (typeof row.date_gmt === "string") row.date_gmt = row.date_gmt.replace(/Z$/, "")
      stamp(row)
    }
    let answer: unknown
    if (operation === "postWpV2Posts") {
      made += 1
      const row = post(made, "post", "draft", "", "", clock(), { categories: [] })
      apply(row)
      rows.push(row)
      answer = structuredClone(row)
    } else {
      const row = rows.find((one) => String(one.id) === input.path.id && one.type === "post")
      if (!row) throw notFound()
      if (operation === "postWpV2PostsById") {
        apply(row)
        answer = structuredClone(row)
      } else if (operation === "deleteWpV2PostsById" && input.query.force === "true") {
        rows.splice(rows.indexOf(row), 1)
        answer = { deleted: true, previous: structuredClone(row) }
      } else if (operation === "deleteWpV2PostsById") {
        row.status = "trash"
        stamp(row)
        answer = structuredClone(row)
      } else throw new CliError("configuration_error", `the fake WordPress does not answer ${operation}`)
    }
    if (lose) {
      lose = false
      throw new CliError("outcome_unknown", "the connection dropped after WordPress got the write")
    }
    return answer
  }
  const call = Object.assign(async (operation: string, input: ApiCommandInput) => read(operation, input).body, {
    withHeaders: async (operation: string, input: ApiCommandInput) => read(operation, input),
  })
  return {
    call,
    write: async (_command: unknown, operation: string, input: ApiCommandInput) => ({ operation_id: `op-${writes.length}`, result: write(operation, input) }),
    writes,
    rows,
    touch(id: number) {
      const row = rows.find((one) => one.id === id)
      if (row) stamp(row)
    },
    trash(id: number) {
      const row = rows.find((one) => one.id === id)
      if (row) {
        row.status = "trash"
        stamp(row)
      }
    },
    remove(id: number) {
      const at = rows.findIndex((one) => one.id === id)
      if (at >= 0) rows.splice(at, 1)
    },
    loseNextAnswer() {
      lose = true
    },
  }
}
