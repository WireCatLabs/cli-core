import {
  type StateType,
  type TrackerKind,
  type TrackerRecords,
  trackerBodyOf,
  trackerParentOf,
  trackerTitleOf,
} from "../../domain/tracker.js"
import type { CacheDatabase } from "../driver.js"
import { fold, normalize } from "../normalize.js"
import type { AccountKey } from "../types.js"
import { accountPk, findAccountPk } from "./accounts.js"
import { excerptOf, matchOf } from "./crm-files.js"
import type { StoreContext } from "./open.js"
import {
  dropTrackerChunks,
  isChunkedTrackerKind,
  nearestTrackerItems,
  refreshTrackerChunks,
  trackerChunksLeft,
  trackerChunksToEmbed,
  trackerChunkWriter,
  trackerEmbedded,
} from "./tracker-chunks.js"
import { write } from "./transaction.js"
import { dropUnusedVectors } from "./vector-index.js"

/** One stored tracker record with what the store keeps beside it. */
export interface TrackerItem<K extends TrackerKind = TrackerKind> {
  kind: K
  record: TrackerRecords[K]
  /** The tracker no longer lists it. */
  deletedAt: number | null
  syncedAt: number
}

/** What `list` narrows to; an issue filter names the tracker's ids, as the records hold them. */
export interface TrackerFilter {
  /** A comment's issue, an issue's, a state's or a label's team. */
  parent?: string
  /** Issues only. */
  assignee?: string | null
  project?: string
  state?: string
  /** Issues whose state is of one of these types. */
  stateTypes?: readonly StateType[]
  label?: string
  /** Archived rows too; absent, only the live ones. */
  archived?: boolean
  limit?: number
  offset?: number
}

export interface TrackerHit {
  account: AccountKey
  item: TrackerItem
  excerpt: string
}

export interface TrackerSearch {
  words: string[]
  anyWord?: boolean
  exact?: boolean
  /** Absent: every tracker account's. */
  accounts?: AccountKey[]
  kinds?: readonly TrackerKind[]
  limit?: number
  offset?: number
}

/** An issue, a project or a comment found by meaning: the cosine of its nearest chunk. */
export interface TrackerNearest {
  account: AccountKey
  item: TrackerItem
  score: number
}

/** A tracker user joined to the one person the store knows by the same e-mail. */
export interface TrackerPerson {
  user: string
  person: string
  name: string | null
}

export interface TrackerStore {
  /**
   * Upserts records of one kind; a field a record leaves out keeps its stored value, and a record listed again after
   * the tracker stopped listing it comes back. Answers how many were written.
   */
  save<K extends TrackerKind>(
    key: AccountKey,
    kind: K,
    records: readonly TrackerRecords[K][],
    now: number,
  ): Promise<number>
  /**
   * After a complete list of the kind's ids: marks deleted every stored one the list lacks that has not been synced
   * since `before`, so a row saved while the list was read is never taken for a deleted one. Answers how many.
   */
  removeUnlisted(
    key: AccountKey,
    kind: TrackerKind,
    listed: readonly string[],
    before: number,
    now: number,
    options?: { dryRun?: boolean },
  ): Promise<number>
  get<K extends TrackerKind>(key: AccountKey, kind: K, externalId: string): Promise<TrackerItem<K> | undefined>
  /** An issue by its readable key (`ENG-12`), in any letter case. */
  issueByKey(key: AccountKey, issueKey: string): Promise<TrackerItem<"issue"> | undefined>
  /** Live rows of a kind, newest change first; deleted ones never. */
  list<K extends TrackerKind>(
    key: AccountKey,
    kind: K,
    filter?: TrackerFilter,
  ): Promise<{ items: TrackerItem<K>[]; hasMore: boolean }>
  find(search: TrackerSearch): Promise<{ items: TrackerHit[]; hasMore: boolean }>
  /** Live rows of the kind, archived ones included. */
  count(key: AccountKey, kind: TrackerKind): Promise<number>
  /** The tracker users among `users` whose e-mail, in any letter case, an identity linked to one person has. */
  people(key: AccountKey, users: readonly string[]): Promise<TrackerPerson[]>
  /**
   * Before embedding: drops the chunks of issues, projects and comments the tracker no longer lists, and cuts those
   * of live ones saved before they were searched by meaning. `save` and `removeUnlisted` keep the rest in step.
   */
  refreshChunks(): Promise<{ dropped: number; added: number }>
  /** Live issues', projects' and comments' chunks with no vector of `model`, by hash from `after`, with their text. */
  chunksToEmbed(model: string, options: { after?: string; limit: number }): Promise<{ hash: string; text: string }[]>
  /** How many chunks `chunksToEmbed` would still give, at most. */
  chunksLeft(model: string): Promise<number>
  /** Whether a live item of these accounts has a vector of `model`. */
  embedded(model: string, accounts: readonly AccountKey[]): Promise<boolean>
  /**
   * Live issues, projects and comments of these accounts nearest in meaning to `query`, archived ones too, each by its
   * best chunk, best first. Vectors are unit length.
   */
  nearest(
    model: string,
    query: Float32Array,
    options: { limit: number; accounts: readonly AccountKey[] },
  ): Promise<TrackerNearest[]>
}

