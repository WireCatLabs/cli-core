import { CliError } from "@wirecat/cli-base"
import { digest } from "../../document-transfer/digest.js"
import type {
  TransferEntity,
  TransferExternal,
  TransferKind,
  TransferSnapshot,
  TransferValues,
} from "../../document-transfer/model.js"
import type { CacheDatabase } from "../../driver.js"
import { referenceOfThing, storedThing } from "../things.js"
import { read } from "../transaction.js"

export const TRANSFER_TABLES = { document: "documents", note: "notes", memory: "memories", fact: "facts" } as const
const MAX_ENTITIES = 1000
const MAX_AUXILIARY = 10000
const MAX_BYTES = 16 * 1024 * 1024
const keyOf = (type: unknown, id: unknown) => `${String(type)}:${String(id)}`
const isAnnotation = (type: unknown): type is Exclude<TransferKind, "document"> =>
  type === "note" || type === "memory" || type === "fact"

const valuesOf = (row: Record<string, unknown>): TransferValues =>
  Object.fromEntries(
    Object.entries(row).map(([key, value]) => {
      if (value !== null && typeof value !== "string" && typeof value !== "number")
        throw new CliError("configuration_error", "the source contains an unsupported annotation value")
      return [key, value]
    }),
  )

export const transferSnapshot = (database: CacheDatabase, collection: string): TransferSnapshot =>
  read(database, () => {
    const accounts = database
      .prepare("SELECT * FROM accounts WHERE provider='folder' AND name=? ORDER BY id LIMIT 2")
      .all(collection)
    if (accounts.length > 1)
      throw new CliError(
        "configuration_error",
        "the source has duplicate document collection identities; select a repaired copy before transferring",
      )
    const account = accounts[0]
    if (!account) throw new CliError("not_found", "the source store does not hold the requested document collection")
    if (!database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='facts'").get())
      throw new CliError(
        "configuration_error",
        "the source store needs schema 2 or newer; upgrade a separate copy before transferring",
      )
    let bytes = 0
    const bounded = (row: Record<string, unknown>) => {
      const values = valuesOf(row)
      bytes += Buffer.byteLength(JSON.stringify(values))
      if (bytes > MAX_BYTES)
        throw new CliError("validation_error", "annotation transfer exceeds its 16 MiB snapshot limit")
      return values
    }
    const entities = new Map<string, TransferEntity>()
    const links = new Map<string, TransferValues>()
    const taggings = new Map<string, TransferValues>()
    const canonicalTags = Boolean(
      database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='canonical_tags'").get(),
    )
    const tagTable = canonicalTags ? "canonical_tags" : "tags"
    const resolution = canonicalTags
      ? "r.canonical_id AS tag_canonical_id,(SELECT count(*) FROM resolved_tags members WHERE members.canonical_id=r.canonical_id) AS tag_group_size"
      : "t.id AS tag_canonical_id,1 AS tag_group_size"
    const dependencies = new Map<string, { type: string; id: number }>()
    const depend = (type: unknown, id: unknown) => {
      if (type != null && id != null) dependencies.set(keyOf(type, id), { type: String(type), id: Number(id) })
    }
    const add = (kind: TransferKind, row: Record<string, unknown>) => {
      const key = keyOf(kind, row.id)
      if (entities.has(key)) return
      if (entities.size >= MAX_ENTITIES)
        throw new CliError("validation_error", "annotation transfer exceeds 1000 document and annotation records")
      const values = bounded(row)
      entities.set(key, { key, kind, values, revisions: [] })
    }
    for (const row of database
      .prepare("SELECT * FROM documents WHERE account_id=? ORDER BY id LIMIT 1001")
      .all(Number(account.id)))
      add("document", row)
    for (const entity of entities.values()) {
      const { kind, values } = entity
      for (const [child, subject] of [
        ["note", "notable"],
        ["memory", "subject"],
        ["fact", "subject"],
      ] as const) {
        for (const row of database
          .prepare(
            `SELECT * FROM ${TRANSFER_TABLES[child]} WHERE ${subject}_type=? AND ${subject}_id=? ORDER BY id LIMIT 1001`,
          )
          .all(kind, Number(values.id)))
          add(child, row)
      }
      for (const row of database
        .prepare(
          "SELECT * FROM links WHERE (from_type=? AND from_id=?) OR (to_type=? AND to_id=?) ORDER BY id LIMIT 10001",
        )
        .all(kind, Number(values.id), kind, Number(values.id))) {
        if (links.has(String(row.id))) continue
        if (links.size >= MAX_AUXILIARY)
          throw new CliError("validation_error", "annotation transfer exceeds 10000 relationships")
        links.set(String(row.id), bounded(row))
        for (const side of ["from", "to"]) {
          const type = row[`${side}_type`],
            id = row[`${side}_id`]
          depend(type, id)
          if (isAnnotation(type)) {
            const related = database.prepare(`SELECT * FROM ${TRANSFER_TABLES[type]} WHERE id=?`).get(Number(id))
            if (related) add(type, related)
          }
        }
      }
      for (const row of database
        .prepare(
          `SELECT g.*,t.name AS tag_name,t.kind AS tag_kind,${resolution} FROM taggings g JOIN ${tagTable} t ON t.id=g.tag_id ${canonicalTags ? "JOIN resolved_tags r ON r.id=t.id" : ""} WHERE g.taggable_type=? AND g.taggable_id=? ORDER BY g.id LIMIT 10001`,
        )
        .all(kind, Number(values.id))) {
        if (taggings.size >= MAX_AUXILIARY)
          throw new CliError("validation_error", "annotation transfer exceeds 10000 tag assignments")
        taggings.set(String(row.id), bounded(row))
        depend(row.author_type, row.author_id)
      }
      for (const prefix of ["notable", "subject", "author", "confirmed_by"])
        depend(values[`${prefix}_type`], values[`${prefix}_id`])
      if (values.project_id != null) depend("project", values.project_id)
      if (kind === "memory" || kind === "fact")
        for (const next of database
          .prepare(`SELECT * FROM ${TRANSFER_TABLES[kind]} WHERE supersedes_id=? ORDER BY id LIMIT 1001`)
          .all(Number(values.id)))
          add(kind, next)
      if (values.supersedes_id != null) {
        depend(kind, values.supersedes_id)
        const previous = database.prepare(`SELECT * FROM ${TRANSFER_TABLES[kind]} WHERE id=?`).get(values.supersedes_id)
        if (previous) add(kind, previous)
      }
      if (kind === "document" || kind === "note") {
        const table = kind === "document" ? "document_revisions" : "note_revisions"
        const rows = database
          .prepare(`SELECT * FROM ${table} WHERE ${kind}_id=? ORDER BY id LIMIT 10001`)
          .all(Number(values.id))
        if (rows.length > MAX_AUXILIARY)
          throw new CliError("validation_error", "annotation transfer exceeds 10000 revisions on one record")
        entity.revisions = rows.map(bounded)
      }
    }
    if (account.organization_id != null) depend("organization", account.organization_id)
    const external: TransferExternal[] = []
    const aliases: TransferValues[] = []
    for (const tag of new Set([...taggings.values()].map((item) => Number(item.tag_id))))
      for (const alias of database
        .prepare(
          "SELECT * FROM aliases WHERE aliasable_type='tag' AND aliasable_id=? AND account_id IS NULL ORDER BY id LIMIT 10001",
        )
        .all(tag)) {
        if (aliases.length >= MAX_AUXILIARY)
          throw new CliError("validation_error", "annotation transfer exceeds 10000 label aliases")
        aliases.push(bounded(alias))
      }
    for (const [key, thing] of dependencies) {
      if (entities.has(key)) continue
      const reference = referenceOfThing(database, storedThing(thing.type, thing.id)) ?? key
      const item: TransferExternal = { key, reference, kind: thing.type }
      if (thing.type === "person") {
        const person = database.prepare("SELECT name,owner FROM persons WHERE id=?").get(thing.id)
        if (person) {
          item.owner = person.owner === 1
          item.person = {
            name: person.name == null ? null : String(person.name),
            identities: database
              .prepare(
                "SELECT i.id,i.provider,i.external_id,i.name,i.username,i.bot,i.created_at,i.updated_at,l.method AS link_method,l.confidence AS link_confidence,l.author AS link_author,l.source AS link_source,l.created_at AS link_created_at,l.updated_at AS link_updated_at FROM identities i JOIN identity_links l ON l.identity_id=i.id WHERE l.person_id=? ORDER BY i.id LIMIT 10001",
              )
              .all(thing.id)
              .map(bounded),
          }
          if (item.person.identities.length > MAX_AUXILIARY)
            throw new CliError("validation_error", "annotation transfer exceeds 10000 identities for one person")
        }
      }
      if (thing.type === "identity") {
        const identity = database.prepare("SELECT person_id FROM identity_links WHERE identity_id=?").get(thing.id)
        if (identity?.person_id != null) depend("person", identity.person_id)
      }
      if (thing.type === "bot") {
        const bot = database.prepare("SELECT name,kind FROM bots WHERE id=?").get(thing.id)
        if (bot) item.bot = { name: String(bot.name), kind: String(bot.kind) }
      }
      if (thing.type === "document") {
        const doc = database
          .prepare(
            "SELECT a.name AS collection,d.external_id,d.body,d.content_hash,d.deleted_at FROM documents d JOIN accounts a ON a.id=d.account_id WHERE d.id=? AND a.provider='folder'",
          )
          .get(thing.id)
        if (doc) {
          item.collection = String(doc.collection)
          item.external_id = String(doc.external_id)
          const content = bounded({ body: doc.body, content_hash: doc.content_hash, deleted_at: doc.deleted_at })
          item.document_fingerprint = digest(content)
        }
      }
      external.push(item)
    }
    return {
      collection: bounded(account),
      entities: [...entities.values()].sort((a, b) => a.key.localeCompare(b.key)),
      links: [...links.values()].sort((a, b) => Number(a.id) - Number(b.id)),
      taggings: [...taggings.values()].sort((a, b) => Number(a.id) - Number(b.id)),
      external: external.sort((a, b) => a.key.localeCompare(b.key)),
      aliases,
    }
  })
