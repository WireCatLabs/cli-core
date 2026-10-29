import { CliError } from "@wirecat/cli-base"
import { type QueryAst, walkQuery } from "@wirecat/cli-base/query"
import { parseLocator } from "../../domain/locator.js"
import { formatReference, parseReference, type Reference } from "../../domain/references.js"
import { normalizeTag } from "../../domain/tags.js"
import { normalizeVocabularyName } from "../../domain/vocabulary.js"
import { formatMeetingReference } from "../../meetings/index.js"
import type { AccountKey } from "../types.js"
import { ulid } from "../ulid.js"
import { ownerPerson } from "./actors.js"
import { linkKind, RELATION_KINDS } from "./link-kinds.js"
import { type MeetingProjectsStore, meetingProjectsStoreOver } from "./meeting-projects.js"
import { insertLink, type Link, linkOf } from "./notes.js"
import type { StoreContext } from "./open.js"
import { queryFilter } from "./query-filter.js"
import type { TagCreationOptions } from "./tag-creation.js"
import {
  addTags as addThingTags,
  canonicalTagNamed,
  createTag,
  type Label,
  labelsOf,
  liveTagging,
  removeTags as removeThingTags,
  setMainTopic,
  type TagKind,
  type TagRow,
} from "./tags.js"
import { INBOX_KEY_LENGTH, TASK_KEY_PREFIXES } from "./task-keys.js"
import { inboxKey, taskAccountOf, taskIdOf, taskRowOf } from "./tasks.js"
import { referenceOfThing, stateOfThing, storedThing, type Thing, type ThingState, thingOf } from "./things.js"
import { write } from "./transaction.js"
import { type VocabularyStore, vocabularyStoreOver } from "./vocabulary.js"

const TYPED_KEY_PREFIXES: ReadonlySet<string> = new Set(Object.values(TASK_KEY_PREFIXES))

export type { Label } from "./tags.js"

export type KnowledgeTarget =
  | { type: "message"; locator: string }
  | { type: "chat"; id: string }
  | { type: "contact"; id: string }
  | { type: "person"; id: string }
  | { type: "task"; id: string }
  | { type: "organization"; id: string }
  | { type: "project"; id: string }
  | { type: "note"; id: string }
  | { type: "document"; id: string }
  /** A meeting by its store id; one account's, like a chat. */
  | { type: "meeting"; id: string }
  /** A notes folder by id; `path` names one subfolder inside it, `null` or absent the whole folder. */
  | { type: "folder"; id: string; path?: string | null }

/**
 * Whose records a call reads: an account, or `null` for the owner's own — notes, people, organizations,
 * projects, tasks and folders belong to no account. A chat or contact target still needs its account.
 */
export type KnowledgeScope = AccountKey | null

export interface Annotation {
  id: string
  target: KnowledgeTarget
  targetState: ThingState
  text: string
  revision: number
  authoredBy: "owner"
  createdAt: string
  updatedAt: string
}

export const ORGANIZATION_KINDS = ["company", "team", "family", "community"] as const
export const PROJECT_TYPES = ["work", "client", "personal", "oss", "other"] as const
export const SCOPES = ["personal", "work"] as const

export interface Organization {
  id: string
  ref: string
  kind: (typeof ORGANIZATION_KINDS)[number]
  name: string
  scope: (typeof SCOPES)[number]
  createdAt: string
}

export interface Project {
  id: string
  ref: string
  key: string
  name: string
  /** `inbox`: the per-account project that holds an account's tasks; listed only when asked for. */
  kind: "project" | "inbox"
  type: (typeof PROJECT_TYPES)[number]
  organizationId: string | null
  scope: (typeof SCOPES)[number]
  createdAt: string
}

export interface KnowledgeRelation {
  id: string
  from: string
  to: string
  kind: (typeof RELATION_KINDS)[number]
  role: string | null
  evidence: string | null
  confirmed: boolean
  provenance: string | null
  confidenceCategory: "owner-confirmed" | "weak"
  createdAt: string
}

export interface Reminder {
  id: string
  task: string
  dueAt: string
  timezone: string
  state: "pending" | "leased" | "delivered" | "cancelled"
  revision: number
  receipt: string | null
}

export type LabelledType = "note" | "document" | "person" | "organization" | "project" | "task" | "meeting" | "folder"