const MOST = 500

type Row = Record<string, unknown>

const itemOf = <K extends TrackerKind>(row: Row): TrackerItem<K> => ({
  kind: String(row.kind) as K,
  record: JSON.parse(String(row.data)) as TrackerRecords[K],
  deletedAt: row.deleted_at == null ? null : Number(row.deleted_at),
  syncedAt: Number(row.synced_at),
})

const COLUMNS = "t.kind, t.data, t.deleted_at, t.synced_at"

const definedOnly = (record: object): Record<string, unknown> =>
  Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined))

/** `store rebuild`: the normalized copies follow the current normalizer, then the word index is filled again. */
export const resetTrackerItemWords = (database: CacheDatabase): number => {
  if (!database.prepare("SELECT 1 FROM sqlite_master WHERE name = 'tracker_item_words'").get()) return 0
  return write(database, () => {
    const update = database.prepare("UPDATE tracker_items SET normalized_text = ? WHERE id = ?")
    for (const row of database.prepare("SELECT id, title, body, normalized_text FROM tracker_items").all()) {
      const normalized = normalize([row.title, row.body].filter(Boolean).join("\n"))
      if (normalized !== row.normalized_text) update.run(normalized, Number(row.id))
    }
    database.exec("INSERT INTO tracker_item_words (tracker_item_words) VALUES ('delete-all')")
    const { changes } = database
      .prepare(
        "INSERT INTO tracker_item_words (rowid, normalized_text) SELECT id, normalized_text FROM tracker_items " +
          "WHERE normalized_text <> ''",
      )
      .run()
    return Number(changes)
  })
}

const ISSUE_FIELDS = { assignee: "assignee", project: "project", state: "state" } as const

