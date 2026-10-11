import { createHash } from "node:crypto"
import { CliError } from "@wirecat/cli-core"
import { normalizeTag } from "../../domain/tags.js"
import { normalizeVocabularyName, vocabularySimilarity } from "../../domain/vocabulary.js"
import { atomic } from "./atomic.js"
import type { StoreContext } from "./open.js"

export type VocabularyKind = "project" | "tag" | "topic"
export interface VocabularyTarget {
  kind: VocabularyKind
  id: string
}
export interface VocabularyAlias {
  id: string
  name: string
}
export interface VocabularyEntry extends VocabularyTarget {
  name: string
  key: string | null
  scope: "personal" | "work" | null
  aliases: VocabularyAlias[]
  usageCount: number
}
export interface VocabularyCatalog {
  entries: VocabularyEntry[]
  fingerprint: string
  coverage: { complete: true; maxEntries: number; maxReadBytes: number }
}
export interface VocabularyOptions {
  kind?: VocabularyKind
  scope?: "personal" | "work"
  maxEntries?: number
  maxReadBytes?: number
  signal?: AbortSignal
}
export interface VocabularyResolution {
  query: string
  matches: VocabularyEntry[]
  ambiguous: boolean
  fingerprint: string
}
export interface VocabularyAliasReceipt {
  target: VocabularyTarget
  alias: VocabularyAlias | null
  changed: boolean
}
export interface TagPreflight {
  name: string
  kind: "tag" | "topic"
  disposition: "reuse" | "create" | "review"
  existing: VocabularyEntry | null
  suggestions: { entry: VocabularyEntry; similarity: number; by: "lexical" }[]
  fingerprint: string
  semantic: "not-requested"
}
export interface VocabularyStore {
  vocabulary(options?: VocabularyOptions): Promise<VocabularyCatalog>
  resolveVocabulary(name: string, options?: VocabularyOptions): Promise<VocabularyResolution>
  addVocabularyAlias(
    target: VocabularyTarget,
    name: string,
    options?: { by?: "owner" | "agent"; expectedFingerprint?: string; signal?: AbortSignal },
  ): Promise<VocabularyAliasReceipt>
  removeVocabularyAlias(
    target: VocabularyTarget,
    aliasId: string,
    options?: { by?: "owner" | "agent"; expectedFingerprint?: string; signal?: AbortSignal },
  ): Promise<VocabularyAliasReceipt>
  tagPreflight(name: string, options?: VocabularyOptions & { kind?: "tag" | "topic" }): Promise<TagPreflight>
}

type Row = Record<string, unknown>
const kinds = ["project", "tag", "topic"] as const
const cancelled = (signal?: AbortSignal) => {
  if (signal?.aborted) throw new CliError("cancelled", "vocabulary operation was cancelled")
}
const idOf = (value: string): number => {
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)))
    throw new CliError("validation_error", "a vocabulary target needs a positive stored id")
  return Number(value)
}
const kindOf = (kind: VocabularyKind): void => {
  if (!kinds.includes(kind)) throw new CliError("validation_error", "choose project, tag or topic")
}

