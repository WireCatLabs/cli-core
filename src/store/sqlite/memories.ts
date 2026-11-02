import { CliError } from "@wirecat/cli-base"
import { MEMORY_KINDS, MEMORY_SCOPES, type MEMORY_STATUSES } from "../../domain/knowledge.js"
import type { Stemmer, Stemmers } from "../../search/stem.js"
import { assertMayDecide, type Decider } from "../decisions.js"
import { normalize } from "../normalize.js"
import { type Actor, botNamed, ownerPerson, proposerOf } from "./actors.js"
import { type EvidenceSource, evidenceSourcesOf } from "./evidence-sources.js"
import { linkKind } from "./link-kinds.js"
import { CORPORA, corpusIndexState, drainCorpus, type NoteIndexState } from "./note-index.js"
import { requiredThing } from "./notes.js"
import type { StoreContext } from "./open.js"
import { stemmerCache } from "./stems.js"
import { referenceOfThing, storedThing } from "./things.js"
import { write } from "./transaction.js"

/** Who wrote it: the owner, or an agent (or a rule scorer) by its bot handle and the model it ran on. */
export type Author = "owner" | { bot: string; model?: string; kind?: "agent" | "rule" }

export interface Memory {
  id: string
  ref: string
  kind: (typeof MEMORY_KINDS)[number]
  body: string
  /** What it is about, as a reference; `null` for a general fact. */
  subject: string | null
  /** What the subject is called; `null` for the owner, who has no name in the store, and for a nameless row. */
  subjectName: string | null
  /** The subject is the owner. */
  subjectIsOwner: boolean
  /** The project it belongs to, as `project:<id>`. */
  project: string | null
  projectName: string | null
  /** `name` is a bot's handle; `null` for a person. */
  author: { type: Actor["type"]; id: string; name: string | null }
  model: string | null
  confidence: number | null
  status: (typeof MEMORY_STATUSES)[number]
  scope: (typeof MEMORY_SCOPES)[number]
  supersedes: string | null
  /** The references it rests on: `links` of kind `evidence`. */
  evidence: string[]
  lastVerifiedAt: string | null
  createdAt: string
  updatedAt: string
}

export interface MemoryInput {
  kind: Memory["kind"]
  body: string
  /** Required, with no default: a memory read for the wrong purpose leaks, so its writer says which. */
  scope: Memory["scope"]
  /** At least one reference the memory rests on. */
  evidence: string[]
  author: Author
  subject?: string
  project?: string
  confidence?: number
  status?: "proposed" | "confirmed"
  /** The memory this one replaces; it becomes `superseded`. */
  supersedes?: string
}

export interface MemoriesStore {
  add(input: MemoryInput): Promise<Memory>
  get(reference: string): Promise<Memory>
  list(options?: {
    subject?: string
    project?: string
    kind?: Memory["kind"]
    status?: Memory["status"]
    scope?: Memory["scope"]
    limit?: number
  }): Promise<Memory[]>
  /** Moves it to another project, or to none with `null`. */
  update(reference: string, change: { project: string | null }): Promise<Memory>
  /** The owner, or an agent for the owner, stands behind it; its evidence was checked now. */
  confirm(reference: string, by: Decider): Promise<Memory>
  /** Its evidence no longer holds. */
  markStale(reference: string): Promise<Memory>
  /**
   * Erases the memory: its row, its text in the search and meaning indexes, and every link from or to it. A memory
   * that replaced it no longer names it. A backup made before keeps it.
   */
  remove(reference: string): Promise<{ ref: string; removed: true; links: number }>
  /** Each reference it rests on, read back; one deleted since is `missing`. */
  sources(reference: string): Promise<EvidenceSource[]>
  /** Indexes what was written since, then finds memories holding every word or a longer one it starts, best first. */
  search(text: string, options?: { subject?: string; scope?: Memory["scope"]; limit?: number }): Promise<Memory[]>
  indexState(): Promise<NoteIndexState>
}

type Row = Record<string, unknown>
const NAMED =
  "SELECT m.*, b.name AS author_name FROM memories m LEFT JOIN bots b ON m.author_type = 'bot' AND b.id = m.author_id"
const iso = (value: unknown) => new Date(Number(value)).toISOString()

const oneOf = <T extends string>(value: unknown, allowed: readonly T[], what: string): T => {
  if (typeof value !== "string" || !allowed.includes(value as T))
    throw new CliError("validation_error", `${what} is one of ${allowed.join(", ")}`)
  return value as T
}

export const authorActor = (context: StoreContext, author: Author): { actor: Actor; model: string | null } => {
  if (author === "owner") return { actor: ownerPerson(context.database), model: null }
  return {
    actor: botNamed(context.database, author.bot, context.now(), author.kind ?? "agent"),
    model: author.model === undefined ? null : author.model.trim().slice(0, 200) || null,
  }
}

