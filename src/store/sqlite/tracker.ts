import {
  type StateType,
  type TrackerKind,
  type TrackerRecords,
  trackerBodyOf,
  trackerParentOf,
  trackerTitleOf,
} from "../../domain/tracker.js"
import { START_LETTERS } from "../../search/stem.js"
import {
  clauseIn,
  type Probe,
  probeOf,
  type QueryWord,
  type StoredWord,
  tokensOf,
  wordMatches,
} from "../../search/word-match.js"
import type { CacheDatabase } from "../driver.js"
import { fold, normalize } from "../normalize.js"
import type { AccountKey } from "../types.js"
import { accountPk, findAccountPk } from "./accounts.js"
import { excerptOf } from "./crm-files.js"
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
  /** Issues only; several ids match any of them, as a name every team's state has. */
  assignee?: string | readonly string[] | null
  project?: string | readonly string[]
  state?: string | readonly string[]
  /** Issues whose state is of one of these types. */
  stateTypes?: readonly StateType[]
  label?: string | readonly string[]
  /** Issues only; `null`, the issues in no sprint. */
  sprint?: string | readonly string[] | null
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
   * the tracker stopped listing it comes back. A record the tracker calls `deleted` is marked deleted, and an issue
   * takes its comments with it. Answers how many changed: a row read again as it was stored is not counted.
   */
  save<K extends TrackerKind>(
    key: AccountKey,
    kind: K,
    records: readonly TrackerRecords[K][],
    now: number,
  ): Promise<number>
  /**
   * After a complete list of the kind's ids: marks deleted every stored one the list lacks that has not been synced
   * since `before`, so a row saved while the list was read is never taken for a deleted one, and the comments of an
   * issue it marks. Answers how many of the kind.
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
  /**
   * Issues, projects and comments by their words. `capped`: the index offered more rows than are read for one search,
   * so a later row holding the words may be left out; `hasMore` is set while the page found any.
   */
  find(search: TrackerSearch): Promise<{ items: TrackerHit[]; hasMore: boolean; capped?: true }>
  /** Live rows of the kind, archived ones included. */
  count(key: AccountKey, kind: TrackerKind): Promise<number>
  /** The tracker users among `users` whose e-mail, in any letter case, an identity linked to one person has. */
  people(key: AccountKey, users: readonly string[]): Promise<TrackerPerson[]>
  /**
   * Before embedding: drops the chunks of issues, projects and comments the tracker no longer lists, and cuts those
   * of live ones saved before they were searched by meaning. `save` and `removeUnlisted` keep the rest in step.
   */
  refreshChunks(options?: { until?: () => boolean }): Promise<{ dropped: number; added: number; left: boolean }>
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
/** How many rows the index may offer one search; each is read and its words checked. */
const CANDIDATES = 2_000
const PAGE = 200

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

const keyOf = (data: unknown): string | undefined =>
  data == null ? undefined : (JSON.parse(String(data)) as { key?: string }).key

const ISSUE_FIELDS = { assignee: "assignee", project: "project", state: "state", sprint: "sprint" } as const

/**
 * Marks the live comments of these issues deleted with them; a comment of a trashed issue is only archived in Linear,
 * and would stay found under an issue that is gone.
 */
const deleteComments = (database: CacheDatabase, accountId: number, issues: readonly string[], now: number) => {
  if (!issues.length) return
  const ids = database
    .prepare(
      "UPDATE tracker_items SET deleted_at = ? WHERE account_id = ? AND kind = 'comment' AND deleted_at IS NULL " +
        "AND parent_id IN (SELECT value FROM json_each(?)) RETURNING id",
    )
    .all(now, accountId, JSON.stringify(issues))
    .map((row) => Number(row.id))
  dropTrackerChunks(database, ids)
}

/**
 * The words as clauses for `clauseIn`, and the index expression that finds the rows they could match: a word, a word
 * it begins, or a word that begins with its stem. A Snowball stem begins its word, but for the English `y` it turns to
 * `i` (`compani`), so a stem ending in `i` is looked up without it.
 */
