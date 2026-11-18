import { createHash } from "node:crypto"
import { isCliError } from "@wirecat/cli-base"
import type {
  ContentChannel,
  ContentKind,
  ContentMetric,
  ContentPost,
  ContentRecords,
  PostStatus,
  PostType,
} from "../../domain/content.js"
import { tagOf } from "../../domain/tags.js"
import type { CacheDatabase } from "../driver.js"
import { fold, normalize } from "../normalize.js"
import type { AccountKey } from "../types.js"
import { accountPk, findAccountPk } from "./accounts.js"
import { excerptOf, matchOf } from "./crm-files.js"
import type { StoreContext } from "./open.js"
import { addTags, ensureTag } from "./tags.js"
import { write } from "./transaction.js"

/** One stored record with what the store keeps beside it. */
export interface ContentItem<K extends ContentKind = ContentKind> {
  kind: K
  record: ContentRecords[K]
  /** Gone from a complete list of the source's ids. A trashed post is not deleted: its status says so. */
  deletedAt: number | null
  syncedAt: number
}

/** What replaced a stored post's text or status: a sync, a write of the owner's, or the source deleting it. */
export type RevisionReason = "sync" | "write" | "deleted"

/** A post as it stood before a change; the newest first. */
export interface ContentRevision {
  title: string | null
  body: string | null
  status: PostStatus
  contentHash: string
  version: string | null
  reason: RevisionReason
  createdAt: number
}

export interface ContentFilter {
  channel?: string
  statuses?: readonly PostStatus[]
  type?: PostType
  /** A term's id at the source. */
  term?: string
  /** An author's id at the source. */
  author?: string
  /** Published at or after; epoch ms. */
  since?: number
  /** Published before; epoch ms. */
  until?: number
  limit?: number
  offset?: number
}

export interface ContentHit {
  account: AccountKey
  item: ContentItem<"post">
  excerpt: string
}

export interface ContentSearch {
  words: string[]
  anyWord?: boolean
  exact?: boolean
  /** Absent: every content account's. */
  accounts?: AccountKey[]
  limit?: number
  offset?: number
}

/** An author joined to the one person the store knows by the same e-mail. */
export interface ContentPerson {
  author: string
  person: string
  name: string | null
}

export interface ContentStore {
  saveChannels(key: AccountKey, channels: readonly ContentChannel[], now: number): Promise<number>
  channels(key: AccountKey): Promise<ContentChannel[]>
  /**
   * Upserts records of one kind; a field a record leaves out keeps its stored value, and a record listed again after
   * it was marked deleted comes back. A post whose title, text or status changes keeps what it had as a revision.
   */
  save<K extends ContentKind>(
    key: AccountKey,
    kind: K,
    records: readonly ContentRecords[K][],
    now: number,
    options?: { reason?: Exclude<RevisionReason, "deleted"> },
  ): Promise<number>
  /**
   * After a complete list of the kind's ids: marks deleted every stored one the list lacks that was not synced since
   * `before`. A post keeps its last text as a revision. Answers how many.
   */
  removeUnlisted(
    key: AccountKey,
    kind: ContentKind,
    listed: readonly string[],
    before: number,
    now: number,
    options?: { dryRun?: boolean },
  ): Promise<number>
  /** Marks one record deleted, as a read that answered "no such post" proves. */
  markDeleted(key: AccountKey, kind: ContentKind, externalId: string, now: number): Promise<boolean>
  get<K extends ContentKind>(key: AccountKey, kind: K, externalId: string): Promise<ContentItem<K> | undefined>
  /** Live rows, newest change first; deleted ones never. Post filters apply to posts only. */
  list<K extends ContentKind>(
    key: AccountKey,
    kind: K,
    filter?: ContentFilter,
  ): Promise<{ items: ContentItem<K>[]; hasMore: boolean }>
  find(search: ContentSearch): Promise<{ items: ContentHit[]; hasMore: boolean }>
  count(key: AccountKey, kind: ContentKind): Promise<number>
  /** Scheduled posts whose time has passed: the source may have published them without changing their mark. */
  due(key: AccountKey, now: number): Promise<string[]>
  revisions(key: AccountKey, post: string): Promise<ContentRevision[]>
  saveMetrics(key: AccountKey, metrics: readonly ContentMetric[]): Promise<number>
  /** Every reading of a post's numbers, the newest first. */
  metrics(key: AccountKey, post: string, limit?: number): Promise<ContentMetric[]>
  people(key: AccountKey, authors: readonly string[]): Promise<ContentPerson[]>
}

