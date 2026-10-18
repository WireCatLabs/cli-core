import { createHash } from "node:crypto"
import { CliError } from "@wirecat/cli-base"
import type {
  TagConsolidationOptions,
  TagConsolidationPreview,
  TagConsolidationStore,
} from "../../domain/tag-consolidation.js"
import type { StoreContext } from "./open.js"
import { read } from "./transaction.js"
import type { VocabularyCatalog } from "./vocabulary.js"

type Row = Record<string, unknown>
const selections = [
  ["taggings", "tag_id IN (?,?)"],
  ["aliases", "aliasable_type='tag' AND aliasable_id IN (?,?)"],
  ["auto_tag_claims", "tag_id IN (?,?)"],
  ["links", "(from_type='tag' AND from_id IN (?,?)) OR (to_type='tag' AND to_id IN (?,?))"],
] as const

const bounded = (value: number, max: number, field: string) => {
  if (!Number.isSafeInteger(value) || value < 1 || value > max)
    throw new CliError("validation_error", `${field} must be an integer from 1 to ${max}`)
  return value
}
const idOf = (value: string, field: string) => {
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)))
    throw new CliError("validation_error", `${field} must be a positive canonical tag id`)
  return Number(value)
}
const cancelled = (options: TagConsolidationOptions) => {
  if (options.signal?.aborted) throw new CliError("cancelled", "tag consolidation preview was cancelled")
}

export const tagConsolidationStoreOver = (
  context: StoreContext,
  catalog: () => VocabularyCatalog,
): TagConsolidationStore => ({
  previewTagConsolidation: async (options) => {
    if (!options || typeof options !== "object") throw new CliError("validation_error", "preview options are required")
    const allowed = new Set([
      "sourceId",
      "survivorId",
      "expectedVocabularyFingerprint",
      "maxRows",
      "maxReadBytes",
      "sampleLimit",
      "signal",
    ])
    for (const field of Object.keys(options))
      if (!allowed.has(field)) throw new CliError("validation_error", `unknown preview field: ${field}`)
    const source = idOf(options.sourceId, "sourceId")
    const survivor = idOf(options.survivorId, "survivorId")
    if (source === survivor) throw new CliError("validation_error", "sourceId and survivorId must differ")
    if (
      typeof options.expectedVocabularyFingerprint !== "string" ||
      !/^v1:all:all:[a-f0-9]{64}$/.test(options.expectedVocabularyFingerprint)
    )
      throw new CliError(
        "validation_error",
        "expectedVocabularyFingerprint must come from a complete unfiltered vocabulary preview",
      )
    const maxRows = bounded(options.maxRows ?? 5000, 20000, "maxRows")
    const maxReadBytes = bounded(options.maxReadBytes ?? 1024 * 1024, 16 * 1024 * 1024, "maxReadBytes")
    const limit = bounded(options.sampleLimit ?? 10, 100, "sampleLimit")
    cancelled(options)
    // The catalog and dependency rows must describe one SQLite snapshot, including when called inside a write.
    return read(context.database, () => {
      const current = catalog()
      if (current.fingerprint !== options.expectedVocabularyFingerprint)
        throw new CliError("configuration_error", "vocabulary changed since the preview", {
          reason: "vocabulary.stale",
        })
      const selected = [source, survivor].map((id) =>
        current.entries.find((entry) => entry.id === String(id) && entry.kind !== "project"),
      )
      if (selected.some((entry) => !entry)) throw new CliError("not_found", "a selected canonical tag is unavailable")
      if (selected.some((entry) => entry?.kind !== "tag"))
        throw new CliError("validation_error", "consolidation preview supports tags only")
      return previewRows(context, options, source, survivor, maxRows, maxReadBytes, limit, current)
    })
  },
})