export interface KnowledgeStore extends VocabularyStore, MeetingProjectsStore {
  taskIds(
    key: AccountKey,
    options?: { state?: "open" | "done" | "dismissed"; limit?: number; offset?: number; sources?: string[] },
  ): Promise<{ items: string[]; hasMore: boolean }>
  addAnnotation(key: KnowledgeScope, target: KnowledgeTarget, text: string): Promise<Annotation>
  annotations(
    key: KnowledgeScope,
    options?: { target?: KnowledgeTarget; search?: string; limit?: number; offset?: number },
  ): Promise<{ items: Annotation[]; hasMore: boolean }>
  annotation(key: KnowledgeScope, id: string): Promise<Annotation>
  editAnnotation(key: KnowledgeScope, id: string, text: string, revision: number): Promise<Annotation>
  removeAnnotation(key: KnowledgeScope, id: string): Promise<{ id: string; removed: true }>
  tags(key: KnowledgeScope, target: KnowledgeTarget, tag?: string): Promise<string[]>
  addTags(key: KnowledgeScope, target: KnowledgeTarget, tags: string[]): Promise<string[]>
  removeTags(key: KnowledgeScope, target: KnowledgeTarget, tags: string[]): Promise<string[]>
  /**
   * A new tag or topic. Only the owner makes a topic (an agent proposes one: `actions.propose`), and a
   * name held by a tag cannot become a topic, nor the other way round.
   */
  createTag(name: string, options?: { kind?: TagKind; by?: "owner" | "agent" } & TagCreationOptions): Promise<TagRow>
  /** Marks a topic as the thing's main one, or clears it with `null`; one per thing. */
  setMainTopic(key: KnowledgeScope, target: KnowledgeTarget, topic: string | null): Promise<void>
  /** Every labelled note, document, person, organization, project, task and folder. */
  labelled(
    key: KnowledgeScope,
    options?: { tag?: string; type?: LabelledType; limit?: number; offset?: number },
  ): Promise<{
    items: { target: KnowledgeTarget; tags: string[]; labels: Label[]; targetState: ThingState }[]
    hasMore: boolean
  }>
  addOrganization(input: {
    kind: Organization["kind"]
    name: string
    scope?: Organization["scope"]
  }): Promise<Organization>
  organizations(query?: QueryAst): Promise<Organization[]>
  /** A project; its key is made from the name when none is given. */
  addProject(input: {
    name: string
    key?: string
    type?: Project["type"]
    organization?: string
    scope?: Project["scope"]
    description?: string
  }): Promise<Project>
  projects(query?: QueryAst): Promise<Project[]>
  relate(
    key: KnowledgeScope,
    input: {
      from: string
      to: string
      kind: KnowledgeRelation["kind"]
      role?: string
      evidence?: string
      confirmed?: boolean
      provenance?: string
    },
  ): Promise<KnowledgeRelation>
  relations(key: KnowledgeScope, reference?: string): Promise<KnowledgeRelation[]>
  removeRelation(key: KnowledgeScope, id: string): Promise<{ id: string; removed: true }>
  confirmRelation(key: KnowledgeScope, id: string): Promise<KnowledgeRelation>
  schedule(key: AccountKey, task: string, dueAt: string, timezone: string): Promise<Reminder>
  reminders(key: AccountKey, query?: QueryAst): Promise<Reminder[]>
  cancelReminder(key: AccountKey, id: string): Promise<Reminder>
  snoozeReminder(key: AccountKey, id: string, dueAt: string, revision: number): Promise<Reminder>
  claimReminders(key: AccountKey, options?: { limit?: number; leaseMs?: number }): Promise<Reminder[]>
  acknowledgeReminder(key: AccountKey, id: string, receipt: string): Promise<Reminder>
}

type Row = Record<string, unknown>
const iso = (value: unknown) => new Date(Number(value)).toISOString()
const bounded = (limit = 100, offset = 0) => {
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 500 ||
    !Number.isInteger(offset) ||
    offset < 0 ||
    offset > 100_000
  )
    throw new CliError("validation_error", "limit takes 1–500 and offset takes 0–100000")
  return { limit, offset }
}
const textOf = (text: string, max = 100_000) => {
  const value = text.trim()
  if (!value || value.length > max) throw new CliError("validation_error", `text takes 1–${max} characters`)
  return value
}
const oneOf = <T extends string>(value: string, allowed: readonly T[], what: string): T => {
  if (!allowed.includes(value as T)) throw new CliError("validation_error", `${what} is one of ${allowed.join(", ")}`)
  return value as T
}

/** What a relationship may connect. */
const RELATED = ["person", "organization", "project", "task"]
/** What a label without an account may sit on; a chat, contact or message is the messenger's tag. */
const LABELLED: Record<string, LabelledType> = {
  note: "note",
  document: "document",
  person: "person",
  organization: "organization",
  project: "project",
  task: "task",
  meeting: "meeting",
  account: "folder",
}