export const authorOf = (row: Row): Memory["author"] => ({
  type: row.author_type as Actor["type"],
  id: String(row.author_id),
  name: row.author_name == null ? null : String(row.author_name),
})

/** Writes `evidence` links from a row to each reference, refusing one the store does not hold. */
export const linkEvidence = (
  context: StoreContext,
  from: { type: string; id: number },
  references: string[],
  author: "owner" | "agent",
) => {
  const at = context.now()
  const insert = context.database.prepare(
    "INSERT INTO links (from_type, from_id, to_type, to_id, kind, source, confirmed, created_at, author, updated_at) " +
      `VALUES (?, ?, ?, ?, ${linkKind("evidence")}, ?, 1, ?, ?, ?)`,
  )
  for (const reference of references) {
    const thing = requiredThing(context.database, reference, "the evidence")
    insert.run(from.type, from.id, thing.type, thing.id, author === "owner" ? "owner" : "suggested", at, author, at)
  }
}

export const evidenceOf = (context: StoreContext, from: { type: string; id: number }): string[] =>
  context.database
    .prepare(
      `SELECT to_type, to_id FROM links WHERE from_type = ? AND from_id = ? AND kind = ${linkKind("evidence")} AND to_id IS NOT NULL ORDER BY id`,
    )
    .all(from.type, from.id)
    .flatMap((row) => referenceOfThing(context.database, storedThing(row.to_type, row.to_id)) ?? [])

const SUBJECT_NAMES: Record<string, string> = {
  person:
    "SELECT p.owner, coalesce(p.name, (SELECT a.name FROM aliases a WHERE a.aliasable_type = 'person' " +
    "AND a.aliasable_id = p.id ORDER BY a.display DESC, a.id LIMIT 1), (SELECT i.name FROM identity_links l " +
    "JOIN identities i ON i.id = l.identity_id WHERE l.person_id = p.id AND i.name IS NOT NULL ORDER BY i.id LIMIT 1)) " +
    "AS name FROM persons p WHERE p.id = ?",
  project: "SELECT 0 AS owner, name FROM projects WHERE id = ?",
  organization: "SELECT 0 AS owner, name FROM organizations WHERE id = ?",
}

/** What a memory's or fact's subject is called, for a reader who should not have to look the reference up. */
export const subjectOf = (
  database: StoreContext["database"],
  row: Row,
): Pick<Memory, "subject" | "subjectName" | "subjectIsOwner"> => {
  if (row.subject_type == null) return { subject: null, subjectName: null, subjectIsOwner: false }
  const thing = storedThing(row.subject_type, row.subject_id)
  const read = SUBJECT_NAMES[thing.type]
  const named = read === undefined ? undefined : database.prepare(read).get(thing.id)
  return {
    subject: referenceOfThing(database, thing) ?? null,
    subjectName: named?.name == null ? null : String(named.name),
    subjectIsOwner: Number(named?.owner) === 1,
  }
}

/** A memory's or fact's project, with its name, so a reader does not look the project up. */
export const projectOf = (database: StoreContext["database"], row: Row) => {
  if (row.project_id == null) return { project: null, projectName: null }
  const named = database.prepare(SUBJECT_NAMES.project as string).get(Number(row.project_id))
  return { project: `project:${row.project_id}`, projectName: named?.name == null ? null : String(named.name) }
}

/** A `project:<id>` the store holds, as its row id. */
export const projectId = (database: StoreContext["database"], reference: string): number => {
  const project = requiredThing(database, reference, "the project")
  if (project.type !== "project") throw new CliError("validation_error", `${reference} is not a project`)
  return project.id
}

type Numbered = "memories" | "facts"
const highestKey = (table: Numbered) => `ids.${table}.highest`

/**
 * The id the next row takes: above every row there is and every one forgotten. SQLite hands out the highest id + 1,
 * so without this a forgotten record's number would name the next one, and a stale `memory:N` act on it.
 */
export const nextId = (database: StoreContext["database"], table: Numbered): number => {
  const kept = database.prepare("SELECT value FROM store_settings WHERE key = ?").get(highestKey(table))
  const highest = database.prepare(`SELECT max(id) AS id FROM ${table}`).get()
  return Math.max(Number(kept?.value ?? 0), Number(highest?.id ?? 0)) + 1
}

/** Before a delete: remembers the highest id handed out, which the delete may be about to free. */
export const keepHighestId = (database: StoreContext["database"], table: Numbered, at: number): void => {
  const highest = nextId(database, table) - 1
  database
    .prepare("INSERT OR REPLACE INTO store_settings (key, value, at) VALUES (?, ?, ?)")
    .run(highestKey(table), String(highest), at)
}

