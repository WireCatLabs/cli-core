import { createHash } from "node:crypto"
import { CliError } from "@wirecat/cli-base"
import type {
  TagConsolidationOptions,
  TagConsolidationPreview,
  TagConsolidationStore,
} from "../../domain/tag-consolidation.js"
import { createTagRedirectIndex } from "../../domain/tag-redirects.js"
import type { StoreContext } from "./open.js"
import { applyTagConsolidation } from "./tag-consolidation-apply.js"
import { consolidationInput } from "./tag-consolidation-input.js"
import { tagCanonicalId, tagRedirectSnapshot } from "./tag-resolution.js"
import { read } from "./transaction.js"
import type { VocabularyCatalog } from "./vocabulary.js"

type Row = Record<string, unknown>
const selections = [
  ["taggings", "tag_id IN (SELECT value FROM json_each(?))"],
  ["aliases", "aliasable_type='tag' AND aliasable_id IN (SELECT value FROM json_each(?))"],
  ["canonical_auto_tag_claims", "tag_id IN (SELECT value FROM json_each(?))"],
  [
    "links",
    "(from_type='tag' AND from_id IN (SELECT value FROM json_each(?))) OR (to_type='tag' AND to_id IN (SELECT value FROM json_each(?)))",
  ],
] as const

const cancelled = (options: TagConsolidationOptions) => {
  if (options.signal?.aborted) throw new CliError("cancelled", "tag consolidation preview was cancelled")
}

export const tagConsolidationStoreOver = (
  context: StoreContext,
  catalog: () => VocabularyCatalog,
): TagConsolidationStore => ({
  previewTagConsolidation: async (options) => previewTagConsolidation(context, catalog, options),
  applyTagConsolidation: async (options) =>
    applyTagConsolidation(context, (input) => previewTagConsolidation(context, catalog, input), options),
})

const previewTagConsolidation = (
  context: StoreContext,
  catalog: () => VocabularyCatalog,
  options: TagConsolidationOptions,
): TagConsolidationPreview => {
  const { source, survivor, maxRows, maxReadBytes, limit } = consolidationInput(options)
  cancelled(options)
  return read(context.database, () => {
    const current = catalog()
    if (current.fingerprint !== options.expectedVocabularyFingerprint)
      throw new CliError("configuration_error", "vocabulary changed since the preview", { reason: "vocabulary.stale" })
    if (tagCanonicalId(context.database, source) === tagCanonicalId(context.database, survivor))
      throw new CliError("validation_error", "sourceId and survivorId already resolve to the same canonical tag")
    const selected = [source, survivor].map((id) =>
      current.entries.find((entry) => entry.id === String(id) && entry.kind !== "project"),
    )
    if (selected.some((entry) => !entry)) throw new CliError("not_found", "a selected canonical tag is unavailable")
    if (selected.some((entry) => entry?.kind !== "tag"))
      throw new CliError("validation_error", "consolidation preview supports tags only")
    return previewRows(context, options, source, survivor, maxRows, maxReadBytes, limit, current)
  })
}

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
  const graph = tagRedirectSnapshot(context.database)
  const index = createTagRedirectIndex(graph)
  const sourceMemberIds = index.resolve(String(source)).memberIds
  const survivorMemberIds = index.resolve(String(survivor)).memberIds
  const sourceMembers = new Set(sourceMemberIds.map(Number))
  const memberIds = JSON.stringify([...sourceMemberIds, ...survivorMemberIds].map(Number))
  const captured = JSON.stringify(graph)
  let readBytes = Buffer.byteLength(captured)
  const hash = createHash("sha256").update(JSON.stringify([source, survivor, catalog.fingerprint, graph]))
  for (const [table, where] of selections) {
    cancelled(options)
    const parameters = table === "links" ? [memberIds, memberIds] : [memberIds]
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
        `SELECT * FROM ${table} WHERE ${where} ORDER BY ${table === "canonical_auto_tag_claims" ? "chat_id,tag_id" : "id"} LIMIT ?`,
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
  const claims = rows.get("canonical_auto_tag_claims") ?? []
  const links = rows.get("links") ?? []
  const byTargetType = new Map<string, { type: string; source: number; survivor: number }>()
  for (const row of assignments) {
    const type = String(row.taggable_type)
    const totals = byTargetType.get(type) ?? { type, source: 0, survivor: 0 }
    if (sourceMembers.has(Number(row.tag_id))) totals.source++
    else totals.survivor++
    byTargetType.set(type, totals)
  }
  const counts = (values: Row[], field: string) => ({
    source: values.filter((row) => sourceMembers.has(Number(row[field]))).length,
    survivor: values.filter((row) => !sourceMembers.has(Number(row[field]))).length,
  })
  const overlaps = (values: Row[], key: (row: Row) => string) => {
    const targets = new Set(values.filter((row) => sourceMembers.has(Number(row.tag_id))).map(key))
    return new Set(values.filter((row) => !sourceMembers.has(Number(row.tag_id)) && targets.has(key(row))).map(key))
      .size
  }
  const target = (id: number) => {
    const entry = catalog.entries.find((row) => row.kind === "tag" && row.id === String(id))
    return { id: String(id), name: entry?.name ?? "" }
  }
  return {
    source: target(source),
    survivor: target(survivor),
    sourceMemberIds,
    survivorMemberIds,
    vocabularyFingerprint: catalog.fingerprint,
    previewFingerprint: `tag-preview-v1:${hash.digest("hex")}`,
    assignments: {
      ...counts(assignments, "tag_id"),
      overlappingTargets: overlaps(assignments, (row) => JSON.stringify([row.taggable_type, row.taggable_id])),
      byTargetType: [...byTargetType.values()].sort((a, b) => (a.type < b.type ? -1 : a.type > b.type ? 1 : 0)),
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
      applySupported: true,
    },
  }
}