const MOST = 500

type Row = Record<string, unknown>

const TABLE: Record<ContentKind, string> = {
  author: "content_authors",
  term: "content_terms",
  post: "content_posts",
}

const definedOnly = (record: object): Record<string, unknown> =>
  Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined))

const itemOf = <K extends ContentKind>(kind: K, row: Row): ContentItem<K> => ({
  kind,
  record: JSON.parse(String(row.data)) as ContentRecords[K],
  deletedAt: row.deleted_at == null ? null : Number(row.deleted_at),
  syncedAt: Number(row.synced_at),
})

/** The hash a post's text keeps: a change of either part is a new version. */
export const contentHashOf = (post: Pick<ContentPost, "title" | "body">): string =>
  createHash("sha256")
    .update(JSON.stringify([post.title ?? null, post.body ?? null]))
    .digest("hex")

/** `store rebuild`: the normalized copies follow the current normalizer, then the word index is filled again. */
export const resetContentPostWords = (database: CacheDatabase): number => {
  if (!database.prepare("SELECT 1 FROM sqlite_master WHERE name = 'content_post_words'").get()) return 0
  return write(database, () => {
    const update = database.prepare("UPDATE content_posts SET normalized_text = ? WHERE id = ?")
    for (const row of database.prepare("SELECT id, title, body, normalized_text FROM content_posts").all()) {
      const normalized = normalize([row.title, row.body].filter(Boolean).join("\n"))
      if (normalized !== row.normalized_text) update.run(normalized, Number(row.id))
    }
    database.exec("INSERT INTO content_post_words (content_post_words) VALUES ('delete-all')")
    const { changes } = database
      .prepare(
        "INSERT INTO content_post_words (rowid, normalized_text) SELECT id, normalized_text FROM content_posts " +
          "WHERE normalized_text <> ''",
      )
      .run()
    return Number(changes)
  })
}

/**
 * The shared tag a term stands for: by its slug, else its name. A name that is no valid tag, or that the vocabulary
 * review holds back as too close to another, links to none; the owner can add an alias.
 */
const tagIdOf = (context: StoreContext, term: ContentRecords["term"]): number | null => {
  const name = tagOf(term.slug ?? "") ?? tagOf(term.name)
  if (name === undefined) return null
  try {
    return ensureTag(context, name).id
  } catch (error) {
    if (isCliError(error)) return null
    throw error
  }
}

