import { CliError } from "@wirecat/cli-base"
import type { ContentChannel, ContentKind, ContentMetric, ContentPost, ContentRecords } from "../../domain/content.js"
import type { ContentCallContext, ContentChanges, ContentIdPage, ContentSource } from "../source.js"
import { type ContentWriter, contentConflict } from "../writer.js"

const OVERLAP_MS = 10 * 60_000

export type FakeContentRows = { [K in ContentKind]?: ContentRecords[K][] }

export interface FakeContentSourceOptions {
  rows: FakeContentRows
  channel?: ContentChannel
  /** The source's own clock, which stamps `updatedAt`; this computer's is `skew` off it. */
  clock?: () => number
  skew?: number
  pageSize?: number
  provider?: string
  /** Numbers per post id; absent, the source has no metrics. */
  metrics?: Record<string, Omit<ContentMetric, "post" | "at">>
  /**
   * A sign-in that sees only its own posts, as a WordPress contributor: the others' drafts and the trash are refused,
   * and each read says so with a gap.
   */
  only?: { author: string }
}

export interface FakeContentSource extends ContentSource {
  readonly writer: ContentWriter
  /** The rows behind it, shared by every source made over them. */
  readonly rows: FakeContentRows
  /** Changes one row on the source's side: it gets a new `updatedAt`. */
  touch(kind: ContentKind, externalId: string): void
  /** Moves a post to the trash on the source's side, as its own action would. */
  trashed(externalId: string): void
  /** Deletes one row for good, as only an id pass or a read finds. */
  remove(kind: ContentKind, externalId: string): void
  /** A scheduled post goes out by the source's own timer, without a new modified time. */
  elapse(externalId: string): void
  /** The site answers from another address, as a moved or replaced site does. */
  move(url: string): void
  /** The same source read from a computer whose clock is `ms` off. */
  skewed(ms: number): FakeContentSource
  /** Each write request that reached the source, by verb. */
  readonly requests: string[]
  /** How many times each post went from not published to published. */
  readonly publishes: Map<string, number>
  /** The next write is done at the source, and its answer is lost. */
  loseNextAnswer(): void
}

const T0 = Date.UTC(2026, 10, 1)

/**
 * A blog in memory, read the way WordPress is: changes by `updatedAt` from the cursor less an overlap, every status
 * listed with trash among them, pages by offset, a post deleted for good gone from `ids()` and answered `null` by `get`.
 * It also takes writes, checking each one's version.
 */
