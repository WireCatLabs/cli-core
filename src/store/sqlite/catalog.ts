import { CliError } from "@wirecat/cli-base"
import { defineQuery, type Predicate, type QueryAst, validateQuery, walkQuery } from "@wirecat/cli-base/query"
import { normalizeTag } from "../../domain/tags.js"
import type { SqlValue } from "../driver.js"
import { fold } from "../normalize.js"
import { syncFile } from "./files.js"
import type { StoreContext } from "./open.js"
import { type ColumnMap, queryFilter } from "./query-filter.js"
import { canonicalTagNamed } from "./tags.js"
import { write } from "./transaction.js"

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
export const CATALOG_QUERY = defineQuery({
  entity: "document",
  backend: "sql",
  fields: [
    {
      name: "text",
      type: "txt",
      operators: ["term", "phrase"],
      example: "text:budget",
      relation: "names, descriptions and MIME types",
    },
    { name: "name", type: "kw", operators: ["term", "phrase", "wildcard"], example: "name:Budget*" },
    { name: "kind", type: "enum", values: ["file", "folder"], operators: ["term"], example: "kind:folder" },
    { name: "mime", type: "kw", operators: ["term", "phrase", "wildcard"], example: 'mime:"application/pdf"' },
    {
      name: "parent",
      type: "kw",
      operators: ["term"],
      example: "parent:root.md",
      relation: "a direct parent external ID",
    },
    {
      name: "person",
      type: "kw",
      operators: ["term", "phrase", "wildcard"],
      example: "person:Rin*",
      relation: "an observed owner/editor name, email or ID",
    },
    { name: "tag", type: "kw", operators: ["term", "phrase"], example: "tag:follow-up", relation: "a local owner tag" },
  ],
})
export interface CatalogQuery {
  ast?: QueryAst
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
  folded?: { name: string; text: string; people: string[] }
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
  const { folded: _folded, ...entry } = data
  return {
    ...entry,
    name: data.name,
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
  const bound = (id: number, includeInactive = false) => {
    const scope =
      "account_id = ? AND json_type(metadata, '$.catalog') = 'object'" +
      (includeInactive ? "" : " AND json_extract(metadata, '$.catalog.active') = 1 AND deleted_at IS NULL")
    const budget = database
      .prepare(`SELECT count(*) AS entries, sum(length(metadata)) AS bytes FROM documents WHERE ${scope}`)
      .get(id)
    if (Number(budget?.bytes ?? 0) > 32 * 1024 * 1024)
      throw new CliError("validation_error", "catalog scope exceeds its metadata budget")
    if (Number(budget?.entries ?? 0) > 10000)
      throw new CliError("validation_error", "catalog scope exceeds 10000 entries")
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
      write(database, () => {
        const at = now()
        for (const { input, created, modified } of checked) {
          const before = database
            .prepare("SELECT *, body IS NOT NULL AS has_body FROM documents WHERE account_id = ? AND external_id = ?")
            .get(id, input.externalId)
          const metadata = objectOf(before?.metadata)
          metadata.catalog = {
            ...input,
            active: true,
            observedAt: new Date(at).toISOString(),
            folded: {
              name: fold(input.name),
              text: fold([input.name, input.description, input.mime].filter(Boolean).join(" ")),
              people: (input.actors ?? []).flatMap((actor) =>
                [actor.id, actor.email, actor.name]
                  .filter((value): value is string => typeof value === "string")
                  .map(fold),
              ),
            },
          }
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
        const written = database.prepare("SELECT id FROM documents WHERE account_id = ? AND external_id = ?")
        for (const { input } of checked) syncFile(database, at, Number(written.get(id, input.externalId)?.id))
      })
    },
    reconcile: async (accountId, externalIds) => {
      const id = account(accountId)
      if (externalIds.length > 10000) throw new CliError("validation_error", "catalog scope exceeds 10000 entries")
      const current = [...new Set(externalIds.map((key) => field(key)))]
      return write(database, () => {
        const retired = database
          .prepare(
            "UPDATE documents SET metadata=json_set(metadata, '$.catalog.active', json('false')) WHERE account_id=? AND json_type(metadata, '$.catalog')='object' AND json_extract(metadata, '$.catalog.active')=1" +
              (current.length ? " AND external_id NOT IN (SELECT value FROM json_each(?))" : "") +
              " RETURNING id",
          )
          .all(...(current.length ? [id, JSON.stringify(current)] : [id]))
        const at = now()
        for (const row of retired) syncFile(database, at, Number(row.id), { seen: false })
        return retired.length
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
      const clauses: string[] = ["d.account_id=?", "json_type(d.metadata, '$.catalog')='object'"]
      const params: SqlValue[] = [id]
      if (!query.includeInactive) clauses.push("json_extract(d.metadata, '$.catalog.active')=1", "d.deleted_at IS NULL")
      const add = (sql: string, ...values: SqlValue[]) => {
        clauses.push(sql)
        params.push(...values)
      }
      const actorSql = "json_each(d.metadata, '$.catalog.folded.people')"
      const tagSql =
        "SELECT 1 FROM taggings g JOIN resolved_tags t ON t.id=g.tag_id WHERE g.taggable_type='document' AND g.taggable_id=d.id AND t.name=?"
      const tag = (name: string) => canonicalTagNamed(database, name)?.name ?? normalizeTag(name)
      if (query.parent !== undefined)
        add("EXISTS(SELECT 1 FROM json_each(d.metadata, '$.catalog.parents') WHERE value=?)", query.parent)
      if (query.kind !== undefined) add("json_extract(d.metadata, '$.catalog.kind')=?", query.kind)
      if (query.mime !== undefined) add("json_extract(d.metadata, '$.catalog.mime')=?", query.mime)
      if (query.search !== undefined)
        add("instr(json_extract(d.metadata, '$.catalog.folded.text'), ?)>0", fold(query.search))
      if (query.person !== undefined)
        add(`EXISTS(SELECT 1 FROM ${actorSql} WHERE instr(value, ?)>0)`, fold(query.person))
      if (query.tag !== undefined) add(`EXISTS(${tagSql})`, tag(query.tag))
      if (query.ast !== undefined) {
        const ast = structuredClone(validateQuery(query.ast, CATALOG_QUERY))
        for (const node of walkQuery(ast.root))
          if (["text", "name", "person"].includes(node.field)) node.value = fold(node.value)
        const person = (node: Predicate) => ({
          sql: `EXISTS(SELECT 1 FROM ${actorSql} WHERE value ${node.operator === "wildcard" ? "LIKE ? ESCAPE '\\'" : "=?"})`,
          params: [
            node.operator === "wildcard"
              ? node.value
                  .replace(/[\\%_]/gu, "\\$&")
                  .replaceAll("*", "%")
                  .replaceAll("?", "_")
              : node.value,
          ],
        })
        const columns: ColumnMap = {
          name: { type: "kw", sql: "json_extract(d.metadata, '$.catalog.folded.name')", folded: true },
          mime: { type: "kw", sql: "json_extract(d.metadata, '$.catalog.mime')" },
          kind: { type: "enum", sql: "json_extract(d.metadata, '$.catalog.kind')" },
          text: {
            where: (node) => ({
              sql: "instr(json_extract(d.metadata, '$.catalog.folded.text'), ?)>0",
              params: [node.value],
            }),
          },
          parent: {
            where: (node) => ({
              sql: "EXISTS(SELECT 1 FROM json_each(d.metadata, '$.catalog.parents') WHERE value=?)",
              params: [node.value],
            }),
          },
          person: { where: person },
          tag: { where: (node) => ({ sql: `EXISTS(${tagSql})`, params: [tag(node.value)] }) },
        }
        const compiled = queryFilter(ast, columns)
        if (compiled.sql) add(compiled.sql, ...compiled.params)
      }
      bound(id, query.includeInactive)
      const found = database
        .prepare(
          `SELECT d.id, d.external_id, d.title, d.front_matter, d.metadata, d.deleted_at, d.body IS NOT NULL AS has_body FROM documents d WHERE ${clauses.join(" AND ")} ORDER BY d.external_id LIMIT ? OFFSET ?`,
        )
        .all(...params, limit + 1, offset)
      return { items: found.slice(0, limit).map(entryOf), hasMore: found.length > limit }
    },
  }
}