const previewRows = (
  context: StoreContext,
  options: TagConsolidationOptions,
  source: number,
  survivor: number,
  maxRows: number,
  maxReadBytes: number,
  limit: number,
  catalog: VocabularyCatalog,
): TagConsolidationPreview => {
  const rows = new Map<string, Row[]>()
  let count = 0
  let readBytes = 0
  const hash = createHash("sha256").update(JSON.stringify([source, survivor, catalog.fingerprint]))
  for (const [table, where] of selections) {
    cancelled(options)
    const parameters = table === "links" ? [source, survivor, source, survivor] : [source, survivor]
    const columns = context.database
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .map((row) => String(row.name))
    // Six bytes cover JSON's longest single-byte escape; the remainder covers keys and punctuation.
    const estimate = columns
      .map((column) => `6*coalesce(length(CAST(${column} AS BLOB)),0)+${column.length + 16}`)
      .join("+")
    const totals = context.database
      .prepare(`SELECT count(*) AS count,coalesce(sum(${estimate}),0) AS bytes FROM ${table} WHERE ${where}`)
      .get(...parameters)
    const size = Number(totals?.count ?? 0)
    if (count + size > maxRows || Number(totals?.bytes ?? 0) + readBytes > maxReadBytes)
      throw new CliError(
        "validation_error",
        "tag dependencies exceed the preview budget; no partial preview was produced",
        { reason: "vocabulary.consolidation-over-budget", table },
      )
    const values = context.database
      .prepare(
        `SELECT * FROM ${table} WHERE ${where} ORDER BY ${table === "auto_tag_claims" ? "chat_id,tag_id" : "id"} LIMIT ?`,
      )
      .all(...parameters, maxRows + 1)
    const serialized = JSON.stringify(values)
    readBytes += Buffer.byteLength(serialized)
    count += values.length
    if (count > maxRows || readBytes > maxReadBytes)
      throw new CliError("validation_error", "tag dependencies exceed the preview budget", {
        reason: "vocabulary.consolidation-over-budget",
        table,
      })
    hash.update(JSON.stringify([table, values]))
    rows.set(table, values)
  }
  cancelled(options)
  const assignments = rows.get("taggings") ?? []
  const aliases = rows.get("aliases") ?? []
  const claims = rows.get("auto_tag_claims") ?? []
  const links = rows.get("links") ?? []
  const counts = (values: Row[], field: string) => ({
    source: values.filter((row) => Number(row[field]) === source).length,
    survivor: values.filter((row) => Number(row[field]) === survivor).length,
  })
  const overlaps = (values: Row[], key: (row: Row) => string) => {
    const targets = new Set(values.filter((row) => Number(row.tag_id) === source).map(key))
    return values.filter((row) => Number(row.tag_id) === survivor && targets.has(key(row))).length
  }
  const target = (id: number) => {
    const entry = catalog.entries.find((row) => row.kind === "tag" && row.id === String(id))
    return { id: String(id), name: entry?.name ?? "" }
  }
  return {
    source: target(source),
    survivor: target(survivor),
    vocabularyFingerprint: catalog.fingerprint,
    previewFingerprint: `tag-preview-v1:${hash.digest("hex")}`,
    assignments: {
      ...counts(assignments, "tag_id"),
      overlappingTargets: overlaps(assignments, (row) => JSON.stringify([row.taggable_type, row.taggable_id])),
      byTargetType: [...new Set(assignments.map((row) => String(row.taggable_type)))].sort().map((type) => ({
        type,
        ...counts(
          assignments.filter((row) => row.taggable_type === type),
          "tag_id",
        ),
      })),
      samples: assignments.slice(0, limit).map((row) => ({
        id: String(row.id),
        tagId: String(row.tag_id),
        targetType: String(row.taggable_type),
        targetId: String(row.taggable_id),
        source: String(row.source),
        main: row.main === 1,
        authorType: row.author_type === null ? null : String(row.author_type),
        authorId: row.author_id === null ? null : String(row.author_id),
      })),
    },
    aliases: {
      ...counts(aliases, "aliasable_id"),
      samples: aliases
        .slice(0, limit)
        .map((row) => ({ id: String(row.id), tagId: String(row.aliasable_id), name: String(row.name) })),
    },
    automaticClaims: { ...counts(claims, "tag_id"), overlappingChats: overlaps(claims, (row) => String(row.chat_id)) },
    links: {
      total: links.length,
      samples: links.slice(0, limit).map((row) => ({
        id: String(row.id),
        fromType: String(row.from_type),
        fromId: String(row.from_id),
        toType: row.to_type === null ? null : String(row.to_type),
        toId: row.to_id === null ? null : String(row.to_id),
        kind: String(row.kind),
      })),
    },
    coverage: {
      inspectedTables: selections.map(([table]) => table),
      completeWithinInspectedTables: true,
      rows: count,
      readBytes,
      samplesComplete: [assignments, aliases, links].every((values) => values.length <= limit),
      applySupported: false,
    },
  }
}