export const fakeContentSource = (options: FakeContentSourceOptions): FakeContentSource => {
  let tick = 0
  const clock = options.clock ?? (() => Date.UTC(2026, 10, 17) + tick++ * 1000)
  const rows = options.rows
  const size = options.pageSize ?? 2
  let channel: ContentChannel = options.channel ?? {
    externalId: "site",
    kind: "blog",
    network: "fake-blog",
    name: "Example blog",
    url: "https://blog.example.com",
  }
  const requests: string[] = []
  const publishes = new Map<string, number>()
  let lose = false
  let made = 0
  const listOf = <K extends ContentKind>(kind: K): ContentRecords[K][] => {
    rows[kind] ??= []
    return rows[kind] as ContentRecords[K][]
  }
  const find = <K extends ContentKind>(kind: K, externalId: string) =>
    listOf(kind).find((one) => one.externalId === externalId)
  const visible = (kind: ContentKind, row: { externalId: string }) => {
    if (!options.only || kind !== "post") return true
    const post = row as ContentPost
    return post.authors?.includes(options.only.author) || post.status === "published"
  }
  const gapOf = (kind: ContentKind, context?: ContentCallContext) => {
    if (options.only && kind === "post")
      context?.gap({ kind, message: "the sign-in sees only its own drafts and no trash", scope: "edit_others_posts" })
  }
  const postOf = (externalId: string) => {
    const found = find("post", externalId)
    if (!found) throw new CliError("not_found", `the fake blog has no post ${externalId}`)
    return found
  }
  const versionOf = (post: ContentPost) => String(post.updatedAt ?? 0)
  /** One write: checked against the version, stamped, and its answer lost when asked. */
  const write = (verb: string, post: ContentPost, version: string | null | undefined, change: () => void) => {
    requests.push(verb)
    if (version != null && version !== versionOf(post)) throw contentConflict()
    const was = post.status
    change()
    post.updatedAt = clock()
    post.version = versionOf(post)
    if (was !== "published" && post.status === "published")
      publishes.set(post.externalId, (publishes.get(post.externalId) ?? 0) + 1)
    if (lose) {
      lose = false
      throw new CliError("outcome_unknown", "the connection dropped after the source got the write")
    }
    return { ...post }
  }

  const writer: ContentWriter = {
    provider: options.provider ?? "fake-blog",
    async createDraft(draft, { operationId: _ }) {
      made += 1
      const post: ContentPost = {
        externalId: `new-${made}`,
        type: draft.type ?? "post",
        title: draft.title ?? null,
        body: draft.body ?? "",
        excerpt: draft.excerpt ?? null,
        slug: draft.slug ?? null,
        status: "draft",
        terms: draft.terms ?? [],
        authors: [],
        createdAt: clock(),
      }
      listOf("post").push(post)
      return write("create", post, null, () => {})
    },
    async update(externalId, patch, { version }) {
      const post = postOf(externalId)
      return write("update", post, version, () => {
        for (const [field, value] of Object.entries(patch))
          if (value !== undefined) (post as unknown as Record<string, unknown>)[field] = value
      })
    },
    async publish(externalId, { version }) {
      const post = postOf(externalId)
      if (post.status === "published") return { ...post }
      return write("publish", post, version, () => {
        post.status = "published"
        post.publishedAt = clock()
        post.scheduledFor = null
      })
    },
    async schedule(externalId, at, { version }) {
      const post = postOf(externalId)
      return write("schedule", post, version, () => {
        post.status = "scheduled"
        post.scheduledFor = at
      })
    },
    async unpublish(externalId, { version }) {
      const post = postOf(externalId)
      return write("unpublish", post, version, () => {
        post.status = "draft"
        post.scheduledFor = null
      })
    },
    async trash(externalId, { version, force }) {
      const post = postOf(externalId)
      if (force) {
        requests.push("delete")
        if (version != null && version !== versionOf(post)) throw contentConflict()
        listOf("post").splice(listOf("post").indexOf(post), 1)
        return null
      }
      return write("trash", post, version, () => {
        post.status = "trashed"
      })
    },
  }

  const make = (skew: number): FakeContentSource => ({
    provider: options.provider ?? "fake-blog",
    traits: {
      kinds: (["author", "term", "post"] as const).filter((kind) => listOf(kind).length > 0),
      metrics: options.metrics !== undefined,
    },
    writer,
    rows,
    requests,
    publishes,
    async channels() {
      return [{ ...channel }]
    },
    async changes<K extends ContentKind>(
      kind: K,
      cursor: string | null,
      page?: string,
      context?: ContentCallContext,
    ): Promise<ContentChanges<ContentRecords[K]>> {
      const since = cursor === null ? null : Date.parse(cursor)
      if (since !== null && Number.isNaN(since)) return { reset: true }
      const [offsetText, startedText] = (page ?? "").split("@")
      const offset = page === undefined ? 0 : Number(offsetText)
      const started = page === undefined ? clock() + skew : Number(startedText)
      if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(started))
        throw new CliError("validation_error", `not a page of the fake blog: ${page}`)
      gapOf(kind, context)
      const listed = listOf(kind)
        .filter((one) => visible(kind, one))
        .filter((one) => since === null || (one.updatedAt ?? 0) >= since - OVERLAP_MS)
        .sort((a, b) => (a.updatedAt ?? 0) - (b.updatedAt ?? 0) || a.externalId.localeCompare(b.externalId))
      const items = listed.slice(offset, offset + size).map((one) => structuredClone(one))
      const next = offset + size
      return next < listed.length
        ? { items, hasMore: true, nextCursor: `${next}@${started}` }
        : { items, hasMore: false, cursor: new Date(started).toISOString() }
    },
    async ids(kind: ContentKind, page?: string, context?: ContentCallContext): Promise<ContentIdPage> {
      gapOf(kind, context)
      const offset = page === undefined ? 0 : Number(page)
      const all = listOf(kind)
        .filter((one) => visible(kind, one))
        .map((one) => one.externalId)
      const items = all.slice(offset, offset + size)
      return offset + size < all.length
        ? { items, hasMore: true, nextCursor: String(offset + size) }
        : { items, hasMore: false }
    },
    async get<K extends ContentKind>(kind: K, externalId: string) {
      const found = find(kind, externalId)
      return found && visible(kind, found) ? (structuredClone(found) as ContentRecords[K]) : null
    },
    ...(options.metrics
      ? {
          async metrics(posts: readonly string[]) {
            const at = clock()
            return posts.flatMap((post) => {
              const numbers = options.metrics?.[post]
              return numbers ? [{ post, at, ...numbers }] : []
            })
          },
        }
      : {}),
    touch(kind, externalId) {
      const found = find(kind, externalId)
      if (!found) throw new Error(`the fake blog has no ${kind} ${externalId}`)
      found.updatedAt = clock()
      if (kind === "post") (found as ContentPost).version = String(found.updatedAt)
    },
    trashed(externalId) {
      const post = postOf(externalId)
      post.status = "trashed"
      post.updatedAt = clock()
    },
    remove(kind, externalId) {
      const list = listOf(kind) as { externalId: string }[]
      const at = list.findIndex((one) => one.externalId === externalId)
      if (at < 0) throw new Error(`the fake blog has no ${kind} ${externalId}`)
      list.splice(at, 1)
    },
    elapse(externalId) {
      const post = postOf(externalId)
      post.status = "published"
      post.publishedAt = post.scheduledFor ?? clock()
    },
    move(url) {
      channel = { ...channel, url }
    },
    skewed: (ms) => make(ms),
    loseNextAnswer() {
      lose = true
    },
  })
  return make(options.skew ?? 0)
}

