import { CliError } from "@wirecat/cli-base"
import type { EnvelopeOptions, EnvelopeRecord, EnvelopeSource, IngestError } from "../../domain/records.js"
import { pointerOf } from "../../domain/records.js"
import { accountPk } from "./accounts.js"
import type { StoreContext } from "./open.js"
import { codeOf, type Row } from "./record-projection.js"
import { isDerived } from "./record-relations.js"
import {
  noRelationships,
  noteError,
  type RelationshipCounts,
  type RelationshipNote,
  recordRelationshipsOver,
} from "./record-relationships.js"
import type { Flag, recordWritesOver } from "./record-writes.js"
import { outsideRehearsal, read, write } from "./transaction.js"

/** One line of a run: its place in the envelope or stream, the record, and why it was refused before the store. */
export interface RunItem {
  index: number
  record: EnvelopeRecord
  errors?: IngestError[]
}

export interface RunOptions {
  dryRun?: boolean
  /** Records per transaction, 1000 by default. */
  chunk?: number
  options?: EnvelopeOptions
  /** How many entries each list keeps, 1000 by default; counts stay exact. */
  limit?: number
  /**
   * Every refusal as it happens, the ones past `limit` too. It must not use the store: it runs inside the run's
   * transaction, and during a dry run its statements are refused (`store.dry-run`).
   */
  onIssue?: (error: IngestError) => void
}

export interface Unmatched {
  index: number
  key: string
  /** `record.ambiguous`, or `record.separated` when the owner told the one match apart from these identifiers. */
  reason: string
  /** The entities its identifiers point at: the owner says which one it is with `records link`. */
  candidates: string[]
}

export interface FlaggedRecord extends Flag {
  index: number
  key: string
  entity: string
}

export interface RecordsRun {
  created: number
  updated: number
  unchanged: number
  deleted: number
  refused: number
  errors: IngestError[]
  /** Proposals this run made or changed, also for records of earlier imports it completed. */
  proposed: string[]
  /** Kept, with no entity yet: the roles, or `fields.<key>`, whose target is not imported or has no entity. */
  waiting: { index: number; key: string; missing: string[] }[]
  /** A person, organization or project whose identifiers point at more than one entity. */
  unmatched: Unmatched[]
  /** Changed or deleted at the source after its entity was made. */
  flagged: FlaggedRecord[]
  /** Values that look like identifiers and were kept as data only: a phone without `+` and no `phone_region`. */
  ignored: { index: number; key: string; at: (string | number)[]; reason: string }[]
  /** What the records' relationships did to the links this account reports, each link counted once per run. */
  relationships: RelationshipCounts
  /** Taken, but not as the source put it: a relationship's word off its role list, kept as `source_role`. */
  notices: IngestError[]
  /** A list stopped at `limit`. */
  truncated: boolean
}

let runs = 0
const PAGE = 500

/**
 * Takes a stream of records per chunk, each chunk in one transaction. Duplicate keys are checked, and the receipt's
 * lists collected, in TEMP tables of this run, so memory holds one chunk whatever the stream's length.
 */