export const trackerStoreOver = (context: StoreContext): TrackerStore => {
  const { database } = context

  const save = <K extends TrackerKind>(key: AccountKey, kind: K, records: readonly TrackerRecords[K][], now: number) =>
    write(database, () => {
      const accountId = accountPk(context, key)
      const stored = database.prepare(
        "SELECT data FROM tracker_items WHERE account_id = ? AND kind = ? AND external_id = ?",
      )
      const scope = database.prepare("SELECT scope FROM accounts WHERE id = ?").get(accountId)?.scope
      const chunked = isChunkedTrackerKind(kind)
      const chunk = trackerChunkWriter(database)
      const released: string[] = []
      const upsert = database.prepare(
        "INSERT INTO tracker_items (account_id, kind, external_id, parent_id, title, title_folded, body, " +
          "normalized_text, data, source_created_at, source_updated_at, archived_at, deleted_at, synced_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?) " +
          "ON CONFLICT (account_id, kind, external_id) DO UPDATE SET parent_id = excluded.parent_id, " +
          "title = excluded.title, title_folded = excluded.title_folded, body = excluded.body, " +
          "normalized_text = excluded.normalized_text, data = excluded.data, " +
          "source_created_at = excluded.source_created_at, source_updated_at = excluded.source_updated_at, " +
          "archived_at = excluded.archived_at, deleted_at = NULL, synced_at = excluded.synced_at RETURNING id",
      )
      for (const record of records) {
        const before = stored.get(accountId, kind, record.externalId)
        // A field the tracker left out of this read keeps what the store knew: a read never erases by omission.
        const merged = {
          ...(before ? (JSON.parse(String(before.data)) as object) : {}),
          ...definedOnly(record),
        } as unknown as TrackerRecords[K]
        const title = trackerTitleOf(kind, merged)
        const body = trackerBodyOf(kind, merged) ?? null
        const saved = upsert.get(
          accountId,
          kind,
          merged.externalId,
          trackerParentOf(kind, merged) ?? null,
          title,
          fold(title),
          body,
          normalize([title, body].filter(Boolean).join("\n")),
          JSON.stringify(merged),
          merged.createdAt ?? null,
          merged.updatedAt ?? null,
          merged.archivedAt ?? null,
          now,
        )
        if (!chunked) continue
        const freed = chunk(
          {
            id: Number(saved?.id),
            accountId,
            kind,
            title,
            body,
            occurredAt: merged.updatedAt ?? now,
            scope: scope == null ? null : String(scope),
          },
          now,
        )
        for (const hash of freed ?? []) released.push(hash)
      }
      dropUnusedVectors(database, released)
      return records.length
    })

  const removeUnlisted = (
    key: AccountKey,
    kind: TrackerKind,
    listed: readonly string[],
    before: number,
    now: number,
    { dryRun = false }: { dryRun?: boolean } = {},
  ) => {
    const accountId = findAccountPk(context, key)
    if (accountId === undefined) return 0
    const keep = new Set(listed)
    return write(database, () => {
      const mark = database.prepare("UPDATE tracker_items SET deleted_at = ? WHERE id = ?")
      let removed = 0
      const marked: number[] = []
      for (const row of database
        .prepare(
          "SELECT id, external_id FROM tracker_items WHERE account_id = ? AND kind = ? AND deleted_at IS NULL " +
            "AND synced_at < ?",
        )
        .all(accountId, kind, before)) {
        if (keep.has(String(row.external_id))) continue
        if (!dryRun) {
          mark.run(now, Number(row.id))
          marked.push(Number(row.id))
        }
        removed += 1
      }
      if (isChunkedTrackerKind(kind)) dropTrackerChunks(database, marked)
      return removed
    })
  }

  const list = <K extends TrackerKind>(key: AccountKey, kind: K, filter: TrackerFilter = {}) => {
    const accountId = findAccountPk(context, key)
    if (accountId === undefined) return { items: [] as TrackerItem<K>[], hasMore: false }
    const limit = Math.min(Math.max(filter.limit ?? 100, 1), MOST)
    const params: (string | number)[] = [accountId, kind]
    let sql = `SELECT ${COLUMNS} FROM tracker_items t WHERE t.account_id = ? AND t.kind = ? AND t.deleted_at IS NULL`
    if (!filter.archived) sql += " AND t.archived_at IS NULL"
    if (filter.parent !== undefined) {
      sql += " AND t.parent_id = ?"
      params.push(filter.parent)
    }
    for (const [name, field] of Object.entries(ISSUE_FIELDS)) {
      const value = filter[name as keyof typeof ISSUE_FIELDS]
      if (value === undefined) continue
      if (value === null) sql += ` AND json_extract(t.data, '$.${field}') IS NULL`
      else {
        sql += ` AND json_extract(t.data, '$.${field}') = ?`
        params.push(value)
      }
    }
    if (filter.label !== undefined) {
      sql += " AND EXISTS (SELECT 1 FROM json_each(t.data, '$.labels') l WHERE l.value = ?)"
      params.push(filter.label)
    }
    if (filter.stateTypes?.length) {
      sql +=
        " AND EXISTS (SELECT 1 FROM tracker_items s WHERE s.account_id = t.account_id AND s.kind = 'state' " +
        `AND s.external_id = json_extract(t.data, '$.state') AND json_extract(s.data, '$.type') IN (${filter.stateTypes
          .map(() => "?")
          .join(", ")}))`
      for (const type of filter.stateTypes) params.push(type)
    }
    sql += " ORDER BY coalesce(t.source_updated_at, t.synced_at) DESC, t.id DESC LIMIT ? OFFSET ?"
    params.push(limit + 1, filter.offset ?? 0)
    const rows = database.prepare(sql).all(...params)
    return { items: rows.slice(0, limit).map((row) => itemOf<K>(row)), hasMore: rows.length > limit }
  }

  const find = ({ words, anyWord = false, exact = false, accounts, kinds, limit, offset = 0 }: TrackerSearch) => {
    const match = matchOf(words, anyWord, exact)
    if (!match) return { items: [], hasMore: false }
    const most = Math.min(Math.max(limit ?? 100, 1), MOST)
    const scoped = accounts?.map((one) => findAccountPk(context, one)).filter((one) => one !== undefined) ?? []
    if (accounts !== undefined && !scoped.length) return { items: [], hasMore: false }
    const params: (string | number)[] = [match]
    let sql =
      `SELECT ${COLUMNS}, t.title, t.body, a.provider, a.external_id AS account FROM tracker_items t ` +
      "JOIN accounts a ON a.id = t.account_id " +
      "JOIN (SELECT rowid, rank FROM tracker_item_words WHERE tracker_item_words MATCH ?) w ON w.rowid = t.id " +
      "WHERE t.deleted_at IS NULL"
    if (accounts !== undefined) {
      sql += ` AND t.account_id IN (${scoped.map(() => "?").join(", ")})`
      for (const id of scoped) params.push(id)
    }
    if (kinds?.length) {
      sql += ` AND t.kind IN (${kinds.map(() => "?").join(", ")})`
      for (const kind of kinds) params.push(kind)
    }
    sql += " ORDER BY w.rank, t.source_updated_at DESC, t.id DESC LIMIT ? OFFSET ?"
    params.push(most + 1, offset)
    const rows = database.prepare(sql).all(...params)
    return {
      items: rows.slice(0, most).map(
        (row): TrackerHit => ({
          account: { provider: String(row.provider), account: String(row.account) },
          item: itemOf(row),
          excerpt: excerptOf([row.title, row.body].filter(Boolean).join("\n"), words),
        }),
      ),
      hasMore: rows.length > most,
    }
  }

  const accountIdsOf = (accounts: readonly AccountKey[]) =>
    accounts.flatMap((one) => {
      const id = findAccountPk(context, one)
      return id === undefined ? [] : [{ id, key: { provider: one.provider, account: one.account } }]
    })

  const nearest = (model: string, query: Float32Array, limit: number, accounts: readonly AccountKey[]) => {
    const item = database.prepare(`SELECT ${COLUMNS} FROM tracker_items t WHERE t.id = ?`)
    return accountIdsOf(accounts)
      .flatMap(({ id, key }) =>
        nearestTrackerItems(database, model, query, { accountId: id, limit }).flatMap(({ owner, score }) => {
          const row = item.get(owner)
          return row ? [{ account: key, item: itemOf(row), score }] : []
        }),
      )
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
  }

  return {
    save: async (key, kind, records, now) => save(key, kind, records, now),
    removeUnlisted: async (key, kind, listed, before, now, options) =>
      removeUnlisted(key, kind, listed, before, now, options),
    get: async <K extends TrackerKind>(key: AccountKey, kind: K, externalId: string) => {
      const accountId = findAccountPk(context, key)
      if (accountId === undefined) return undefined
      const row = database
        .prepare(`SELECT ${COLUMNS} FROM tracker_items t WHERE t.account_id = ? AND t.kind = ? AND t.external_id = ?`)
        .get(accountId, kind, externalId)
      return row ? itemOf<K>(row) : undefined
    },
    issueByKey: async (key, issueKey) => {
      const accountId = findAccountPk(context, key)
      if (accountId === undefined) return undefined
      const row = database
        .prepare(
          `SELECT ${COLUMNS} FROM tracker_items t WHERE t.account_id = ? AND t.kind = 'issue' ` +
            "AND upper(json_extract(t.data, '$.key')) = upper(?) ORDER BY t.deleted_at IS NOT NULL LIMIT 1",
        )
        .get(accountId, issueKey)
      return row ? itemOf<"issue">(row) : undefined
    },
    list: async (key, kind, filter) => list(key, kind, filter),
    find: async (search) => find(search),
    count: async (key, kind) => {
      const accountId = findAccountPk(context, key)
      if (accountId === undefined) return 0
      return Number(
        database
          .prepare("SELECT count(*) AS n FROM tracker_items WHERE account_id = ? AND kind = ? AND deleted_at IS NULL")
          .get(accountId, kind)?.n ?? 0,
      )
    },
    people: async (key, users) => {
      const accountId = findAccountPk(context, key)
      if (accountId === undefined || users.length === 0) return []
      return database
        .prepare(
          "SELECT u.external_id AS user, p.id AS person, p.name AS name FROM tracker_items u " +
            "JOIN identities i ON i.email IS NOT NULL AND lower(i.email) = lower(json_extract(u.data, '$.email')) " +
            "JOIN identity_links l ON l.identity_id = i.id JOIN persons p ON p.id = l.person_id " +
            `WHERE u.account_id = ? AND u.kind = 'user' AND u.external_id IN (${users.map(() => "?").join(", ")}) ` +
            // Two persons behind one address say nothing about which one this user is.
            "GROUP BY u.external_id HAVING count(DISTINCT p.id) = 1 ORDER BY u.external_id",
        )
        .all(accountId, ...users)
        .map((row) => ({
          user: String(row.user),
          person: `person:${String(row.person)}`,
          name: row.name == null ? null : String(row.name),
        }))
    },
    refreshChunks: async () => refreshTrackerChunks(database, context.now()),
    chunksToEmbed: async (model, options) => trackerChunksToEmbed(database, model, options),
    chunksLeft: async (model) => trackerChunksLeft(database, model),
    embedded: async (model, accounts) =>
      trackerEmbedded(
        database,
        model,
        accountIdsOf(accounts).map(({ id }) => id),
      ),
    nearest: async (model, query, { limit, accounts }) => nearest(model, query, limit, accounts),
  }
}