export const contentStoreOver = (context: StoreContext): ContentStore => {
  const { database } = context

  const keepRevision = (postId: number, row: Row, reason: RevisionReason, now: number) =>
    database
      .prepare(
        "INSERT INTO content_post_revisions (post_id, title, body, status, content_hash, version, reason, created_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        postId,
        (row.title ?? null) as string | null,
        (row.body ?? null) as string | null,
        String(row.status),
        String(row.content_hash),
        (row.version ?? null) as string | null,
        reason,
        now,
      )

  /** A post's tags follow its terms: the ones the source states, never the owner's own. */
  const tagPost = (accountId: number, postId: number, terms: readonly string[]) => {
    const ids = terms.length
      ? database
          .prepare(
            `SELECT DISTINCT t.name FROM content_terms ct JOIN canonical_tags t ON t.id = ct.tag_id ` +
              `WHERE ct.account_id = ? AND ct.deleted_at IS NULL AND ct.external_id IN (${terms.map(() => "?").join(", ")})`,
          )
          .all(accountId, ...terms)
          .map((row) => String(row.name))
      : []
    database
      .prepare(
        "DELETE FROM taggings WHERE taggable_type = 'post' AND taggable_id = ? AND source = 'file' " +
          "AND tag_id NOT IN (SELECT t.id FROM canonical_tags t JOIN json_each(?) j ON j.value = t.name)",
      )
      .run(postId, JSON.stringify(ids))
    if (ids.length) addTags(context, { type: "post", id: postId }, ids, "file")
  }

  const savePost = (accountId: number, record: ContentPost, before: Row | undefined, now: number, reason: string) => {
    const merged = {
      ...(before ? (JSON.parse(String(before.data)) as object) : {}),
      ...definedOnly(record),
    } as unknown as ContentPost
    const title = merged.title ?? null
    const body = merged.body ?? null
    const hash = contentHashOf(merged)
    if (before && (before.content_hash !== hash || before.status !== merged.status || before.title !== title))
      keepRevision(Number(before.id), before, reason as RevisionReason, now)
    const row = database
      .prepare(
        "INSERT INTO content_posts (account_id, external_id, channel_id, type, title, title_folded, body, content_hash, " +
          "status, published_at, scheduled_for, source_created_at, source_updated_at, version, normalized_text, data, " +
          "deleted_at, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?) " +
          "ON CONFLICT (account_id, external_id) DO UPDATE SET channel_id = excluded.channel_id, type = excluded.type, " +
          "title = excluded.title, title_folded = excluded.title_folded, body = excluded.body, " +
          "content_hash = excluded.content_hash, status = excluded.status, published_at = excluded.published_at, " +
          "scheduled_for = excluded.scheduled_for, source_created_at = excluded.source_created_at, " +
          "source_updated_at = excluded.source_updated_at, version = excluded.version, " +
          "normalized_text = excluded.normalized_text, data = excluded.data, deleted_at = NULL, " +
          "synced_at = excluded.synced_at RETURNING id",
      )
      .get(
        accountId,
        merged.externalId,
        merged.channel ?? null,
        merged.type ?? "post",
        title,
        fold(title ?? ""),
        body,
        hash,
        merged.status,
        merged.publishedAt ?? null,
        merged.scheduledFor ?? null,
        merged.createdAt ?? null,
        merged.updatedAt ?? null,
        merged.version ?? null,
        normalize([title, body].filter(Boolean).join("\n")),
        JSON.stringify(merged),
        now,
      )
    tagPost(accountId, Number(row?.id), merged.terms ?? [])
  }

  const save = <K extends ContentKind>(
    key: AccountKey,
    kind: K,
    records: readonly ContentRecords[K][],
    now: number,
    reason: string,
  ) =>
    write(database, () => {
      const accountId = accountPk(context, key)
      const stored = database.prepare(`SELECT * FROM ${TABLE[kind]} WHERE account_id = ? AND external_id = ?`)
      for (const record of records) {
        const before = stored.get(accountId, record.externalId)
        if (kind === "post") {
          savePost(accountId, record as ContentPost, before, now, reason)
          continue
        }
        const merged = {
          ...(before ? (JSON.parse(String(before.data)) as object) : {}),
          ...definedOnly(record),
        } as unknown as ContentRecords["author"] & ContentRecords["term"]
        if (kind === "author")
          database
            .prepare(
              "INSERT INTO content_authors (account_id, external_id, name, email, data, source_updated_at, deleted_at, " +
                "synced_at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?) ON CONFLICT (account_id, external_id) DO UPDATE SET " +
                "name = excluded.name, email = excluded.email, data = excluded.data, " +
                "source_updated_at = excluded.source_updated_at, deleted_at = NULL, synced_at = excluded.synced_at",
            )
            .run(
              accountId,
              merged.externalId,
              merged.name,
              merged.email ?? null,
              JSON.stringify(merged),
              merged.updatedAt ?? null,
              now,
            )
        else
          database
            .prepare(
              "INSERT INTO content_terms (account_id, external_id, kind, name, slug, parent_id, tag_id, data, " +
                "source_updated_at, deleted_at, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?) " +
                "ON CONFLICT (account_id, external_id) DO UPDATE SET kind = excluded.kind, name = excluded.name, " +
                "slug = excluded.slug, parent_id = excluded.parent_id, tag_id = excluded.tag_id, data = excluded.data, " +
                "source_updated_at = excluded.source_updated_at, deleted_at = NULL, synced_at = excluded.synced_at",
            )
            .run(
              accountId,
              merged.externalId,
              merged.kind,
              merged.name,
              merged.slug ?? null,
              merged.parent ?? null,
              tagIdOf(context, merged),
              JSON.stringify(merged),
              merged.updatedAt ?? null,
              now,
            )
      }
      return records.length
    })

  const mark = (accountId: number, kind: ContentKind, row: Row, now: number) => {
    if (kind === "post") {
      keepRevision(Number(row.id), row, "deleted", now)
      database
        .prepare("DELETE FROM taggings WHERE taggable_type = 'post' AND taggable_id = ? AND source = 'file'")
        .run(Number(row.id))
    }
    database
      .prepare(`UPDATE ${TABLE[kind]} SET deleted_at = ? WHERE id = ? AND account_id = ?`)
      .run(now, Number(row.id), accountId)
  }

  const removeUnlisted = (
    key: AccountKey,
    kind: ContentKind,
    listed: readonly string[],
    before: number,
    now: number,
    { dryRun = false }: { dryRun?: boolean } = {},
  ) => {
    const accountId = findAccountPk(context, key)
    if (accountId === undefined) return 0
    const keep = new Set(listed)
    return write(database, () => {
      let removed = 0
      for (const row of database
        .prepare(`SELECT * FROM ${TABLE[kind]} WHERE account_id = ? AND deleted_at IS NULL AND synced_at < ?`)
        .all(accountId, before)) {
        if (keep.has(String(row.external_id))) continue
        if (!dryRun) mark(accountId, kind, row, now)
        removed += 1
      }
      return removed
    })
  }

  const list = <K extends ContentKind>(key: AccountKey, kind: K, filter: ContentFilter = {}) => {
    const accountId = findAccountPk(context, key)
    if (accountId === undefined) return { items: [] as ContentItem<K>[], hasMore: false }
    const limit = Math.min(Math.max(filter.limit ?? 100, 1), MOST)
    const params: (string | number)[] = [accountId]
    let sql = `SELECT t.* FROM ${TABLE[kind]} t WHERE t.account_id = ? AND t.deleted_at IS NULL`
    if (kind === "post") {
      if (filter.channel !== undefined) {
        sql += " AND t.channel_id = ?"
        params.push(filter.channel)
      }
      if (filter.statuses?.length) {
        sql += ` AND t.status IN (${filter.statuses.map(() => "?").join(", ")})`
        params.push(...filter.statuses)
      }
      if (filter.type !== undefined) {
        sql += " AND t.type = ?"
        params.push(filter.type)
      }
      for (const [field, value] of [
        ["terms", filter.term],
        ["authors", filter.author],
      ] as const)
        if (value !== undefined) {
          sql += ` AND EXISTS (SELECT 1 FROM json_each(t.data, '$.${field}') j WHERE j.value = ?)`
          params.push(value)
        }
      if (filter.since !== undefined) {
        sql += " AND t.published_at >= ?"
        params.push(filter.since)
      }
      if (filter.until !== undefined) {
        sql += " AND t.published_at < ?"
        params.push(filter.until)
      }
    }
    sql += " ORDER BY coalesce(t.source_updated_at, t.synced_at) DESC, t.id DESC LIMIT ? OFFSET ?"
    params.push(limit + 1, filter.offset ?? 0)
    const rows = database.prepare(sql).all(...params)
    return { items: rows.slice(0, limit).map((row) => itemOf(kind, row)), hasMore: rows.length > limit }
  }

  const find = ({ words, anyWord = false, exact = false, accounts, limit, offset = 0 }: ContentSearch) => {
    const match = matchOf(words, anyWord, exact)
    if (!match) return { items: [], hasMore: false }
    const most = Math.min(Math.max(limit ?? 100, 1), MOST)
    const scoped = accounts?.map((one) => findAccountPk(context, one)).filter((one) => one !== undefined) ?? []
    if (accounts !== undefined && !scoped.length) return { items: [], hasMore: false }
    const params: (string | number)[] = [match]
    let sql =
      "SELECT t.*, a.provider, a.external_id AS account FROM content_posts t JOIN accounts a ON a.id = t.account_id " +
      "JOIN (SELECT rowid, rank FROM content_post_words WHERE content_post_words MATCH ?) w ON w.rowid = t.id " +
      "WHERE t.deleted_at IS NULL"
    if (accounts !== undefined) {
      sql += ` AND t.account_id IN (${scoped.map(() => "?").join(", ")})`
      params.push(...scoped)
    }
    sql += " ORDER BY w.rank, t.source_updated_at DESC, t.id DESC LIMIT ? OFFSET ?"
    params.push(most + 1, offset)
    const rows = database.prepare(sql).all(...params)
    return {
      items: rows.slice(0, most).map(
        (row): ContentHit => ({
          account: { provider: String(row.provider), account: String(row.account) },
          item: itemOf("post", row),
          excerpt: excerptOf([row.title, row.body].filter(Boolean).join("\n"), words),
        }),
      ),
      hasMore: rows.length > most,
    }
  }

  const postId = (key: AccountKey, post: string): number | undefined => {
    const accountId = findAccountPk(context, key)
    if (accountId === undefined) return undefined
    const row = database
      .prepare("SELECT id FROM content_posts WHERE account_id = ? AND external_id = ?")
      .get(accountId, post)
    return row ? Number(row.id) : undefined
  }

  return {
    saveChannels: async (key, channels, now) =>
      write(database, () => {
        const accountId = accountPk(context, key)
        const upsert = database.prepare(
          "INSERT INTO content_channels (account_id, external_id, kind, network, name, url, handle, deleted_at, " +
            "synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?) ON CONFLICT (account_id, external_id) DO UPDATE SET " +
            "kind = excluded.kind, network = excluded.network, name = excluded.name, url = excluded.url, " +
            "handle = excluded.handle, deleted_at = NULL, synced_at = excluded.synced_at",
        )
        for (const one of channels)
          upsert.run(
            accountId,
            one.externalId,
            one.kind,
            one.network,
            one.name,
            one.url ?? null,
            one.handle ?? null,
            now,
          )
        return channels.length
      }),
    channels: async (key) => {
      const accountId = findAccountPk(context, key)
      if (accountId === undefined) return []
      return database
        .prepare("SELECT * FROM content_channels WHERE account_id = ? AND deleted_at IS NULL ORDER BY id")
        .all(accountId)
        .map((row) => ({
          externalId: String(row.external_id),
          kind: String(row.kind) as ContentChannel["kind"],
          network: String(row.network),
          name: String(row.name),
          url: row.url == null ? null : String(row.url),
          handle: row.handle == null ? null : String(row.handle),
        }))
    },
    save: async (key, kind, records, now, options) => save(key, kind, records, now, options?.reason ?? "sync"),
    removeUnlisted: async (key, kind, listed, before, now, options) =>
      removeUnlisted(key, kind, listed, before, now, options),
    markDeleted: async (key, kind, externalId, now) => {
      const accountId = findAccountPk(context, key)
      if (accountId === undefined) return false
      return write(database, () => {
        const row = database
          .prepare(`SELECT * FROM ${TABLE[kind]} WHERE account_id = ? AND external_id = ? AND deleted_at IS NULL`)
          .get(accountId, externalId)
        if (!row) return false
        mark(accountId, kind, row, now)
        return true
      })
    },
    get: async <K extends ContentKind>(key: AccountKey, kind: K, externalId: string) => {
      const accountId = findAccountPk(context, key)
      if (accountId === undefined) return undefined
      const row = database
        .prepare(`SELECT * FROM ${TABLE[kind]} WHERE account_id = ? AND external_id = ?`)
        .get(accountId, externalId)
      return row ? itemOf(kind, row) : undefined
    },
    list: async (key, kind, filter) => list(key, kind, filter),
    find: async (search) => find(search),
    count: async (key, kind) => {
      const accountId = findAccountPk(context, key)
      if (accountId === undefined) return 0
      return Number(
        database
          .prepare(`SELECT count(*) AS n FROM ${TABLE[kind]} WHERE account_id = ? AND deleted_at IS NULL`)
          .get(accountId)?.n ?? 0,
      )
    },
    due: async (key, now) => {
      const accountId = findAccountPk(context, key)
      if (accountId === undefined) return []
      return database
        .prepare(
          "SELECT external_id FROM content_posts WHERE account_id = ? AND deleted_at IS NULL AND status = 'scheduled' " +
            "AND scheduled_for IS NOT NULL AND scheduled_for <= ? ORDER BY scheduled_for, id",
        )
        .all(accountId, now)
        .map((row) => String(row.external_id))
    },
    revisions: async (key, post) => {
      const id = postId(key, post)
      if (id === undefined) return []
      return database
        .prepare("SELECT * FROM content_post_revisions WHERE post_id = ? ORDER BY created_at DESC, id DESC")
        .all(id)
        .map((row) => ({
          title: row.title == null ? null : String(row.title),
          body: row.body == null ? null : String(row.body),
          status: String(row.status) as PostStatus,
          contentHash: String(row.content_hash),
          version: row.version == null ? null : String(row.version),
          reason: String(row.reason) as RevisionReason,
          createdAt: Number(row.created_at),
        }))
    },
    saveMetrics: async (key, metrics) =>
      write(database, () => {
        const insert = database.prepare(
          "INSERT INTO content_metrics (post_id, at, views, reactions, comments, shares, clicks, raw) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        let saved = 0
        for (const one of metrics) {
          const id = postId(key, one.post)
          if (id === undefined) continue
          insert.run(
            id,
            one.at,
            one.views ?? null,
            one.reactions ?? null,
            one.comments ?? null,
            one.shares ?? null,
            one.clicks ?? null,
            one.raw === undefined ? null : JSON.stringify(one.raw),
          )
          saved += 1
        }
        return saved
      }),
    metrics: async (key, post, limit = 100) => {
      const id = postId(key, post)
      if (id === undefined) return []
      return database
        .prepare("SELECT * FROM content_metrics WHERE post_id = ? ORDER BY at DESC, id DESC LIMIT ?")
        .all(id, Math.min(Math.max(limit, 1), MOST))
        .map((row) => ({
          post,
          at: Number(row.at),
          ...Object.fromEntries(
            (["views", "reactions", "comments", "shares", "clicks"] as const).flatMap((name) =>
              row[name] == null ? [] : [[name, Number(row[name])]],
            ),
          ),
          ...(row.raw == null ? {} : { raw: JSON.parse(String(row.raw)) as Record<string, unknown> }),
        }))
    },
    people: async (key, authors) => {
      const accountId = findAccountPk(context, key)
      if (accountId === undefined || authors.length === 0) return []
      return database
        .prepare(
          "SELECT u.external_id AS author, p.id AS person, p.name AS name FROM content_authors u " +
            "JOIN identities i ON i.email IS NOT NULL AND lower(i.email) = lower(u.email) " +
            "JOIN identity_links l ON l.identity_id = i.id JOIN persons p ON p.id = l.person_id " +
            `WHERE u.account_id = ? AND u.external_id IN (${authors.map(() => "?").join(", ")}) ` +
            // Two persons behind one address say nothing about which one this author is.
            "GROUP BY u.external_id HAVING count(DISTINCT p.id) = 1 ORDER BY u.external_id",
        )
        .all(accountId, ...authors)
        .map((row) => ({
          author: String(row.author),
          person: `person:${String(row.person)}`,
          name: row.name == null ? null : String(row.name),
        }))
    },
  }
}