/** Counts every link from or to a row and drops the ones its delete trigger does not: those pointing at it. */
export const dropLinksOf = (database: StoreContext["database"], thing: { type: string; id: number }): number => {
  const count = Number(
    database
      .prepare("SELECT count(*) AS n FROM links WHERE (from_type = ? AND from_id = ?) OR (to_type = ? AND to_id = ?)")
      .get(thing.type, thing.id, thing.type, thing.id)?.n,
  )
  database.prepare("DELETE FROM links WHERE to_type = ? AND to_id = ?").run(thing.type, thing.id)
  return count
}

/**
 * Runs a delete so the text does not linger in the file: freed pages are zeroed, the words indexes merged so no
 * segment still holds the erased words, and the write-ahead log emptied when no reader holds it.
 */
export const erase = <T>(database: StoreContext["database"], work: () => T): T => {
  database.exec("PRAGMA secure_delete = ON")
  try {
    const done = write(database, () => {
      const result = work()
      for (const index of ["memory_words", "memory_stems"])
        database.prepare(`INSERT INTO ${index} (${index}) VALUES ('optimize')`).run()
      return result
    })
    database.exec("PRAGMA wal_checkpoint(TRUNCATE)")
    return done
  } finally {
    database.exec("PRAGMA secure_delete = OFF")
  }
}