/** Metadata and aliases only: no transcript, model or person-name lookup. */
export const vocabularyStoreOver = (context: StoreContext): VocabularyStore => {
  const { database, now } = context
  const snapshot = <T>(body: () => T): T => {
    database.exec("SAVEPOINT vocabulary_snapshot")
    try {
      const result = body()
      database.exec("RELEASE vocabulary_snapshot")
      return result
    } catch (error) {
      database.exec("ROLLBACK TO vocabulary_snapshot; RELEASE vocabulary_snapshot")
      throw error
    }
  }
  const catalog = (options: VocabularyOptions = {}): VocabularyCatalog =>
    snapshot(() => {
      cancelled(options.signal)
      if (options.kind !== undefined) kindOf(options.kind)
      if (options.scope !== undefined && options.scope !== "personal" && options.scope !== "work")
        throw new CliError("validation_error", "choose personal or work vocabulary scope")
      const maxEntries = options.maxEntries ?? 5000
      const maxReadBytes = options.maxReadBytes ?? 4 * 1024 * 1024
      if (
        !Number.isSafeInteger(maxEntries) ||
        maxEntries < 1 ||
        maxEntries > 20_000 ||
        !Number.isSafeInteger(maxReadBytes) ||
        maxReadBytes < 1 ||
        maxReadBytes > 16 * 1024 * 1024
      )
        throw new CliError("validation_error", "vocabulary takes 1–20000 entries and 1–16777216 input bytes")
      const projects = options.kind === undefined || options.kind === "project"
      const tags = options.kind !== "project"
      const whereProjects = "account_id IS NULL AND deleted_at IS NULL AND (? IS NULL OR scope=?)"
      const whereTags = "(? IS NULL OR kind=?)"
      const tagKind = options.kind === "project" ? null : (options.kind ?? null)
      const metadata: Row[] = []
      if (projects)
        metadata.push(
          ...database
            .prepare(
              `SELECT 'project' AS kind,id,length(CAST(name AS BLOB))+length(CAST(key AS BLOB)) AS bytes FROM projects WHERE ${whereProjects} LIMIT ?`,
            )
            .all(options.scope ?? null, options.scope ?? null, maxEntries + 1),
        )
      if (tags)
        metadata.push(
          ...database
            .prepare(`SELECT kind,id,length(CAST(name AS BLOB)) AS bytes FROM tags WHERE ${whereTags} LIMIT ?`)
            .all(tagKind, tagKind, maxEntries + 1),
        )
      if (metadata.length > maxEntries)
        throw new CliError("validation_error", "vocabulary exceeds the selected entry budget", {
          reason: "vocabulary_entry_budget",
        })
      const aliasSelection =
        "a.account_id IS NULL AND ((? AND a.aliasable_type='project' AND EXISTS " +
        "(SELECT 1 FROM projects p WHERE p.id=a.aliasable_id AND p.account_id IS NULL AND p.deleted_at IS NULL AND (? IS NULL OR p.scope=?))) " +
        "OR (? AND a.aliasable_type='tag' AND EXISTS (SELECT 1 FROM tags t WHERE t.id=a.aliasable_id AND (? IS NULL OR t.kind=?))))"
      const aliasParams = [
        Number(projects),
        options.scope ?? null,
        options.scope ?? null,
        Number(tags),
        tagKind,
        tagKind,
      ]
      const aliases = database
        .prepare(
          `SELECT count(*) AS count,coalesce(sum(length(CAST(a.name AS BLOB))),0) AS bytes FROM aliases a WHERE ${aliasSelection}`,
        )
        .get(...aliasParams)
      if (Number(aliases?.count ?? 0) > maxEntries * 20)
        throw new CliError("validation_error", "vocabulary aliases exceed the selected entry budget")
      const bytes = metadata.reduce((total, row) => total + Number(row.bytes), 0) + Number(aliases?.bytes ?? 0)
      if (bytes > maxReadBytes)
        throw new CliError("validation_error", "vocabulary exceeds the selected input byte budget", {
          reason: "vocabulary_byte_budget",
        })
      const entries: VocabularyEntry[] = []
      if (projects)
        entries.push(
          ...database
            .prepare(`SELECT id,name,key,scope FROM projects WHERE ${whereProjects} ORDER BY id`)
            .all(options.scope ?? null, options.scope ?? null)
            .map((row) => ({
              kind: "project" as const,
              id: String(row.id),
              name: String(row.name),
              key: String(row.key),
              scope: row.scope as "personal" | "work",
              aliases: [],
              usageCount: 0,
            })),
        )
      if (tags)
        entries.push(
          ...database
            .prepare(
              `SELECT t.id,t.name,t.kind,(SELECT count(*) FROM taggings g WHERE g.tag_id=t.id)+(SELECT count(*) FROM links l WHERE l.to_type='tag' AND l.to_id=t.id AND l.kind='labelled') AS uses FROM tags t WHERE ${whereTags} ORDER BY id`,
            )
            .all(tagKind, tagKind)
            .map((row) => ({
              kind: row.kind as "tag" | "topic",
              id: String(row.id),
              name: String(row.name),
              key: null,
              scope: null,
              aliases: [],
              usageCount: Number(row.uses),
            })),
        )
      const byTarget = new Map(
        entries.map((entry) => [`${entry.kind === "project" ? "project" : "tag"}:${entry.id}`, entry]),
      )
      for (const row of database
        .prepare(
          `SELECT a.id,a.aliasable_type,a.aliasable_id,a.name FROM aliases a WHERE ${aliasSelection} ORDER BY a.id`,
        )
        .all(...aliasParams))
        byTarget
          .get(`${row.aliasable_type}:${row.aliasable_id}`)
          ?.aliases.push({ id: String(row.id), name: String(row.name) })
      cancelled(options.signal)
      return {
        entries,
        fingerprint: `v1:${options.kind ?? "all"}:${options.scope ?? "all"}:${createHash("sha256").update(JSON.stringify(entries)).digest("hex")}`,
        coverage: { complete: true, maxEntries, maxReadBytes },
      }
    })
  const storedName = (value: string): string | null => {
    try {
      return normalizeVocabularyName(value)
    } catch {
      return null
    }
  }
  const matches = (entries: VocabularyEntry[], name: string) => {
    const normalized = normalizeVocabularyName(name)
    return entries.filter((entry) =>
      [entry.name, ...(entry.key ? [entry.key] : []), ...entry.aliases.map((alias) => alias.name)].some(
        (value) => storedName(value) === normalized,
      ),
    )
  }
  const writable = (options: { by?: "owner" | "agent"; expectedFingerprint?: string; signal?: AbortSignal }) => {
    cancelled(options.signal)
    if (options.by !== undefined && options.by !== "owner")
      throw new CliError("permission_error", "an agent proposes vocabulary changes; only the owner applies them")
    const expected = options.expectedFingerprint
    if (expected !== undefined && typeof expected !== "string")
      throw new CliError("validation_error", "invalid vocabulary preview fingerprint")
    const parts = expected?.match(/^v1:(all|project|tag|topic):(all|personal|work):[a-f0-9]{64}$/)
    if (expected !== undefined && !parts)
      throw new CliError("validation_error", "invalid vocabulary preview fingerprint")
    const current = catalog({
      ...(parts?.[1] && parts[1] !== "all" ? { kind: parts[1] as VocabularyKind } : {}),
      ...(parts?.[2] && parts[2] !== "all" ? { scope: parts[2] as "personal" | "work" } : {}),
    })
    if (expected !== undefined && expected !== current.fingerprint)
      throw new CliError("configuration_error", "vocabulary changed since the preview", { reason: "stale_vocabulary" })
    return parts && (parts[1] !== "all" || parts[2] !== "all") ? catalog() : current
  }
  const targetEntry = (current: VocabularyCatalog, target: VocabularyTarget) => {
    if (!target || typeof target !== "object") throw new CliError("validation_error", "a vocabulary target is required")
    kindOf(target.kind)
    idOf(target.id)
    const entry = current.entries.find((value) => value.kind === target.kind && value.id === target.id)
    if (!entry) throw new CliError("not_found", "the vocabulary target is unavailable")
    return entry
  }
  return {
    vocabulary: async (options) => catalog(options),
    resolveVocabulary: async (name, options) => {
      normalizeVocabularyName(name)
      const current = catalog(options)
      const found = matches(current.entries, name)
      return { query: name, matches: found, ambiguous: found.length > 1, fingerprint: current.fingerprint }
    },
    addVocabularyAlias: async (target, name, options = {}) => {
      const normalized = normalizeVocabularyName(name)
      return atomic(database, () => {
        const current = writable(options)
        const entry = targetEntry(current, target)
        const peers = current.entries.filter((value) => (value.kind === "project") === (target.kind === "project"))
        const conflicts = matches(peers, name).filter((value) => value.id !== entry.id || value.kind !== entry.kind)
        if (conflicts.length)
          throw new CliError("configuration_error", "this alias already names another canonical record", {
            reason: "vocabulary_alias_conflict",
            candidates: conflicts.map((value) => ({ kind: value.kind, id: value.id, name: value.name })),
          })
        const held = entry.aliases.find((alias) => storedName(alias.name) === normalized)
        if (held || [entry.name, ...(entry.key ? [entry.key] : [])].some((value) => storedName(value) === normalized))
          return { target: { kind: entry.kind, id: entry.id }, alias: held ?? null, changed: false }
        const at = now()
        const row = database
          .prepare(
            "INSERT INTO aliases (aliasable_type,aliasable_id,account_id,name,name_folded,display,source,created_at,updated_at) VALUES (?,?,NULL,?,?,0,'owner',?,?) RETURNING id",
          )
          .get(target.kind === "project" ? "project" : "tag", idOf(target.id), name.trim(), normalized, at, at)
        cancelled(options.signal)
        return {
          target: { kind: entry.kind, id: entry.id },
          alias: { id: String(row?.id), name: name.trim() },
          changed: true,
        }
      })
    },
    removeVocabularyAlias: async (target, aliasId, options = {}) =>
      atomic(database, () => {
        const current = writable(options)
        const entry = targetEntry(current, target)
        idOf(aliasId)
        const held = entry.aliases.find((alias) => alias.id === aliasId)
        if (!held) return { target: { kind: entry.kind, id: entry.id }, alias: null, changed: false }
        database
          .prepare("DELETE FROM aliases WHERE id=? AND aliasable_type=? AND aliasable_id=? AND account_id IS NULL")
          .run(idOf(aliasId), target.kind === "project" ? "project" : "tag", idOf(target.id))
        cancelled(options.signal)
        return { target: { kind: entry.kind, id: entry.id }, alias: held, changed: true }
      }),
    tagPreflight: async (name, options = {}) => {
      const kind = options.kind ?? "tag"
      if (kind !== "tag" && kind !== "topic") throw new CliError("validation_error", "choose tag or topic")
      const current = catalog({ ...options, kind: undefined, scope: undefined })
      const entries = current.entries.filter((entry) => entry.kind !== "project")
      const found = matches(entries, name)
      if (found.length > 1) throw new CliError("configuration_error", "the label resolves ambiguously")
      const existing = found[0] ?? null
      if (existing && existing.kind !== kind)
        throw new CliError("validation_error", `this name is already a ${existing.kind}`)
      if (!existing) normalizeTag(name)
      const suggestions = existing
        ? []
        : entries
            .map((entry) => ({
              entry,
              similarity: Math.max(
                ...[entry.name, ...entry.aliases.map((alias) => alias.name)].map((value) =>
                  storedName(value) === null ? 0 : vocabularySimilarity(name, value),
                ),
              ),
              by: "lexical" as const,
            }))
            .filter((value) => value.similarity >= 0.65)
            .sort((a, b) => b.similarity - a.similarity || Number(a.entry.id) - Number(b.entry.id))
            .slice(0, 10)
      return {
        name,
        kind,
        disposition: existing ? "reuse" : suggestions.length ? "review" : "create",
        existing,
        suggestions,
        fingerprint: current.fingerprint,
        semantic: "not-requested",
      }
    },
  }
}