export const knowledgeStoreOver = (context: StoreContext): KnowledgeStore => {
  const { database, now } = context
  const account = (key: AccountKey) => {
    const row = database
      .prepare("SELECT id FROM accounts WHERE provider=? AND external_id=?")
      .get(key.provider, key.account)
    if (!row) throw new CliError("not_found", "the account is not in the local store")
    return Number(row.id)
  }
  const checked = (key: KnowledgeScope) => {
    if (key !== null) account(key)
  }
  const taskAccount = (key: AccountKey) => `${key.provider}:${key.account}`

  /** The typed reference a target names, checked against the account when one is given. */
  const referenceOf = (key: KnowledgeScope, target: KnowledgeTarget): Reference | string => {
    if (target.type === "message") {
      const locator = parseLocator(target.locator)
      if (locator.provider === "notes")
        throw new CliError("validation_error", "a note is named note:<id> or document:<id>, not by a msg: locator")
      if (key !== null && (locator.provider !== key.provider || locator.account !== key.account))
        throw new CliError("validation_error", "the locator belongs to another account")
      return { type: "message", ...locator }
    }
    if (
      ![
        "chat",
        "contact",
        "person",
        "task",
        "organization",
        "project",
        "note",
        "document",
        "meeting",
        "folder",
      ].includes(target.type)
    )
      throw new CliError("validation_error", "unknown knowledge target")
    if (!target.id.trim()) throw new CliError("validation_error", "target id must not be empty")
    if (target.type === "folder")
      return parseReference(formatReference({ type: "folder", id: target.id, path: target.path ?? null }))
    if (key === null && (target.type === "chat" || target.type === "contact" || target.type === "meeting"))
      throw new CliError("validation_error", `a ${target.type} is one account's — name the account`)
    if (target.type === "meeting") {
      if (!/^[1-9]\d{0,15}$/.test(target.id)) throw new CliError("validation_error", "a meeting id is a store id")
      return formatMeetingReference({
        type: "meeting",
        accountId: account(key as AccountKey),
        meetingId: Number(target.id),
      })
    }
    if (target.type === "chat")
      return {
        type: "chat",
        provider: (key as AccountKey).provider,
        account: (key as AccountKey).account,
        chat: target.id,
      }
    if (target.type === "contact") return { type: "contact", provider: (key as AccountKey).provider, id: target.id }
    return { type: target.type, id: target.id }
  }
  const targetOfThing = (thing: Thing): KnowledgeTarget | undefined => {
    if (thing.type === "meeting") return { type: "meeting", id: String(thing.id) }
    const reference = referenceOfThing(database, thing)
    if (reference === undefined || reference.startsWith("meeting:")) return undefined
    const parsed = parseReference(reference)
    if (parsed.type === "message") return { type: "message", locator: reference }
    if (parsed.type === "chat") return { type: "chat", id: parsed.chat }
    if (parsed.type === "folder") return { type: "folder", id: parsed.id, path: parsed.path }
    if (parsed.type === "entity" || parsed.type === "memory" || parsed.type === "fact" || parsed.type === "bot")
      return undefined
    return { type: parsed.type, id: parsed.id }
  }
  /** A target's row, with its state; a task named with an account must be that account's. */
  const resolve = (key: KnowledgeScope, target: KnowledgeTarget): { thing?: Thing; state: ThingState } => {
    checked(key)
    const thing = thingOf(database, referenceOf(key, target))
    if (thing?.type === "task" && key !== null && taskAccountOf(database, thing.id) !== taskAccount(key))
      return { state: "unavailable" }
    return thing ? { thing, state: stateOfThing(database, thing) } : { state: "unavailable" }
  }
  const available = (key: KnowledgeScope, target: KnowledgeTarget): Thing => {
    const { thing, state } = resolve(key, target)
    if (!thing || state !== "available") throw new CliError("not_found", "the target is unavailable or deleted")
    return thing
  }
  const subfolder = (target: KnowledgeTarget) =>
    target.type === "folder"
      ? (
          parseReference(formatReference({ type: "folder", id: target.id, path: target.path ?? null })) as {
            path: string | null
          }
        ).path
      : null

  /** A subfolder's labels: `labelled` links from the folder, anchored at the path, to each tag. */
  const subfolderLabels = (folder: number, path: string, tag?: string) =>
    database
      .prepare(
        "SELECT DISTINCT t.name FROM links l JOIN resolved_tags t ON t.id=l.to_id WHERE l.from_type = 'account' AND l.from_id = ? " +
          `AND l.kind = ${linkKind("labelled")} AND l.to_type = 'tag' AND l.anchor = ?${tag === undefined ? "" : " AND t.name = ?"} ORDER BY t.name`,
      )
      .all(folder, path, ...(tag === undefined ? [] : [tag]))
      .map((row) => String(row.name))

  const annotationOf = (row: Row): Annotation | undefined => {
    const thing = storedThing(row.notable_type, row.notable_id)
    const target = targetOfThing(thing)
    if (!target) return undefined
    return {
      id: String(row.id),
      target,
      targetState: stateOfThing(database, thing),
      text: String(row.body),
      revision: Number(row.revision),
      authoredBy: "owner",
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
    }
  }
  const noteRow = (id: string) =>
    /^\d+$/.test(id)
      ? database.prepare("SELECT * FROM notes WHERE id = ? AND deleted_at IS NULL").get(Number(id))
      : undefined
  const annotation = (key: KnowledgeScope, id: string): Annotation => {
    checked(key)
    const row = noteRow(id)
    const found = row && annotationOf(row)
    if (!found) throw new CliError("not_found", "no annotation with that id")
    return found
  }

  const organizationOf = (row: Row): Organization => ({
    id: String(row.id),
    ref: `organization:${row.id}`,
    kind: row.kind as Organization["kind"],
    name: String(row.name),
    scope: row.scope as Organization["scope"],
    createdAt: iso(row.created_at),
  })
  const projectOf = (row: Row): Project => ({
    id: String(row.id),
    ref: `project:${row.id}`,
    key: String(row.key),
    name: String(row.name),
    kind: String(row.key).length === INBOX_KEY_LENGTH ? "inbox" : "project",
    type: row.type as Project["type"],
    organizationId: row.organization_id == null ? null : String(row.organization_id),
    scope: row.scope as Project["scope"],
    createdAt: iso(row.created_at),
  })

  const relationOf = (link: Link): KnowledgeRelation => ({
    id: link.id,
    from: link.from,
    to: String(link.to),
    kind: link.kind as KnowledgeRelation["kind"],
    role: link.role,
    evidence: link.evidence,
    confirmed: link.confirmed,
    provenance: link.provenance,
    confidenceCategory: link.confirmed ? "owner-confirmed" : "weak",
    createdAt: link.createdAt,
  })
  const RELATIONS = `SELECT * FROM links WHERE kind IN (${RELATION_KINDS.map(linkKind).join(",")}) AND to_id IS NOT NULL`
  const relation = (id: string) => {
    const row = /^\d+$/.test(id) ? database.prepare(`${RELATIONS} AND id = ?`).get(Number(id)) : undefined
    if (!row) throw new CliError("not_found", "no relationship with that id")
    return row
  }
  /** A chat may only be the member: its reference names its own account, so it is never another account's. */
  const related = (key: KnowledgeScope, reference: string, member = false): Thing => {
    checked(key)
    const thing = thingOf(database, reference)
    const chat = member && (thing?.type === "chat" || thing?.type === "email_thread")
    if (!thing || !(RELATED.includes(thing.type) || chat) || stateOfThing(database, thing) !== "available")
      throw new CliError(
        "not_found",
        `reference needs a stored person:, organization:, project:${member ? ", task: or chat:" : " or task:"}`,
      )
    if (chat && key !== null) {
      const parsed = parseReference(reference) as { provider: string; account: string }
      if (parsed.provider !== key.provider || parsed.account !== key.account)
        throw new CliError("validation_error", "the chat belongs to another account")
    }
    return thing
  }

  const reminderOf = (row: Row): Reminder => ({
    id: String(row.id),
    task: taskIdOf(database, Number(row.task_id)) ?? String(row.task_id),
    dueAt: iso(row.due_at),
    timezone: String(row.timezone),
    state: row.state as Reminder["state"],
    revision: Number(row.revision),
    receipt: row.receipt == null ? null : String(row.receipt),
  })
  const reminder = (key: AccountKey, id: string) => {
    const row = /^\d+$/.test(id)
      ? database.prepare("SELECT * FROM reminders WHERE account_id=? AND id=?").get(account(key), Number(id))
      : undefined
    if (!row) throw new CliError("not_found", "no reminder with that id in this account")
    return reminderOf(row)
  }
  const due = (value: string) => {
    if (!/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value)))
      throw new CliError("validation_error", "due time needs an ISO timestamp with an explicit UTC offset")
    return Date.parse(value)
  }
  const openTask = (key: AccountKey, id: string): number => {
    const row = taskRowOf(database, id)
    const open =
      row !== undefined &&
      taskAccountOf(database, row) === taskAccount(key) &&
      database.prepare("SELECT status FROM tasks WHERE id = ?").get(row)?.status === "open"
    if (!open) throw new CliError("validation_error", "a reminder requires an open task in this account")
    return row as number
  }
  const canonicalTagName = (name: string) => canonicalTagNamed(database, name)?.name ?? normalizeTag(name)
  const tagsOf = (list: string[]) => [...new Set(list.map(canonicalTagName))]

  return {
    ...vocabularyStoreOver(context),
    ...meetingProjectsStoreOver(context),
    taskIds: async (key, options = {}) => {
      const { limit, offset } = bounded(options.limit, options.offset)
      if (options.state !== undefined && !["open", "done", "dismissed"].includes(options.state))
        throw new CliError("validation_error", "unknown task state")
      if (options.sources && options.sources.length > 2000)
        throw new CliError("validation_error", "select at most 2000 task sources")
      if (options.sources?.length === 0) return { items: [], hasMore: false }
      account(key)
      const rows = database
        .prepare(
          "SELECT t.key, t.package_id AS id FROM tasks t JOIN projects p ON p.id = t.project_id " +
            "WHERE p.key = ? AND t.deleted_at IS NULL AND (? IS NULL OR t.status = ?) " +
            `${options.sources ? `AND t.source_locator IN (${options.sources.map(() => "?").join(",")}) ` : ""}` +
            "ORDER BY t.created_at, t.id LIMIT ? OFFSET ?",
        )
        .all(
          inboxKey(taskAccount(key)),
          options.state ?? null,
          options.state ?? null,
          ...(options.sources ?? []),
          limit + 1,
          offset,
        )
      return { items: rows.slice(0, limit).map((row) => String(row.id ?? row.key)), hasMore: rows.length > limit }
    },
    addAnnotation: async (key, target, text) => {
      const body = textOf(text)
      if (subfolder(target) !== null)
        throw new CliError("validation_error", "annotate a folder, not one of its subfolders")
      const thing = available(key, target)
      const at = now()
      const id = write(database, () => {
        const owner = ownerPerson(database)
        return Number(
          database
            .prepare(
              "INSERT INTO notes (notable_type, notable_id, body, author_type, author_id, revision, created_at, updated_at) " +
                "VALUES (?, ?, ?, ?, ?, 1, ?, ?) RETURNING id",
            )
            .get(thing.type, thing.id, body, owner.type, owner.id, at, at)?.id,
        )
      })
      return annotation(key, String(id))
    },
    annotations: async (key, options = {}) => {
      const { limit, offset } = bounded(options.limit, options.offset)
      checked(key)
      const thing = options.target ? resolve(key, options.target).thing : undefined
      if (options.target && !thing) return { items: [], hasMore: false }
      const rows = database
        .prepare(
          "SELECT * FROM notes WHERE deleted_at IS NULL AND (? IS NULL OR (notable_type = ? AND notable_id = ?)) " +
            "AND (? IS NULL OR instr(lower(body), lower(?)) > 0) ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?",
        )
        .all(
          thing?.type ?? null,
          thing?.type ?? null,
          thing?.id ?? null,
          options.search ?? null,
          options.search ?? null,
          limit + 1,
          offset,
        )
      const items = rows.slice(0, limit).flatMap((row) => annotationOf(row) ?? [])
      return { items, hasMore: rows.length > limit }
    },
    annotation: async (key, id) => annotation(key, id),
    editAnnotation: async (key, id, text, revision) => {
      const held = annotation(key, id)
      const changed = database
        .prepare("UPDATE notes SET body=?, revision=revision+1, updated_at=? WHERE id=? AND revision=?")
        .run(textOf(text), now(), Number(id), revision).changes
      if (!changed)
        throw new CliError("validation_error", "annotation changed; read the current revision before editing")
      database
        .prepare("INSERT INTO note_revisions (note_id, body, revision, created_at) VALUES (?, ?, ?, ?)")
        .run(Number(id), held.text, held.revision, now())
      return annotation(key, id)
    },
    removeAnnotation: async (key, id) => {
      annotation(key, id)
      database.prepare("DELETE FROM notes WHERE id=?").run(Number(id))
      return { id, removed: true }
    },
    tags: async (key, target, tag) => {
      const { thing, state } = resolve(key, target)
      if (!thing || state !== "available") return []
      const path = subfolder(target)
      const name = tag === undefined ? undefined : canonicalTagName(tag)
      return path === null
        ? labelsOf(database, thing, name).map(({ tag }) => tag)
        : subfolderLabels(thing.id, path, name)
    },
    addTags: async (key, target, tags) => {
      const thing = available(key, target)
      const path = subfolder(target)
      const names = tagsOf(tags)
      if (path === null) return write(database, () => addThingTags(context, thing, names))
      return write(database, () =>
        names.filter((name) => {
          if (subfolderLabels(thing.id, path).includes(name)) return false
          const tag = canonicalTagNamed(database, name) ?? createTag(context, name, "tag", "owner")
          const at = now()
          database
            .prepare(
              "INSERT INTO links (from_type, from_id, to_type, to_id, kind, anchor, source, confirmed, created_at, author, updated_at) " +
                `VALUES ('account', ?, 'tag', ?, ${linkKind("labelled")}, ?, 'owner', 1, ?, 'owner', ?)`,
            )
            .run(thing.id, tag.id, path, at, at)
          return true
        }),
      )
    },
    removeTags: async (key, target, tags) => {
      const { thing, state } = resolve(key, target)
      if (!thing || state !== "available") return []
      const path = subfolder(target)
      if (path === null) return write(database, () => removeThingTags(context, thing, tagsOf(tags)))
      return tagsOf(tags).filter(
        (name) =>
          database
            .prepare(
              `DELETE FROM links WHERE from_type = 'account' AND from_id = ? AND kind = ${linkKind("labelled")} AND to_type = 'tag' AND anchor = ? ` +
                "AND to_id IN (SELECT id FROM resolved_tags WHERE name = ?)",
            )
            .run(thing.id, path, name).changes > 0,
      )
    },
    createTag: async (name, { kind = "tag", by = "owner", ...options } = {}) =>
      write(database, () => createTag(context, canonicalTagName(name), kind, by, options)),
    setMainTopic: async (key, target, topic) => {
      const thing = available(key, target)
      write(database, () => setMainTopic(context, thing, topic === null ? null : canonicalTagName(topic)))
    },
    labelled: async (key, options = {}) => {
      const { limit, offset } = bounded(options.limit, options.offset)
      checked(key)
      const tag = options.tag === undefined ? null : canonicalTagName(options.tag)
      const types = Object.entries(LABELLED)
        .filter(([, type]) => options.type === undefined || type === options.type)
        .map(([table]) => table)
      const subfolders = options.type === undefined || options.type === "folder"
      const rows = database
        .prepare(
          "SELECT * FROM (" +
            "SELECT DISTINCT g.taggable_type AS type, g.taggable_id AS id, NULL AS path FROM taggings g JOIN resolved_tags t ON t.id=g.tag_id " +
            `WHERE g.taggable_type IN (${types.map(() => "?").join(",") || "NULL"}) AND (? IS NULL OR t.name = ?) AND ${liveTagging("g")} ` +
            "UNION SELECT DISTINCT 'account' AS type, l.from_id AS id, l.anchor AS path FROM links l JOIN resolved_tags t ON t.id=l.to_id " +
            `WHERE ? = 1 AND l.from_type = 'account' AND l.kind = ${linkKind("labelled")} AND l.to_type = 'tag' AND (? IS NULL OR t.name = ?)` +
            ") ORDER BY type = 'account', type, id, path LIMIT ? OFFSET ?",
        )
        .all(...types, tag, tag, subfolders ? 1 : 0, tag, tag, limit + 1, offset)
      return {
        items: rows.slice(0, limit).flatMap((row) => {
          const thing = storedThing(row.type, row.id)
          const base = targetOfThing(thing)
          if (!base) return []
          const path = row.path == null ? null : String(row.path)
          const labels: Label[] =
            path === null
              ? labelsOf(database, thing)
              : subfolderLabels(thing.id, path).map((name) => ({ tag: name, origin: "owner" as const }))
          const target: KnowledgeTarget = base.type === "folder" ? { ...base, path } : base
          return [
            { target, tags: labels.map((label) => label.tag), labels, targetState: stateOfThing(database, thing) },
          ]
        }),
        hasMore: rows.length > limit,
      }
    },
    addOrganization: async ({ kind, name, scope = "personal" }) => {
      const at = now()
      const row = database
        .prepare(
          "INSERT INTO organizations (kind, name, scope, created_at, updated_at) VALUES (?, ?, ?, ?, ?) RETURNING *",
        )
        .get(
          oneOf(kind, ORGANIZATION_KINDS, "an organization's kind"),
          textOf(name, 200),
          oneOf(scope, SCOPES, "a scope"),
          at,
          at,
        )
      return organizationOf(row as Row)
    },
    organizations: async (query) => {
      const where =
        query &&
        queryFilter(query, {
          id: { type: "kw", sql: "CAST(id AS TEXT)" },
          kind: { type: "enum", sql: "kind" },
          scope: { type: "enum", sql: "scope" },
          created_at: { type: "time", sql: "created_at" },
        })
      return database
        .prepare(
          `SELECT * FROM organizations WHERE deleted_at IS NULL${where ? ` AND (${where.sql})` : ""} ORDER BY name, id LIMIT 500`,
        )
        .all(...(where?.params ?? []))
        .map(organizationOf)
    },
    addProject: async ({ name, key, type = "other", organization, scope = "personal", description }) =>
      write(database, () => {
        const title = textOf(name, 200)
        const organizationId =
          organization === undefined
            ? null
            : (() => {
                const thing = thingOf(database, organization)
                if (thing?.type !== "organization") throw new CliError("not_found", `no organization ${organization}`)
                return thing.id
              })()
        const wanted = key === undefined ? projectKey(title) : key.trim().toUpperCase()
        if (!/^[A-Z][A-Z0-9]{2,3}$/.test(wanted))
          throw new CliError("validation_error", "a new project key is 3–4 letters and digits, starting with a letter")
        const aliasName = (() => {
          try {
            return normalizeVocabularyName(title)
          } catch {
            return null
          }
        })()
        const alias = database
          .prepare(
            "SELECT DISTINCT p.id,p.name FROM aliases a JOIN projects p ON p.id=a.aliasable_id " +
              "WHERE a.aliasable_type='project' AND a.account_id IS NULL AND p.account_id IS NULL AND p.deleted_at IS NULL " +
              "AND a.name_folded IN (?,?) LIMIT 2",
          )
          .all(aliasName, normalizeVocabularyName(wanted))
        if (alias.length)
          throw new CliError("configuration_error", "the project name or key already aliases an existing project", {
            reason: "vocabulary.alias-conflict",
            candidates: alias.map((row) => ({ kind: "project", id: String(row.id), name: String(row.name) })),
          })
        if (key !== undefined && TYPED_KEY_PREFIXES.has(wanted))
          throw new CliError(
            "validation_error",
            `the project key ${wanted} is kept for the keys of tasks found in messages`,
          )
        let chosen = wanted
        for (
          let n = 2;
          TYPED_KEY_PREFIXES.has(chosen) ||
          database.prepare("SELECT 1 FROM projects WHERE key = ?").get(chosen) ||
          database
            .prepare(
              "SELECT 1 FROM aliases a JOIN projects p ON p.id=a.aliasable_id WHERE a.aliasable_type='project' AND a.account_id IS NULL AND p.account_id IS NULL AND p.deleted_at IS NULL AND a.name_folded=? LIMIT 1",
            )
            .get(normalizeVocabularyName(chosen));
          n++
        ) {
          if (key !== undefined) throw new CliError("validation_error", `the project key ${wanted} is taken`)
          const suffix = String(n)
          if (suffix.length > 3)
            throw new CliError("validation_error", "no short project key is available; choose an explicit key")
          chosen = `${wanted.slice(0, 4 - suffix.length)}${suffix}`
        }
        const at = now()
        const row = database
          .prepare(
            "INSERT INTO projects (key, name, description, type, organization_id, scope, tasks_count, status, created_at, updated_at) " +
              "VALUES (?, ?, ?, ?, ?, ?, 0, 'active', ?, ?) RETURNING *",
          )
          .get(
            chosen,
            title,
            description === undefined ? null : textOf(description, 2000),
            oneOf(type, PROJECT_TYPES, "a project's type"),
            organizationId,
            oneOf(scope, SCOPES, "a scope"),
            at,
            at,
          )
        return projectOf(row as Row)
      }),
    projects: async (query) => {
      const asksKind = query !== undefined && walkQuery(query.root).some((node) => node.field === "kind")
      const where =
        query &&
        queryFilter(query, {
          id: { type: "kw", sql: "CAST(id AS TEXT)" },
          key: { type: "kw", sql: "key" },
          name: { type: "kw", sql: "name" },
          kind: { type: "enum", sql: `CASE WHEN length(key) = ${INBOX_KEY_LENGTH} THEN 'inbox' ELSE 'project' END` },
          type: { type: "enum", sql: "type" },
          organization_id: { type: "kw", sql: "CAST(organization_id AS TEXT)" },
          scope: { type: "enum", sql: "scope" },
          created_at: { type: "time", sql: "created_at" },
        })
      return database
        .prepare(
          `SELECT * FROM projects WHERE deleted_at IS NULL${asksKind ? "" : ` AND length(key) <> ${INBOX_KEY_LENGTH}`}${where ? ` AND (${where.sql})` : ""} ORDER BY name, id LIMIT 500`,
        )
        .all(...(where?.params ?? []))
        .map(projectOf)
    },
    relate: async (key, input) => {
      const from = related(key, input.from, true)
      const to = related(key, input.to)
      if ((from.type === to.type && from.id === to.id) || !RELATION_KINDS.includes(input.kind))
        throw new CliError("validation_error", "a relationship needs distinct references and a supported kind")
      if (
        (from.type === "chat" || from.type === "email_thread") &&
        (input.kind !== "member-of" || to.type !== "project")
      )
        throw new CliError("validation_error", "a chat is related only as member-of a project")
      const existing = database
        .prepare(`${RELATIONS} AND from_type=? AND from_id=? AND to_type=? AND to_id=? AND kind=?`)
        .get(from.type, from.id, to.type, to.id, input.kind)
      if (existing) return relationOf(linkOf(database, existing))
      const confirmed = input.confirmed !== false
      return relationOf(
        write(database, () =>
          insertLink(context, {
            from: input.from,
            to: input.to,
            kind: input.kind,
            origin: confirmed ? "owner" : "suggested",
            confirmed,
            ...(input.role === undefined ? {} : { role: input.role }),
            ...(input.evidence === undefined ? {} : { evidence: input.evidence }),
            ...(input.provenance === undefined ? {} : { provenance: input.provenance }),
          }),
        ),
      )
    },
    relations: async (key, reference) => {
      checked(key)
      const thing = reference === undefined ? undefined : thingOf(database, reference)
      if (reference !== undefined && !thing) return []
      return database
        .prepare(
          `${RELATIONS} AND (? IS NULL OR (from_type=? AND from_id=?) OR (to_type=? AND to_id=?)) ORDER BY created_at, id LIMIT 500`,
        )
        .all(thing?.type ?? null, thing?.type ?? null, thing?.id ?? null, thing?.type ?? null, thing?.id ?? null)
        .map((row) => relationOf(linkOf(database, row)))
    },
    removeRelation: async (key, id) => {
      checked(key)
      relation(id)
      database.prepare("DELETE FROM links WHERE id = ?").run(Number(id))
      return { id, removed: true }
    },
    confirmRelation: async (key, id) => {
      checked(key)
      const row = relation(id)
      const link = linkOf(database, row)
      related(key, link.from, true)
      related(key, String(link.to))
      database
        .prepare("UPDATE links SET confirmed=1, source='owner', author='owner', updated_at=? WHERE id=?")
        .run(now(), Number(id))
      return relationOf(linkOf(database, database.prepare("SELECT * FROM links WHERE id = ?").get(Number(id)) as Row))
    },
    schedule: async (key, task, dueAt, timezone) => {
      const row = openTask(key, task)
      try {
        new Intl.DateTimeFormat("en", { timeZone: timezone }).format()
      } catch {
        throw new CliError("validation_error", "unknown IANA timezone")
      }
      const timestamp = due(dueAt)
      const accountId = account(key)
      const existing = database
        .prepare(
          "SELECT * FROM reminders WHERE account_id=? AND task_id=? AND due_at=? AND state IN ('pending','leased')",
        )
        .get(accountId, row, timestamp)
      if (existing) return reminderOf(existing)
      const at = now()
      const made = database
        .prepare(
          "INSERT INTO reminders (task_id, account_id, due_at, timezone, state, revision, created_at, updated_at) " +
            "VALUES (?, ?, ?, ?, 'pending', 1, ?, ?) RETURNING id",
        )
        .get(row, accountId, timestamp, timezone, at, at)
      return reminder(key, String(made?.id))
    },
    reminders: async (key, query) => {
      const where =
        query &&
        queryFilter(query, {
          id: { type: "kw", sql: "CAST(id AS TEXT)" },
          state: { type: "enum", sql: "state" },
          due_at: { type: "time", sql: "due_at" },
          revision: { type: "num", sql: "revision" },
        })
      return database
        .prepare(
          `SELECT * FROM reminders WHERE account_id=?${where ? ` AND (${where.sql})` : ""} ORDER BY due_at, id LIMIT 500`,
        )
        .all(account(key), ...(where?.params ?? []))
        .map(reminderOf)
    },
    cancelReminder: async (key, id) => {
      reminder(key, id)
      database
        .prepare(
          "UPDATE reminders SET state='cancelled', revision=revision+1, receipt=NULL, lease_until=NULL, updated_at=? " +
            "WHERE account_id=? AND id=? AND state IN ('pending','leased')",
        )
        .run(now(), account(key), Number(id))
      return reminder(key, id)
    },
    snoozeReminder: async (key, id, dueAt, revision) => {
      const held = reminder(key, id)
      openTask(key, held.task)
      if (
        !database
          .prepare(
            "UPDATE reminders SET due_at=?, state='pending', revision=revision+1, receipt=NULL, lease_until=NULL, updated_at=? " +
              "WHERE account_id=? AND id=? AND revision=? AND state<>'cancelled'",
          )
          .run(due(dueAt), now(), account(key), Number(id), revision).changes
      )
        throw new CliError("validation_error", "reminder changed or was cancelled")
      return reminder(key, id)
    },
    claimReminders: async (key, options = {}) => {
      const { limit } = bounded(options.limit),
        lease = options.leaseMs ?? 60_000
      if (!Number.isInteger(lease) || lease < 1000 || lease > 3_600_000)
        throw new CliError("validation_error", "lease takes 1000–3600000 milliseconds")
      const accountId = account(key),
        at = now()
      const rows = database
        .prepare(
          "SELECT r.id FROM reminders r JOIN tasks t ON t.id = r.task_id WHERE r.account_id=? AND r.due_at<=? AND t.status = 'open' " +
            "AND (r.state='pending' OR (r.state='leased' AND r.lease_until<=?)) ORDER BY r.due_at, r.id LIMIT ?",
        )
        .all(accountId, at, at, limit)
      const claimed: Reminder[] = []
      for (const row of rows) {
        const receipt = ulid(at)
        if (
          database
            .prepare(
              "UPDATE reminders SET state='leased', receipt=?, lease_until=?, updated_at=? WHERE account_id=? AND id=? " +
                "AND (state='pending' OR (state='leased' AND lease_until<=?))",
            )
            .run(receipt, at + lease, at, accountId, Number(row.id), at).changes
        )
          claimed.push(reminder(key, String(row.id)))
      }
      return claimed
    },
    acknowledgeReminder: async (key, id, receipt) => {
      const held = reminder(key, id)
      if (held.state === "delivered" && held.receipt === receipt) return held
      openTask(key, held.task)
      if (
        !database
          .prepare(
            "UPDATE reminders SET state='delivered', lease_until=NULL, updated_at=? WHERE account_id=? AND id=? AND state='leased' " +
              "AND receipt=? AND lease_until>?",
          )
          .run(now(), account(key), Number(id), receipt, now()).changes
      )
        throw new CliError("validation_error", "receipt is stale or the delivery lease expired")
      return reminder(key, id)
    },
  }
}

/** Existing project keys stay stable; only new projects receive the short-key convention. */
const projectKey = (name: string): string => {
  const letters = name
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9]/g, "")
    .toUpperCase()
  const key = /^[A-Z]/.test(letters) ? letters.slice(0, 4) : letters ? `P${letters.slice(0, 3)}` : "PRJ"
  return key.padEnd(3, "X")
}