export const memoriesStoreOver = (context: StoreContext): MemoriesStore => {
  const { database, now } = context
  const stemmerFor: (stemmers: Stemmers) => Stemmer = stemmerCache()
  const memoryOf = (row: Row): Memory => ({
    id: String(row.id),
    ref: `memory:${row.id}`,
    kind: row.kind as Memory["kind"],
    body: String(row.body),
    ...subjectOf(database, row),
    ...projectOf(database, row),
    author: authorOf(row),
    model: row.model == null ? null : String(row.model),
    confidence: row.confidence == null ? null : Number(row.confidence),
    status: row.status as Memory["status"],
    scope: row.scope as Memory["scope"],
    supersedes: row.supersedes_id == null ? null : `memory:${row.supersedes_id}`,
    evidence: evidenceOf(context, { type: "memory", id: Number(row.id) }),
    lastVerifiedAt: row.last_verified_at == null ? null : iso(row.last_verified_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  })
  const rowOf = (reference: string): Row => {
    const thing = requiredThing(database, reference.includes(":") ? reference : `memory:${reference}`, "the memory")
    if (thing.type !== "memory") throw new CliError("validation_error", `${reference} is not a memory`)
    const row = database.prepare(`${NAMED} WHERE m.id = ?`).get(thing.id) as Row
    if (row.deleted_at != null) throw new CliError("not_found", `${reference} is a fact now: store.facts holds it`)
    return row
  }
  const setStatus = (reference: string, status: Memory["status"], verified: boolean) => {
    const row = rowOf(reference)
    const at = now()
    database
      .prepare(`UPDATE memories SET status = ?, updated_at = ?${verified ? ", last_verified_at = ?" : ""} WHERE id = ?`)
      .run(...(verified ? [status, at, at, Number(row.id)] : [status, at, Number(row.id)]))
    return memoryOf(rowOf(reference))
  }

  return {
    add: async (input) => {
      const kind = oneOf(input.kind, MEMORY_KINDS, "a memory's kind")
      if (input.scope === undefined || input.scope === null)
        throw new CliError("validation_error", "a memory needs its scope — personal or work; there is no default", {
          reason: "memory.scope-required",
        })
      const scope = oneOf(input.scope, MEMORY_SCOPES, "a memory's scope")
      if (!Array.isArray(input.evidence) || input.evidence.length === 0)
        throw new CliError("validation_error", "a memory needs at least one piece of evidence it rests on", {
          reason: "memory.evidence-required",
        })
      const body = input.body?.trim() ?? ""
      if (!body || body.length > 20_000)
        throw new CliError("validation_error", "a memory's body takes 1–20000 characters")
      if (input.confidence !== undefined && !(input.confidence >= 0 && input.confidence <= 1))
        throw new CliError("validation_error", "confidence takes 0–1")
      const status = oneOf(input.status ?? "proposed", ["proposed", "confirmed"] as const, "a new memory's status")
      const id = write(database, () => {
        const { actor, model } = authorActor(context, input.author)
        const subject = input.subject === undefined ? undefined : requiredThing(database, input.subject, "the subject")
        const project = input.project === undefined ? null : projectId(database, input.project)
        const replaced = input.supersedes === undefined ? undefined : Number(rowOf(input.supersedes).id)
        const at = now()
        const made = Number(
          database
            .prepare(
              "INSERT INTO memories (id, kind, body, subject_type, subject_id, author_type, author_id, model, confidence, status, " +
                "last_verified_at, supersedes_id, scope, project_id, created_at, updated_at) " +
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
            )
            .get(
              nextId(database, "memories"),
              kind,
              body,
              subject?.type ?? null,
              subject?.id ?? null,
              actor.type,
              actor.id,
              model,
              input.confidence ?? null,
              status,
              status === "confirmed" ? at : null,
              replaced ?? null,
              scope,
              project,
              at,
              at,
            )?.id,
        )
        linkEvidence(
          context,
          { type: "memory", id: made },
          input.evidence,
          input.author === "owner" ? "owner" : "agent",
        )
        if (replaced !== undefined)
          database.prepare("UPDATE memories SET status = 'superseded', updated_at = ? WHERE id = ?").run(at, replaced)
        return made
      })
      return memoryOf(rowOf(`memory:${id}`))
    },
    get: async (reference) => memoryOf(rowOf(reference)),
    list: async (options = {}) => {
      const subject = options.subject === undefined ? undefined : requiredThing(database, options.subject)
      const project = options.project === undefined ? null : projectId(database, options.project)
      return database
        .prepare(
          `${NAMED} WHERE m.deleted_at IS NULL AND (? IS NULL OR (m.subject_type = ? AND m.subject_id = ?)) ` +
            "AND (? IS NULL OR m.project_id = ?) AND (? IS NULL OR m.kind = ?) AND (? IS NULL OR m.status = ?) AND (? IS NULL OR m.scope = ?) " +
            "ORDER BY m.created_at DESC, m.id DESC LIMIT ?",
        )
        .all(
          subject?.type ?? null,
          subject?.type ?? null,
          subject?.id ?? null,
          project,
          project,
          options.kind ?? null,
          options.kind ?? null,
          options.status ?? null,
          options.status ?? null,
          options.scope ?? null,
          options.scope ?? null,
          Math.min(Math.max(options.limit ?? 100, 1), 500),
        )
        .map(memoryOf)
    },
    update: async (reference, change) =>
      write(database, () => {
        const id = Number(rowOf(reference).id)
        const project = change.project === null ? null : projectId(database, change.project)
        database.prepare("UPDATE memories SET project_id = ?, updated_at = ? WHERE id = ?").run(project, now(), id)
        return memoryOf(rowOf(`memory:${id}`))
      }),
    confirm: async (reference, by) => {
      const row = rowOf(reference)
      assertMayDecide({ id: `memory:${row.id}`, proposedBy: proposerOf(database, row.author_type, row.author_id) }, by)
      return setStatus(reference, "confirmed", true)
    },
    markStale: async (reference) => setStatus(reference, "stale", false),
    remove: async (reference) => {
      const id = Number(rowOf(reference).id)
      const links = erase(database, () => {
        keepHighestId(database, "memories", now())
        database.prepare("UPDATE memories SET supersedes_id = NULL WHERE supersedes_id = ?").run(id)
        const count = dropLinksOf(database, { type: "memory", id })
        database.prepare("DELETE FROM memories WHERE id = ?").run(id)
        return count
      })
      return { ref: `memory:${id}`, removed: true, links }
    },
    sources: async (reference) => evidenceSourcesOf(database, { type: "memory", id: Number(rowOf(reference).id) }),
    search: async (text, { subject: subjectRef, scope, limit = 20 } = {}) => {
      const subject = subjectRef === undefined ? undefined : requiredThing(database, subjectRef)
      drainCorpus(database, CORPORA.memory, stemmerFor)
      const words = normalize(text)
        .split(/\s+/)
        .filter((word) => /[\p{L}\p{N}]/u.test(word))
      if (words.length === 0) throw new CliError("validation_error", "say what to find in the memories")
      const match = `normalized_text : (${words.map((word) => `"${word.replaceAll('"', '""')}"*`).join(" AND ")})`
      return database
        .prepare(
          "SELECT m.*, b.name AS author_name FROM memory_words w JOIN memories m ON m.id = w.rowid " +
            "LEFT JOIN bots b ON m.author_type = 'bot' AND b.id = m.author_id WHERE memory_words MATCH ? " +
            "AND m.deleted_at IS NULL AND (? IS NULL OR (m.subject_type = ? AND m.subject_id = ?)) " +
            "AND (? IS NULL OR m.scope = ?) ORDER BY bm25(memory_words), m.id LIMIT ?",
        )
        .all(
          match,
          subject?.type ?? null,
          subject?.type ?? null,
          subject?.id ?? null,
          scope ?? null,
          scope ?? null,
          Math.min(Math.max(limit, 1), 200),
        )
        .map(memoryOf)
    },
    indexState: async () => corpusIndexState(database, CORPORA.memory),
  }
}