export const recordRunOver = (context: StoreContext, writes: ReturnType<typeof recordWritesOver>) => {
  const { database } = context
  const { writeOne, completeDependents, entityRef, missingOf } = writes
  const reported = recordRelationshipsOver(context)

  return async (
    source: EnvelopeSource,
    items: AsyncIterable<RunItem> | Iterable<RunItem>,
    { chunk = 1000, options = {}, limit = 1000, onIssue }: RunOptions,
  ): Promise<RecordsRun> => {
    runs += 1
    const table = `records_run_${runs}`
    const proposedTable = `records_run_${runs}_proposed`
    const linksTable = `records_run_${runs}_links`
    const notesTable = `records_run_${runs}_notes`
    database.exec(
      `CREATE TEMP TABLE ${table} (idx INTEGER NOT NULL, key TEXT NOT NULL UNIQUE, identity TEXT NOT NULL UNIQUE, ` +
        "record_id INTEGER, flagged TEXT, unmatched TEXT, ignored TEXT)",
    )
    database.exec(`CREATE INDEX temp.${table}_by_record ON ${table} (record_id)`)
    database.exec(`CREATE TEMP TABLE ${proposedTable} (ref TEXT PRIMARY KEY)`)
    // A link and a note are counted once per run however many chunks report them: an entity's set is whole each time.
    database.exec(`CREATE TEMP TABLE ${linksTable} (key TEXT PRIMARY KEY, outcome TEXT NOT NULL)`)
    database.exec(`CREATE TEMP TABLE ${notesTable} (key TEXT PRIMARY KEY)`)
    try {
      let truncated = false
      const errors: IngestError[] = []
      const notices: IngestError[] = []
      const counts = { created: 0, updated: 0, unchanged: 0, deleted: 0, refused: 0 }
      const outcome = database.prepare(
        `INSERT INTO temp.${linksTable} (key, outcome) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET outcome = ` +
          "CASE WHEN excluded.outcome = 'kept' AND outcome <> 'withdrawn' THEN outcome ELSE excluded.outcome END",
      )
      const noted = database.prepare(`INSERT OR IGNORE INTO temp.${notesTable} (key) VALUES (?)`)
      const placeOf = database.prepare(
        `SELECT run.idx, run.key, r.type, r.external_id FROM records r LEFT JOIN temp.${table} run ` +
          "ON run.record_id = r.id WHERE r.id = ?",
      )
      const issue = (error: IngestError) => {
        if (errors.length < limit) errors.push(error)
        else truncated = true
        if (onIssue) outsideRehearsal(() => onIssue(error))
      }
      const refused = (error: IngestError) => {
        counts.refused += 1
        issue(error)
      }
      const note = (one: RelationshipNote) => {
        if (noted.run(one.key).changes === 0) return
        const list = one.severity === "issue" ? errors : notices
        if (list.length >= limit && (one.severity === "notice" || !onIssue)) {
          truncated = true
          return
        }
        const row = one.record === null ? undefined : placeOf.get(one.record)
        const place = row && {
          ...(row.idx == null ? {} : { index: Number(row.idx), key: String(row.key) }),
          type: String(row.type),
          externalId: String(row.external_id),
        }
        if (one.severity === "issue") issue(noteError(one, place))
        // Only this envelope's records: an earlier batch's words were noticed when it came.
        else if (place?.index !== undefined) notices.push(noteError(one, place))
      }
      const proposed = (ref: string) => {
        database.prepare(`INSERT OR IGNORE INTO temp.${proposedTable} (ref) VALUES (?)`).run(ref)
      }
      const takeChunk = (batch: RunItem[]) =>
        write(database, () => {
          const key = { provider: source.provider, account: source.account }
          const accountId = accountPk(context, key)
          const complete: number[] = []
          const written: number[] = []
          const changed: number[] = []
          for (const { index, record, errors: before } of batch) {
            if (before?.length) {
              counts.refused += 1
              for (const error of before) issue(error)
              continue
            }
            const identity = `${record.type}\0${record.external_id}`
            if (database.prepare(`SELECT 1 FROM temp.${table} WHERE key = ?`).get(record.key)) {
              refused({
                pointer: pointerOf("records", index, "key"),
                code: "record.duplicate-key",
                message: "another record of this envelope has this key",
                key: record.key,
              })
              continue
            }
            if (database.prepare(`SELECT 1 FROM temp.${table} WHERE identity = ?`).get(identity)) {
              refused({
                pointer: pointerOf("records", index, "external_id"),
                code: "record.duplicate",
                message: `another record of this envelope is ${record.type} ${record.external_id}`,
                key: record.key,
              })
              continue
            }
            database
              .prepare(`INSERT INTO temp.${table} (idx, key, identity) VALUES (?, ?, ?)`)
              .run(index, record.key, identity)
            try {
              const done = write(database, () => writeOne(accountId, source, record, options, proposed))
              counts[done.status] += 1
              written.push(done.id)
              if (done.complete || done.status === "deleted") changed.push(done.id)
              database
                .prepare(
                  `UPDATE temp.${table} SET record_id = ?, flagged = ?, unmatched = ?, ignored = ? WHERE key = ?`,
                )
                .run(
                  done.id,
                  done.flagged === undefined ? null : JSON.stringify(done.flagged),
                  done.unmatched === undefined ? null : JSON.stringify(done.unmatched),
                  done.ignored?.length ? JSON.stringify(done.ignored) : null,
                  record.key,
                )
              if (done.complete) complete.push(done.id)
            } catch (error) {
              if (!(error instanceof CliError)) throw error
              const at = (error.details as { at?: string | (string | number)[] } | undefined)?.at ?? "fields"
              refused({
                pointer: pointerOf("records", index, ...[at].flat()),
                code: codeOf(error),
                message: error.message,
                key: record.key,
              })
            }
          }
          const made = (id: number) => {
            written.push(id)
            changed.push(id)
          }
          for (const id of complete) completeDependents(id, source, proposed, issue, made)
          reported.report(
            key,
            accountId,
            { records: written, changed },
            { onNote: note, onOutcome: (link, what) => outcome.run(link, what) },
          )
        })
      let batch: RunItem[] = []
      for await (const item of items) {
        batch.push(item)
        if (batch.length >= chunk) {
          takeChunk(batch)
          batch = []
        }
      }
      if (batch.length > 0) takeChunk(batch)
      return read(database, () => {
        // Read in pages by `idx` until the list is full: the driver offers no cursor, and a run may hold millions.
        const listed = <T>(from: string, where: string, of: (row: Row) => T | null, order = "run.idx"): T[] => {
          const kept: T[] = []
          for (let after = -1; ; ) {
            const rows = database
              .prepare(`${from} WHERE ${order} > ? ${where} ORDER BY ${order} LIMIT ${PAGE}`)
              .all(after)
            for (const row of rows) {
              const item = of(row)
              if (item === null) continue
              if (kept.length === limit) {
                truncated = true
                return kept
              }
              kept.push(item)
            }
            if (rows.length < PAGE) return kept
            after = Number((rows[rows.length - 1] as Row).position)
          }
        }
        const runRecords = `SELECT run.*, run.idx AS position, r.entity_type, r.entity_id FROM temp.${table} run JOIN records r ON r.id = run.record_id`
        const waiting = listed(
          runRecords,
          "AND r.entity_id IS NULL AND r.deleted_at IS NULL AND r.type NOT LIKE 'custom:%' AND run.unmatched IS NULL",
          (row) => {
            const missing = missingOf(Number(row.record_id))
            return missing === null ? null : { index: Number(row.idx), key: String(row.key), missing }
          },
        )
        const unmatched = listed(runRecords, "AND run.unmatched IS NOT NULL AND r.entity_id IS NULL", (row) => ({
          index: Number(row.idx),
          key: String(row.key),
          ...(JSON.parse(String(row.unmatched)) as { reason: string; candidates: string[] }),
        }))
        const flagged = listed(runRecords, "AND run.flagged IS NOT NULL", (row) => ({
          index: Number(row.idx),
          key: String(row.key),
          entity: entityRef(row.entity_type, row.entity_id) as string,
          ...(JSON.parse(String(row.flagged)) as Flag),
        }))
        const ignored: RecordsRun["ignored"] = []
        for (const row of listed(runRecords, "AND run.ignored IS NOT NULL", (one) => one))
          for (const one of JSON.parse(String(row.ignored)) as { at: (string | number)[]; reason: string }[])
            if (ignored.length < limit) ignored.push({ index: Number(row.idx), key: String(row.key), ...one })
            else truncated = true
        const relationshipsOf = (): RelationshipCounts => {
          const tally = noRelationships()
          for (const row of database
            .prepare(`SELECT outcome, count(*) AS n FROM temp.${linksTable} GROUP BY outcome`)
            .all())
            tally[String(row.outcome) as keyof RelationshipCounts] = Number(row.n)
          return tally
        }
        const proposedRefs = listed(
          `SELECT ref, rowid AS position FROM temp.${proposedTable}`,
          "",
          (row) => String(row.ref),
          "rowid",
        )
        return {
          ...counts,
          errors: errors.sort((a, b) => a.pointer.localeCompare(b.pointer, "en", { numeric: true })),
          proposed: proposedRefs,
          waiting,
          unmatched,
          flagged,
          ignored,
          relationships: relationshipsOf(),
          notices: notices.sort((a, b) => a.pointer.localeCompare(b.pointer, "en", { numeric: true })),
          truncated,
        }
      })
    } finally {
      database.exec(`DROP TABLE IF EXISTS temp.${table}`)
      database.exec(`DROP TABLE IF EXISTS temp.${proposedTable}`)
      database.exec(`DROP TABLE IF EXISTS temp.${linksTable}`)
      database.exec(`DROP TABLE IF EXISTS temp.${notesTable}`)
    }
  }
}

/** Where a waiting record's receipt entry points: its relations, or the field that names the missing record. */
export const waitingPointer = (index: number, missing: string[]): string => {
  if (missing.some((role) => !isDerived(role))) return pointerOf("records", index, "relations")
  const [, key] = (missing[0] as string).split(".")
  return pointerOf("records", index, "fields", key as string)
}