const queryOf = (words: readonly string[], exact: boolean) => {
  const seen = new Set<string>()
  const clauses: QueryWord[][] = words
    .map((word) => tokensOf(word).filter((token) => fold(token)))
    .filter((tokens) => {
      const key = tokens.map(fold).join(" ")
      if (!tokens.length || seen.has(key)) return false
      seen.add(key)
      return true
    })
    .map((tokens) => tokens.map((token) => [probeOf(token)]))
  if (!clauses.length) return undefined
  const termOf = ({ literal, stems }: Probe) => {
    const terms = new Set([exact || literal.length < START_LETTERS ? `"${literal}"` : `"${literal}"*`])
    if (!exact)
      for (const stem of stems) {
        const start = stem.endsWith("i") ? stem.slice(0, -1) : stem
        if (start.length >= 3) terms.add(`"${start}"*`)
      }
    return terms.size > 1 ? `(${[...terms].join(" OR ")})` : [...terms].join("")
  }
  const expressions = clauses.map((clause) => `(${clause.flatMap((word) => word.map(termOf)).join(" AND ")})`)
  return { clauses, match: (anyWord: boolean) => expressions.join(anyWord ? " OR " : " AND ") }
}

export const trackerStoreOver = (context: StoreContext): TrackerStore => {
  const { database } = context

  const save = <K extends TrackerKind>(key: AccountKey, kind: K, records: readonly TrackerRecords[K][], now: number) =>
    write(database, () => {
      const accountId = accountPk(context, key)
      const stored = database.prepare(
        "SELECT data, title, body, deleted_at FROM tracker_items WHERE account_id = ? AND kind = ? AND external_id = ?",
      )
      const issueDeletedAt = database.prepare(
        "SELECT deleted_at FROM tracker_items WHERE account_id = ? AND kind = 'issue' AND external_id = ?",
      )
      const reviveComments = database.prepare(
        "UPDATE tracker_items SET deleted_at = NULL WHERE account_id = ? AND kind = 'comment' AND parent_id = ? " +
          "AND deleted_at = ?",
      )
      let changed = 0
      const scope = database.prepare("SELECT scope FROM accounts WHERE id = ?").get(accountId)?.scope
      const chunked = isChunkedTrackerKind(kind)
      const chunk = trackerChunkWriter(database)
      const released: string[] = []
      const comments = database.prepare(
        "SELECT id, title, body, coalesce(source_updated_at, synced_at) AS at FROM tracker_items " +
          "WHERE account_id = ? AND kind = 'comment' AND parent_id = ? AND deleted_at IS NULL",
      )
      const upsert = database.prepare(
        "INSERT INTO tracker_items (account_id, kind, external_id, parent_id, title, title_folded, body, " +
          "normalized_text, data, source_created_at, source_updated_at, archived_at, deleted_at, synced_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
          "ON CONFLICT (account_id, kind, external_id) DO UPDATE SET parent_id = excluded.parent_id, " +
          "title = excluded.title, title_folded = excluded.title_folded, body = excluded.body, " +
          "normalized_text = excluded.normalized_text, data = excluded.data, " +
          "source_created_at = excluded.source_created_at, source_updated_at = excluded.source_updated_at, " +
          "archived_at = excluded.archived_at, deleted_at = CASE WHEN excluded.deleted_at IS NULL THEN NULL " +
          "ELSE coalesce(tracker_items.deleted_at, excluded.deleted_at) END, synced_at = excluded.synced_at " +
          "RETURNING id, deleted_at",
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
        const data = JSON.stringify(merged)
        // A comment saved under a deleted issue goes with it: Linear lists it as archived, not deleted.
        const parentGone =
          kind === "comment"
            ? issueDeletedAt.get(accountId, (merged as TrackerRecords["comment"]).issue ?? null)?.deleted_at
            : undefined
        const deletedAt = merged.deleted === true ? now : parentGone == null ? null : Number(parentGone)
        const saved = upsert.get(
          accountId,
          kind,
          merged.externalId,
          trackerParentOf(kind, merged) ?? null,
          title,
          fold(title),
          body,
          normalize([title, body].filter(Boolean).join("\n")),
          data,
          merged.createdAt ?? null,
          merged.updatedAt ?? null,
          merged.archivedAt ?? null,
          deletedAt,
          now,
        )
        const gone = saved?.deleted_at != null
        if (!before || before.data !== data || (before.deleted_at != null) !== gone) changed += 1
        if (gone) {
          if (before?.deleted_at == null) {
            if (chunked) dropTrackerChunks(database, [Number(saved?.id)])
            if (kind === "issue") deleteComments(database, accountId, [merged.externalId], Number(saved?.deleted_at))
          }
          continue
        }
        if (kind === "issue" && before?.deleted_at != null)
          reviveComments.run(accountId, merged.externalId, Number(before.deleted_at))
        // Most rows of a sync come back with the text they had; their chunks stay, and only a revived row needs new.
        const same = before?.deleted_at == null && before?.title === title && (before?.body ?? null) === body
        // A comment is embedded after its issue's key and title, so a new, revived, renamed or moved issue cuts its
        // comments again.
        if (
          kind === "issue" &&
          (before?.deleted_at !== null ||
            before.title !== title ||
            keyOf(before.data) !== (merged as TrackerRecords["issue"]).key)
        )
          for (const row of comments.all(accountId, merged.externalId)) {
            const freed = chunk(
              {
                id: Number(row.id),
                accountId,
                kind: "comment",
                title: String(row.title),
                body: row.body == null ? null : String(row.body),
                parent: merged.externalId,
                occurredAt: Number(row.at),
                scope: scope == null ? null : String(scope),
              },
              now,
            )
            for (const hash of freed?.released ?? []) released.push(hash)
          }
        if (!chunked || same) continue
        const freed = chunk(
          {
            id: Number(saved?.id),
            accountId,
            kind,
            title,
            body,
            parent: trackerParentOf(kind, merged) ?? null,
            occurredAt: merged.updatedAt ?? now,
            scope: scope == null ? null : String(scope),
          },
          now,
        )
        for (const hash of freed?.released ?? []) released.push(hash)
      }
      dropUnusedVectors(database, released)
      return changed
    })

  /**
   * Linear moves no `updatedAt` when an issue leaves the trash, so the id pass listing a deleted row again is the
   * only sign it is back. A comment stays deleted while its issue is: Linear lists a trashed issue's comments.
   */
  const restoreListed = (accountId: number, kind: TrackerKind, listed: readonly string[]) => {
    const found = database
      .prepare(
        "SELECT t.id, t.external_id, t.deleted_at FROM tracker_items t WHERE t.account_id = ? AND t.kind = ? " +
          "AND t.deleted_at IS NOT NULL AND t.external_id IN (SELECT value FROM json_each(?)) " +
          "AND (t.kind <> 'comment' OR NOT EXISTS (SELECT 1 FROM tracker_items i WHERE i.account_id = t.account_id " +
          "AND i.kind = 'issue' AND i.external_id = t.parent_id AND i.deleted_at IS NOT NULL))",
      )
      .all(accountId, kind, JSON.stringify(listed))
    const restore = database.prepare(
      "UPDATE tracker_items SET deleted_at = NULL, data = CASE WHEN json_extract(data, '$.deleted') IS NULL " +
        "THEN data ELSE json_set(data, '$.deleted', json('false')) END WHERE id = ?",
    )
    const comments = database.prepare(
      "UPDATE tracker_items SET deleted_at = NULL WHERE account_id = ? AND kind = 'comment' AND parent_id = ? " +
        "AND deleted_at = ?",
    )
    for (const row of found) {
      restore.run(Number(row.id))
      if (kind === "issue") comments.run(accountId, String(row.external_id), Number(row.deleted_at))
    }
  }

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
      const issues: string[] = []
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
          if (kind === "issue") issues.push(String(row.external_id))
        }
        removed += 1
      }
      if (isChunkedTrackerKind(kind)) dropTrackerChunks(database, marked)
      deleteComments(database, accountId, issues, now)
      if (!dryRun) restoreListed(accountId, kind, listed)
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
        const ids = typeof value === "string" ? [value] : value
        sql += ids.length ? ` AND json_extract(t.data, '$.${field}') IN (${ids.map(() => "?").join(", ")})` : " AND 0"
        for (const id of ids) params.push(id)
      }
    }
    if (filter.label !== undefined) {
      const ids = typeof filter.label === "string" ? [filter.label] : filter.label
      sql += ids.length
        ? ` AND EXISTS (SELECT 1 FROM json_each(t.data, '$.labels') l WHERE l.value IN (${ids.map(() => "?").join(", ")}))`
        : " AND 0"
      for (const id of ids) params.push(id)
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
    const query = queryOf(words, exact)
    if (!query) return { items: [], hasMore: false }
    const most = Math.min(Math.max(limit ?? 100, 1), MOST)
    const scoped = accounts?.map((one) => findAccountPk(context, one)).filter((one) => one !== undefined) ?? []
    if (accounts !== undefined && !scoped.length) return { items: [], hasMore: false }
    const params: (string | number)[] = [query.match(anyWord)]
    let sql =
      "SELECT t.id FROM tracker_items t " +
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
    sql += " ORDER BY w.rank, t.source_updated_at DESC, t.id DESC LIMIT ?"
    // One read of the index for the ids, then the rows in pages: paging the ranked query by OFFSET ranks it again for
    // every page.
    const ids = database
      .prepare(sql)
      .all(...params, CANDIDATES + 1)
      .map(({ id }) => Number(id))
    const capped = ids.length > CANDIDATES
    const rowsOf = database.prepare(
      `SELECT ${COLUMNS}, t.id, t.title, t.body, a.provider, a.external_id AS account FROM tracker_items t ` +
        "JOIN accounts a ON a.id = t.account_id WHERE t.id IN (SELECT value FROM json_each(?))",
    )
    const wanted = offset + most + 1
    const found: { row: Row; held: StoredWord[]; hit: QueryWord[][]; score: number; at: number }[] = []
    let read = 0
    // Each candidate's own words decide. All words matched rank by the index alone, so the reading stops once the page
    // is full; some of them rank by how many matched first, over every candidate.
    for (let at = 0; at < Math.min(ids.length, CANDIDATES); at += PAGE) {
      if (!anyWord && found.length >= wanted) break
      const batch = ids.slice(at, Math.min(at + PAGE, CANDIDATES))
      const byId = new Map(rowsOf.all(JSON.stringify(batch)).map((row) => [Number(row.id), row]))
      for (const id of batch) {
        const row = byId.get(id)
        if (!row) continue
        read += 1
        const held = tokensOf([row.title, row.body].filter(Boolean).join("\n")).map((token) => ({
          token,
          literal: fold(token),
        }))
        const hit = query.clauses.filter((clause) => clauseIn(clause, held, exact))
        if (anyWord ? hit.length > 0 : hit.length === query.clauses.length)
          found.push({ row, held, hit, score: hit.length, at: read })
        if (!anyWord && found.length >= wanted) break
      }
    }
    const rows = found.sort((a, b) => b.score - a.score || a.at - b.at).slice(offset, wanted)
    return {
      items: rows.slice(0, most).map(({ row, held, hit }): TrackerHit => {
        const matched = held
          .filter((word) =>
            hit.some((clause) => clause.some((one) => one.some((probe) => wordMatches(probe, word, exact)))),
          )
          .map(({ token }) => token)
        return {
          account: { provider: String(row.provider), account: String(row.account) },
          item: itemOf(row),
          excerpt: excerptOf([row.title, row.body].filter(Boolean).join("\n"), [...words, ...matched]),
        }
      }),
      // A capped search may hold more past what was read; an empty page ends the paging.
      hasMore: rows.length > most || (capped && rows.length > 0),
      ...(capped ? { capped: true as const } : {}),
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
    refreshChunks: async ({ until } = {}) => refreshTrackerChunks(database, context.now(), until),
    chunksToEmbed: async (model, options) => trackerChunksToEmbed(database, model, options, context.now()),
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
