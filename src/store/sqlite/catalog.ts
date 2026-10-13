import { CliError } from "@wirecat/cli-base"
import { normalizeTag } from "../../domain/tags.js"
import { fold } from "../normalize.js"
import { atomic } from "./atomic.js"
import type { StoreContext } from "./open.js"
import { canonicalTagNamed } from "./tags.js"

export interface CatalogActor {
  id?: string
  name?: string
  email?: string
  role?: string
}
export interface CatalogInput {
  externalId: string
  kind: "file" | "folder"
  name: string
  parents: string[]
  url?: string
  mime?: string
  size?: number
  createdAt?: string
  modifiedAt?: string
  description?: string
  actors?: CatalogActor[]
  metadata?: unknown
  frontMatter?: Record<string, unknown>
}
export interface CatalogEntry extends CatalogInput {
  ref: string
  observedAt: string
  active: boolean
  content: "metadata" | "indexed" | "unreadable"
}
export interface CatalogQuery {
  parent?: string
  kind?: CatalogInput["kind"]
  mime?: string
  search?: string
  person?: string
  tag?: string
  includeInactive?: boolean
  limit?: number
  offset?: number
}
export interface CatalogStore {
  upsert(accountId: string, entries: CatalogInput[]): Promise<void>
  /** Retires entries absent from a completed scope scan without deleting content or owner annotations. */
  reconcile(accountId: string, externalIds: string[]): Promise<number>
  get(accountId: string, externalId: string, includeInactive?: boolean): Promise<CatalogEntry | undefined>
  list(accountId: string, query?: CatalogQuery): Promise<{ items: CatalogEntry[]; hasMore: boolean }>
}
type Row = Record<string, unknown>
const objectOf = (value: unknown): Record<string, unknown> => {
  const parsed: unknown = value == null ? {} : JSON.parse(String(value))
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new CliError("invalid_response", "stored catalog metadata must be an object")
  return parsed as Record<string, unknown>
}
interface Stored extends CatalogInput {
  active: boolean
  observedAt: string
}
const field = (value: string, max = 4000) => {
  if (typeof value !== "string" || !value || value.length > max)
    throw new CliError("validation_error", "catalog field is empty or too long")
  return value
}
const date = (value: string | undefined) => {
  if (value === undefined) return null
  const at = typeof value === "string" ? Date.parse(value) : Number.NaN
  if (!Number.isFinite(at)) throw new CliError("validation_error", "catalog dates must be valid timestamps")
  return at
}
const stored = (row: Row): Stored | undefined => {
  return objectOf(row.metadata).catalog as Stored | undefined
}
const entryOf = (row: Row): CatalogEntry => {
  const data = stored(row)
  if (!data) throw new CliError("invalid_response", "document has no catalog metadata")
  const front = row.front_matter == null ? {} : JSON.parse(String(row.front_matter))
  return {
    ...data,
    name: String(row.title ?? data.name),
    ref: `document:${row.id}`,
    content: data.kind === "folder" || !row.has_body ? "metadata" : front.notRead ? "unreadable" : "indexed",
  }
}
export const catalogStoreOver = ({ database, now }: StoreContext): CatalogStore => {
  const account = (id: string) => {
    if (!/^\d+$/.test(id) || !database.prepare("SELECT 1 FROM accounts WHERE id = ?").get(Number(id)))
      throw new CliError("not_found", "catalog account is not in the local store")
    return Number(id)
  }
  const rows = (id: number) => {
    const budget = database
      .prepare(
        "SELECT sum(length(metadata)) AS bytes FROM documents WHERE account_id = ? AND json_type(metadata, '$.catalog') = 'object'",
      )
      .get(id)
    if (Number(budget?.bytes ?? 0) > 32 * 1024 * 1024)
      throw new CliError("validation_error", "catalog scope exceeds its metadata budget")
    return database
      .prepare(
        "SELECT id, external_id, title, front_matter, metadata, deleted_at, body IS NOT NULL AS has_body FROM documents WHERE account_id = ? AND json_type(metadata, '$.catalog') = 'object' ORDER BY external_id LIMIT 10001",
      )
      .all(id)
  }
  const list = (id: number) => {
    const found = rows(id)
    if (found.length > 10000) throw new CliError("validation_error", "catalog scope exceeds 10000 entries")
    return found
  }
  return {
    upsert: async (accountId, inputs) => {
      const id = account(accountId)
      if (inputs.length > 200) throw new CliError("validation_error", "catalog writes take at most 200 entries")
      const seen = new Set<string>()
      const checked = inputs.map((input) => {
        field(input.externalId)
        if (seen.has(input.externalId)) throw new CliError("validation_error", "catalog batch repeats an external id")
        seen.add(input.externalId)
        if (
          !["file", "folder"].includes(input.kind) ||
          typeof input.name !== "string" ||
          input.name.length > 4000 ||
          !Array.isArray(input.parents) ||
          input.parents.length > 100
        )
          throw new CliError("validation_error", "invalid catalog name, kind or parents")
        for (const parent of input.parents) field(parent)
        if (input.actors !== undefined) {
          if (!Array.isArray(input.actors) || input.actors.length > 100)
            throw new CliError("validation_error", "invalid catalog actors")
          for (const actor of input.actors) {
            if (!actor || typeof actor !== "object") throw new CliError("validation_error", "invalid catalog actor")
            for (const value of [actor.id, actor.name, actor.email, actor.role]) if (value !== undefined) field(value)
          }
        }
        if (input.size !== undefined && (!Number.isSafeInteger(input.size) || input.size < 0))
          throw new CliError("validation_error", "catalog size must be a nonnegative integer")
        let json: string
        try {
          json = JSON.stringify(input)
        } catch {
          throw new CliError("validation_error", "catalog metadata must be JSON")
        }
        if (Buffer.byteLength(json, "utf8") > 1000000)
          throw new CliError("validation_error", "catalog entry exceeds its metadata budget")
        return {
          input: JSON.parse(json) as CatalogInput,
          created: date(input.createdAt),
          modified: date(input.modifiedAt),
        }
      })
      atomic(database, () => {
        const at = now()
        for (const { input, created, modified } of checked) {
          const before = database
            .prepare("SELECT *, body IS NOT NULL AS has_body FROM documents WHERE account_id = ? AND external_id = ?")
            .get(id, input.externalId)
          const metadata = objectOf(before?.metadata)
          metadata.catalog = { ...input, active: true, observedAt: new Date(at).toISOString() }
          if (before?.deleted_at != null)
            database
              .prepare("UPDATE documents SET deleted_at=NULL, body=NULL, content_hash=NULL, extraction=NULL WHERE id=?")
              .run(Number(before.id))
          const front = before?.front_matter == null ? {} : JSON.parse(String(before.front_matter))
          const frontMatter = { ...front, ...input.frontMatter }
          if (before)
            database
              .prepare(
                "UPDATE documents SET title=?, url=?, mime=?, size=?, external_created_at=?, external_updated_at=?, metadata=?, front_matter=?, updated_at=? WHERE id=?",
              )
              .run(
                input.name,
                input.url ?? null,
                input.mime ?? null,
                input.size ?? null,
                created,
                modified,
                JSON.stringify(metadata),
                JSON.stringify(frontMatter),
                at,
                Number(before.id),
              )
          else
            database
              .prepare(
                "INSERT INTO documents(account_id,external_id,kind,title,url,mime,size,external_created_at,external_updated_at,metadata,front_matter,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
              )
              .run(
                id,
                input.externalId,
                input.kind,
                input.name,
                input.url ?? null,
                input.mime ?? null,
                input.size ?? null,
                created,
                modified,
                JSON.stringify(metadata),
                JSON.stringify(frontMatter),
                at,
                at,
              )
        }
      })
    },
    reconcile: async (accountId, externalIds) => {
      const id = account(accountId)
      if (externalIds.length > 10000) throw new CliError("validation_error", "catalog scope exceeds 10000 entries")
      const current = new Set(externalIds.map((key) => field(key)))
      return atomic(database, () => {
        let retired = 0
        for (const row of list(id)) {
          const data = stored(row)
          if (!data?.active || current.has(String(row.external_id))) continue
          const metadata = objectOf(row.metadata)
          metadata.catalog = { ...data, active: false }
          database
            .prepare("UPDATE documents SET metadata = ? WHERE id = ?")
            .run(JSON.stringify(metadata), Number(row.id))
          retired++
        }
        return retired
      })
    },
    get: async (accountId, externalId, includeInactive = false) => {
      const id = account(accountId)
      const row = database
        .prepare("SELECT *, body IS NOT NULL AS has_body FROM documents WHERE account_id = ? AND external_id = ?")
        .get(id, externalId)
      if (!row || !stored(row) || (!includeInactive && (!stored(row)?.active || row.deleted_at != null)))
        return undefined
      return entryOf(row)
    },
    list: async (accountId, query = {}) => {
      const id = account(accountId)
      const limit = query.limit ?? 50
      const offset = query.offset ?? 0
      if (!Number.isInteger(limit) || limit < 1 || limit > 1000 || !Number.isInteger(offset) || offset < 0)
        throw new CliError("validation_error", "invalid catalog page bounds")
      const search = query.search === undefined ? undefined : fold(query.search)
      const person = query.person === undefined ? undefined : fold(query.person)
      const tag =
        query.tag === undefined ? undefined : (canonicalTagNamed(database, query.tag)?.name ?? normalizeTag(query.tag))
      const matches = list(id).filter((row) => {
        const data = stored(row) as Stored
        if (!query.includeInactive && (!data.active || row.deleted_at != null)) return false
        if (query.parent !== undefined && !data.parents.includes(query.parent)) return false
        if (query.kind !== undefined && data.kind !== query.kind) return false
        if (query.mime !== undefined && data.mime !== query.mime) return false
        if (
          search !== undefined &&
          !fold([row.title, data.description, data.mime].filter(Boolean).join(" ")).includes(search)
        )
          return false
        if (
          person !== undefined &&
          !(data.actors ?? []).some((actor) =>
            [actor.id, actor.email, actor.name].some((value) => value && fold(value).includes(person)),
          )
        )
          return false
        if (
          tag !== undefined &&
          !database
            .prepare(
              "SELECT 1 FROM taggings g JOIN tags t ON t.id=g.tag_id WHERE g.taggable_type='document' AND g.taggable_id=? AND t.name=?",
            )
            .get(Number(row.id), tag)
        )
          return false
        return true
      })
      return { items: matches.slice(offset, offset + limit).map(entryOf), hasMore: matches.length > offset + limit }
    },
  }
}