/** A small blog: two authors, a tag and a category, and posts in every status but trash. */
export const exampleContentRows = (): Required<FakeContentRows> => ({
  author: [
    { externalId: "1", name: "Ada Owner", email: "ada@example.com", slug: "ada", updatedAt: T0 },
    { externalId: "2", name: "Bob Writer", email: "bob@example.com", slug: "bob", updatedAt: T0 + 1 },
  ],
  term: [
    { externalId: "tag-7", kind: "tag", name: "Releases", slug: "releases", updatedAt: T0 },
    { externalId: "cat-1", kind: "category", name: "News", slug: "news", updatedAt: T0 },
  ],
  post: [
    {
      externalId: "10",
      type: "post",
      title: "Version 2 is out",
      body: "We shipped **version 2**.",
      status: "published",
      url: "https://blog.example.com/version-2",
      slug: "version-2",
      publishedAt: T0 + 5,
      authors: ["1"],
      terms: ["tag-7", "cat-1"],
      createdAt: T0,
      updatedAt: T0 + 10,
      version: String(T0 + 10),
    },
    {
      externalId: "11",
      type: "post",
      title: "Draft about pricing",
      body: "Prices change in December.",
      status: "draft",
      authors: ["2"],
      terms: [],
      createdAt: T0,
      updatedAt: T0 + 20,
      version: String(T0 + 20),
    },
    {
      externalId: "12",
      type: "page",
      title: "About",
      body: "Who we are.",
      status: "published",
      publishedAt: T0,
      authors: ["1"],
      terms: [],
      createdAt: T0,
      updatedAt: T0 + 30,
      version: String(T0 + 30),
    },
  ],
})
