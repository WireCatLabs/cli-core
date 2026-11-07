import { CliError } from "@wirecat/cli-base"
import type {
  CrmDepartment,
  CrmField,
  CrmItem,
  CrmKind,
  CrmOrganization,
  CrmPerson,
  CrmPipeline,
  CrmUser,
} from "../../domain/crm.js"
import { DEAL_ROLES, type DealKind, STAGE_OUTCOMES } from "../../domain/deals.js"
import { currencyOf, minorUnits } from "../../domain/money.js"
import { recordFingerprint } from "../../domain/records.js"
import type { RelationKind } from "../../domain/relations.js"
import { fold } from "../normalize.js"
import type { AccountPeople } from "../people.js"
import type { AccountKey } from "../types.js"
import { accountPk, findAccountPk } from "./accounts.js"
import { crmCompanyTypes } from "./crm-settings.js"
import { authorActor } from "./memories.js"
import type { StoreContext } from "./open.js"
import { type ReportedRelation, type ReportedScope, syncReportedIn } from "./reported-relations.js"
import { clearState, syncStateOf, writeState } from "./sync.js"
import { write } from "./transaction.js"

/** What the store could not keep, and why: an item whose stage is not stored or whose field it refuses, or a pipeline. */
export interface CrmSkipped {
  externalId: string
  reason: "crm.stage-unknown" | "crm.item-invalid"
  message: string
}

/**
 * A relationship the CRM reported that the store did not write: a contact, company or user not synced yet (tried
 * again on the next sync), ends the registry refuses, an own company it does not know yet, or an email two people
 * share.
 */
export interface CrmRelationIssue {
  /** The CRM row it came from; absent for the account as a whole. */
  externalId?: string
  reason:
    | "crm.reference-unknown"
    | "crm.own-unknown"
    | "crm.email-ambiguous"
    | "relationship.reference-unknown"
    | "relationship.invalid"
  message: string
}

export interface CrmSaved {
  saved: number
  skipped: CrmSkipped[]
  /** Relationships left out; the rows themselves were kept. */
  issues?: CrmRelationIssue[]
  /** Relationships left out because the owner removed or rejected that very one. */
  skippedOwnerRejected?: number
}

/** A CRM row as an end of a relationship, by the CRM's own id. */
interface CrmRef {
  type: DealKind | "contact" | "user" | "company"
  id: string
}

/** A relationship a CRM row reported whose other end is not stored yet; kept in the account's sync state. */
interface PendingRelation {
  /** The row that reported it, `<type>:<id>`: saving that row again replaces its pending ones. */
  owner: string
  from: CrmRef
  to: CrmRef
  kind: RelationKind
  role: string | null
  metadata?: Record<string, unknown>
}

interface Tally {
  issues: CrmRelationIssue[]
  skippedOwnerRejected: number
}

const PENDING = "crm:pending-relations"

/**
 * A CRM account's copies in the store, written as the CRM has them: nothing waits for review (NEED-2271 A), and
 * nothing is ever matched by name (WC-DATA-6). Rows the CRM no longer has are marked deleted, never removed
 * (WC-DATA-7). Every write is one transaction per call.
 */
export interface CrmCopies {
  /** One kind's pipelines and their stages, by the CRM's ids. A stage the CRM dropped stays: deals may stand in it. */
  savePipelines(key: AccountKey, kind: DealKind, pipelines: CrmPipeline[]): Promise<CrmSaved>
  /** Deals or leads; one whose stage is not stored, or whose fields the store refuses, is skipped and named. */
  saveItems(key: AccountKey, kind: DealKind, items: CrmItem[]): Promise<CrmSaved>
  /** Contacts, as identities of the account's provider; a contact joins a person only by its exact email. */
  savePeople(key: AccountKey, people: CrmPerson[]): Promise<CrmSaved>
  /** Companies, each an organization of its own made on first sight, kept apart from any of the same name. */
  saveOrganizations(key: AccountKey, organizations: CrmOrganization[]): Promise<CrmSaved>
  /**
   * The account's whole list of users: identities `<account>/user/<id>`, joined by exact email; each active one
   * `member-of` every own company as an `employee`; with `departments`, `reports-to` the head of its department, a head
   * the head of the parent one (`metadata.derived = "department-head"`). An inactive user's relationships are
   * withdrawn; one missing from the list keeps them, since a sign-in that lost its rights lists no user at all.
   * Without `departments` no reporting line is touched.
   */
  saveUsers(key: AccountKey, users: CrmUser[], departments?: CrmDepartment[]): Promise<CrmSaved>
  /** Writes the relationships earlier syncs held back for an end not stored then; answers how many it wrote. */
  retryPending(key: AccountKey): Promise<number>
  /** One kind's whole list of the CRM's own fields: one it lacks is marked deleted, one listed again comes back. */
  saveFields(key: AccountKey, kind: CrmKind, fields: CrmField[]): Promise<CrmSaved>
  /** The kind's fields as last synced, in the CRM's order; none before the first sync. */
  fields(key: AccountKey, kind: CrmKind): Promise<CrmField[]>
  /** Marks deleted what the CRM said it deleted. Contacts stay: an identity has no deleted mark. Answers how many. */
  remove(key: AccountKey, kind: CrmKind, externalIds: string[]): Promise<number>
  /**
   * After a complete list of the kind's ids: marks deleted every stored one the list lacks that the CRM has not
   * changed since `before` (epoch ms), so a row made while the list was read is never taken for a deleted one.
   * `dryRun` only counts them.
   */
  removeUnlisted(
    key: AccountKey,
    kind: CrmKind,
    listed: string[],
    before: number,
    options?: { dryRun?: boolean },
  ): Promise<number>
  /** How many of the kind the account holds, not deleted; every contact it ever saved. */
  count(key: AccountKey, kind: CrmKind): Promise<number>
  /** The stored copy's `deal:<id>` or `lead:<id>`, deleted or not; `null` when the store holds none. */
  refOf(key: AccountKey, kind: DealKind, externalId: string): Promise<string | null>
}

type Row = Record<string, unknown>

const TABLES = { deal: "deals", lead: "leads" } as const
/** Who writes a CRM's copies: the sync, not an agent, so `author.kind` is `rule`. */
const SOURCE = "crm"

/**
 * A contact's identity id: identities are unique per provider, and two portals of one CRM both have a contact 5.
 * `contact:` references percent-encode it, so the `/` stays one part.
 */
export const crmIdentityId = (key: AccountKey, externalId: string, type: "contact" | "user" = "contact"): string =>
  `${key.account}/${type}/${externalId}`

const tallied = (): Tally => ({ issues: [], skippedOwnerRejected: 0 })
const relationNotes = ({ issues, skippedOwnerRejected }: Tally) => ({
  ...(issues.length ? { issues } : {}),
  ...(skippedOwnerRejected ? { skippedOwnerRejected } : {}),
})

const day = (value: unknown, what: string): string | null => {
  if (value === undefined || value === null || value === "") return null
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value)))
    throw new CliError("validation_error", `${what} is YYYY-MM-DD, not ${JSON.stringify(value)}`)
  return value
}

const epoch = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback

const textOf = (value: unknown, most: number): string | null => {
  if (typeof value !== "string") return null
  const kept = value.trim().slice(0, most)
  return kept || null
}

export const crmCopiesOver = (context: StoreContext, people: AccountPeople): CrmCopies => {
  const { database, now } = context
  const author = (key: AccountKey) => authorActor(context, { bot: key.provider, kind: "rule" }).actor
  const account = (key: AccountKey) => accountPk(context, key)

  const pipelineOf = (accountId: number, kind: DealKind, externalId: string) =>
    database
      .prepare("SELECT * FROM pipelines WHERE account_id = ? AND kind = ? AND external_id = ?")
      .get(accountId, kind, externalId)
  /**
   * One kind's whole list: a pipeline it lacks is marked deleted, one listed again comes back. An empty list marks
   * nothing: a sign-in that lost its CRM rights lists no pipeline at all.
   */
  const savePipelines = (key: AccountKey, kind: DealKind, pipelines: CrmPipeline[]): CrmSaved =>
    write(database, () => {
      const accountId = account(key)
      const at = now()
      for (const pipeline of pipelines) {
        const name = textOf(pipeline.name, 80) ?? pipeline.externalId
        const held = pipelineOf(accountId, kind, pipeline.externalId)
        const id = held
          ? Number(held.id)
          : Number(
              database
                .prepare(
                  "INSERT INTO pipelines (account_id, external_id, kind, name, name_folded, created_at, updated_at) " +
                    "VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id",
                )
                .get(accountId, pipeline.externalId, kind, name, fold(name), at, at)?.id,
            )
        if (held && (held.name !== name || held.deleted_at != null))
          database
            .prepare("UPDATE pipelines SET name = ?, name_folded = ?, updated_at = ?, deleted_at = NULL WHERE id = ?")
            .run(name, fold(name), at, id)
        saveStages(id, pipeline, at)
      }
      if (pipelines.length === 0) return { saved: 0, skipped: [] }
      const listed = new Set(pipelines.map(({ externalId }) => externalId))
      const mark = database.prepare("UPDATE pipelines SET deleted_at = ?, updated_at = ? WHERE id = ?")
      for (const row of database
        .prepare("SELECT id, external_id FROM pipelines WHERE account_id = ? AND kind = ? AND deleted_at IS NULL")
        .all(accountId, kind))
        if (!listed.has(String(row.external_id))) mark.run(at, at, Number(row.id))
      return { saved: pipelines.length, skipped: [] }
    })

  /**
   * Stage names are unique in a pipeline, but a CRM may swap two, or give two stages one name: listed stages first
   * take a name no stage has, then their own, and a name used twice keeps the stage's id beside it.
   */
  const saveStages = (pipelineId: number, pipeline: CrmPipeline, at: number) => {
    const ordered = [...pipeline.stages].sort((a, b) => a.position - b.position)
    const counts = new Map<string, number>()
    for (const stage of ordered) counts.set(fold(stage.name), (counts.get(fold(stage.name)) ?? 0) + 1)
    const wanted = ordered.map((stage, index) => {
      const name = textOf(stage.name, 80) ?? stage.externalId
      const folded = (counts.get(fold(stage.name)) ?? 0) > 1 ? `${fold(name)} (${stage.externalId})` : fold(name)
      if (!(STAGE_OUTCOMES as readonly string[]).includes(stage.outcome))
        throw new CliError("invalid_response", `stage ${stage.externalId} has no known outcome: ${stage.outcome}`)
      return { ...stage, name, folded, position: index + 1 }
    })
    const held = database.prepare("SELECT * FROM pipeline_stages WHERE pipeline_id = ?").all(pipelineId)
    const listed = new Set(wanted.map(({ externalId }) => externalId))
    const taken = new Set(wanted.map(({ folded }) => folded))
    const rename = database.prepare("UPDATE pipeline_stages SET name_folded = ? WHERE id = ?")
    const gone = database.prepare("UPDATE pipeline_stages SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL")
    for (const row of held) {
      const kept = row.external_id != null && listed.has(String(row.external_id))
      if (kept) rename.run(`\u0000${row.id}`, Number(row.id))
      else if (taken.has(String(row.name_folded)))
        rename.run(`${row.name_folded} (${row.external_id ?? row.id})`, Number(row.id))
      if (!kept) gone.run(at, Number(row.id))
    }
    const byId = new Map(held.map((row) => [String(row.external_id), row]))
    for (const stage of wanted) {
      const row = byId.get(stage.externalId)
      if (row)
        database
          .prepare(
            "UPDATE pipeline_stages SET name = ?, name_folded = ?, position = ?, outcome = ?, updated_at = ?, " +
              "deleted_at = NULL WHERE id = ?",
          )
          .run(stage.name, stage.folded, stage.position, stage.outcome, at, Number(row.id))
      else
        database
          .prepare(
            "INSERT INTO pipeline_stages (pipeline_id, name, name_folded, position, outcome, external_id, created_at, " +
              "updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          )
          .run(pipelineId, stage.name, stage.folded, stage.position, stage.outcome, stage.externalId, at, at)
    }
  }

  // Unlike pipelines, an empty list does mark every field deleted: a CRM with no custom fields is an ordinary answer.
  const saveFields = (key: AccountKey, kind: CrmKind, fields: CrmField[]): CrmSaved =>
    write(database, () => {
      const accountId = account(key)
      const at = now()
      const skipped: CrmSkipped[] = []
      const listed = new Set<string>()
      const upsert = database.prepare(
        "INSERT INTO crm_fields (account_id, kind, code, label, type, multiple, filterable, options, position, " +
          "created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (account_id, kind, code) DO " +
          "UPDATE SET label = excluded.label, type = excluded.type, multiple = excluded.multiple, " +
          "filterable = excluded.filterable, options = excluded.options, position = excluded.position, " +
          "updated_at = excluded.updated_at, deleted_at = NULL",
      )
      for (const field of fields) {
        const code = typeof field.code === "string" ? field.code.trim() : ""
        if (!code || listed.has(code)) {
          skipped.push({
            externalId: code,
            reason: "crm.item-invalid",
            message: code ? `${kind} field ${code} is listed twice` : `a ${kind} field has no code`,
          })
          continue
        }
        listed.add(code)
        const options = field.options?.map((option) => ({ id: String(option.id), label: String(option.label) }))
        upsert.run(
          accountId,
          kind,
          code,
          textOf(field.label, 200),
          textOf(field.type, 80) ?? "string",
          field.multiple ? 1 : 0,
          field.filterable ? 1 : 0,
          options ? JSON.stringify(options) : null,
          listed.size,
          at,
          at,
        )
      }
      const mark = database.prepare("UPDATE crm_fields SET deleted_at = ?, updated_at = ? WHERE id = ?")
      for (const row of database
        .prepare("SELECT id, code FROM crm_fields WHERE account_id = ? AND kind = ? AND deleted_at IS NULL")
        .all(accountId, kind))
        if (!listed.has(String(row.code))) mark.run(at, at, Number(row.id))
      return { saved: listed.size, skipped }
    })

  const fieldsOf = (key: AccountKey, kind: CrmKind): CrmField[] => {
    const accountId = findAccountPk(context, key)
    if (accountId === undefined) return []
    return database
      .prepare(
        "SELECT * FROM crm_fields WHERE account_id = ? AND kind = ? AND deleted_at IS NULL ORDER BY position, id",
      )
      .all(accountId, kind)
      .map((row) => ({
        code: String(row.code),
        label: row.label == null ? null : String(row.label),
        type: String(row.type),
        multiple: Number(row.multiple) === 1,
        filterable: Number(row.filterable) === 1,
        ...(row.options == null ? {} : { options: JSON.parse(String(row.options)) as CrmField["options"] }),
      }))
  }

  const personIdOf = (key: AccountKey, externalId: string, type: "contact" | "user" = "contact"): number | null => {
    const row = database
      .prepare(
        "SELECT l.person_id FROM identities i JOIN identity_links l ON l.identity_id = i.id " +
          "WHERE i.provider = ? AND i.external_id = ?",
      )
      .get(key.provider, crmIdentityId(key, externalId, type))
    return row ? Number(row.person_id) : null
  }

  /**
   * How many people the contact's email belongs to; none once the owner separated this contact, who already decided.
   */
  const peopleSharing = (key: AccountKey, externalId: string, email: string): number => {
    const decided = database
      .prepare(
        "SELECT 1 FROM identity_link_events e JOIN identities i ON i.id = e.identity_id WHERE i.provider = ? " +
          "AND i.external_id = ? AND e.author = 'owner' LIMIT 1",
      )
      .get(key.provider, crmIdentityId(key, externalId))
    if (decided) return 0
    return Number(
      database
        .prepare(
          "SELECT count(DISTINCT l.person_id) AS n FROM identities i JOIN identity_links l ON l.identity_id = i.id " +
            "WHERE i.email = ?",
        )
        .get(email)?.n,
    )
  }

  /** A person a CRM contact or user made has no name when it joined the mail contact of its address first. */
  const nameUnnamed = (key: AccountKey, externalId: string, type: "contact" | "user", name: string | null) => {
    const person = personIdOf(key, externalId, type)
    if (person !== null && name)
      database
        .prepare("UPDATE persons SET name = ?, updated_at = ? WHERE id = ? AND name IS NULL")
        .run(name, now(), person)
    return person
  }

  const organizationIdOf = (accountId: number, externalId: string): number | null => {
    const row = database
      .prepare(
        "SELECT entity_id FROM records WHERE account_id = ? AND type = 'organization' AND external_id = ? " +
          "AND entity_type = 'organization'",
      )
      .get(accountId, externalId)
    return row?.entity_id == null ? null : Number(row.entity_id)
  }
  const refOf = (key: AccountKey, accountId: number, ref: CrmRef): string | null => {
    if (ref.type === "contact" || ref.type === "user") {
      const person = personIdOf(key, ref.id, ref.type)
      return person === null ? null : `person:${person}`
    }
    if (ref.type === "company") {
      const organization = organizationIdOf(accountId, ref.id)
      return organization === null ? null : `organization:${organization}`
    }
    const row = database
      .prepare(`SELECT id FROM ${TABLES[ref.type]} WHERE account_id = ? AND external_id = ?`)
      .get(accountId, ref.id)
    return row ? `${ref.type}:${row.id}` : null
  }

  const pendingOf = (accountId: number): PendingRelation[] => {
    try {
      const value = JSON.parse(syncStateOf(context, accountId, PENDING)?.value ?? "[]") as unknown
      return Array.isArray(value) ? (value as PendingRelation[]) : []
    } catch {
      return []
    }
  }
  const savePending = (accountId: number, list: PendingRelation[]) =>
    list.length
      ? writeState(context, accountId, PENDING, JSON.stringify(list))
      : clearState(context, accountId, PENDING)

  /**
   * Reports one CRM row's relationships as a diff (`relations.syncReported`) inside `scope`. One whose other end is not
   * stored yet waits in the account's sync state and is tried again after the next sync, so a deal read before its
   * contact still gets the contact.
   */
  const reportFrom = (
    key: AccountKey,
    accountId: number,
    owner: CrmRef,
    wanted: Omit<PendingRelation, "owner">[],
    scope: ReportedScope,
    tally: Tally,
  ) => {
    const name = `${owner.type}:${owner.id}`
    const relationships: ReportedRelation[] = []
    const waiting: PendingRelation[] = []
    for (const one of wanted) {
      const from = refOf(key, accountId, one.from)
      const to = refOf(key, accountId, one.to)
      if (from === null || to === null) {
        const missing = from === null ? one.from : one.to
        waiting.push({ owner: name, ...one })
        tally.issues.push({
          externalId: owner.id,
          reason: "crm.reference-unknown",
          message:
            `${owner.type} ${owner.id} names ${missing.type} ${missing.id}, which is not stored yet; ` +
            "the next sync tries again",
        })
        continue
      }
      relationships.push({
        from,
        to,
        kind: one.kind,
        role: one.role,
        ...(one.metadata ? { metadata: one.metadata } : {}),
      })
    }
    const held = pendingOf(accountId)
    if (waiting.length || held.some((one) => one.owner === name))
      savePending(accountId, [...held.filter((one) => one.owner !== name), ...waiting])
    const done = syncReportedIn(context, key, relationships, scope, { source: SOURCE })
    tally.skippedOwnerRejected += done.skippedOwnerRejected
    for (const one of done.issues) tally.issues.push({ externalId: owner.id, reason: one.reason, message: one.message })
  }

  /** The pending relationships whose ends are stored now, written without withdrawing anything. */
  const retryPending = (key: AccountKey): number =>
    write(database, () => {
      const accountId = findAccountPk(context, key)
      if (accountId === undefined) return 0
      const held = pendingOf(accountId)
      const kept: PendingRelation[] = []
      let written = 0
      for (const one of held) {
        const from = refOf(key, accountId, one.from)
        const to = refOf(key, accountId, one.to)
        if (from === null || to === null) {
          kept.push(one)
          continue
        }
        const relation = {
          from,
          to,
          kind: one.kind,
          role: one.role,
          ...(one.metadata ? { metadata: one.metadata } : {}),
        }
        syncReportedIn(context, key, [relation], { from: [], kinds: [] }, { source: SOURCE })
        written += 1
      }
      if (kept.length !== held.length) savePending(accountId, kept)
      return written
    })

  const saveItem = (key: AccountKey, accountId: number, kind: DealKind, item: CrmItem, at: number, tally: Tally) => {
    const pipeline = pipelineOf(accountId, kind, item.pipeline)
    const stage =
      pipeline &&
      database
        .prepare("SELECT id, outcome FROM pipeline_stages WHERE pipeline_id = ? AND external_id = ?")
        .get(Number(pipeline.id), item.stage)
    if (!pipeline || !stage)
      return {
        externalId: item.externalId,
        reason: "crm.stage-unknown" as const,
        message: `${kind} ${item.externalId} stands in stage ${item.stage} of pipeline ${item.pipeline}, which is not stored`,
      }
    const title = textOf(item.title, 200) ?? `${kind} ${item.externalId}`
    const given = item.amount != null && item.currency != null
    const currency = given ? currencyOf(item.currency) : null
    const amount =
      currency === null ? null : minorUnits(String(item.amount), currency, `${kind} ${item.externalId}'s amount`)
    if (amount !== null && amount < 0) throw new CliError("validation_error", "an amount is 0 or more")
    if (item.status != null && !(STAGE_OUTCOMES as readonly string[]).includes(item.status))
      throw new CliError("validation_error", `${kind} ${item.externalId}'s status is open, won or lost`)
    const status = item.status ?? String(stage.outcome)
    const closed =
      status === "open"
        ? null
        : (day(item.closedDate, "a closed day") ?? new Date(epoch(item.updatedAt, at)).toISOString().slice(0, 10))
    const deal =
      kind === "lead" && item.deal
        ? database.prepare("SELECT id FROM deals WHERE account_id = ? AND external_id = ?").get(accountId, item.deal)
        : undefined
    const metadata = {
      ...(item.metadata ?? {}),
      ...(item.url ? { url: item.url } : {}),
      ...(item.assignee ? { assignee: crmIdentityId(key, item.assignee, "user") } : {}),
      ...(item.closedReason && status !== "open" ? { closed_reason: textOf(item.closedReason, 2000) } : {}),
    }
    const values = {
      title,
      organization: item.organization ? organizationIdOf(accountId, item.organization) : null,
      stage: Number(stage.id),
      status,
      currency,
      amount,
      close: day(item.closeDate, "an expected close day"),
      closed,
      metadata: Object.keys(metadata).length ? JSON.stringify(metadata) : null,
      created: epoch(item.createdAt, at),
      updated: epoch(item.updatedAt, at),
    }
    const table = TABLES[kind]
    const held = database
      .prepare(`SELECT id FROM ${table} WHERE account_id = ? AND external_id = ?`)
      .get(accountId, item.externalId)
    let id: number
    if (held) {
      id = Number(held.id)
      database
        .prepare(
          `UPDATE ${table} SET title = ?, organization_id = ?, stage_id = ?, status = ?, currency = ?, amount = ?, ` +
            "close_date = ?, closed_date = ?, metadata = ?, updated_at = ?, deleted_at = NULL" +
            (kind === "lead" ? ", deal_id = coalesce(?, deal_id)" : "") +
            " WHERE id = ?",
        )
        .run(
          values.title,
          values.organization,
          values.stage,
          values.status,
          values.currency,
          values.amount,
          values.close,
          values.closed,
          values.metadata,
          values.updated,
          ...(kind === "lead" ? [deal ? Number(deal.id) : null] : []),
          id,
        )
    } else {
      const actor = author(key)
      id = Number(
        database
          .prepare(
            `INSERT INTO ${table} (title, organization_id, stage_id, status, currency, amount, close_date, closed_date, ` +
              `account_id, external_id, author_type, author_id, source, metadata, created_at, updated_at` +
              (kind === "lead" ? ", deal_id" : "") +
              `) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?${kind === "lead" ? ", ?" : ""}) RETURNING id`,
          )
          .get(
            values.title,
            values.organization,
            values.stage,
            values.status,
            values.currency,
            values.amount,
            values.close,
            values.closed,
            accountId,
            item.externalId,
            actor.type,
            actor.id,
            SOURCE,
            values.metadata,
            values.created,
            values.updated,
            ...(kind === "lead" ? [deal ? Number(deal.id) : null] : []),
          )?.id,
      )
    }
    if (item.people === undefined && item.assignee === undefined) return null
    const self: CrmRef = { type: kind, id: item.externalId }
    const wanted: Omit<PendingRelation, "owner">[] = (item.people ?? []).map((person) => ({
      from: self,
      to: { type: "contact", id: person.externalId },
      kind: "related-to",
      role: (DEAL_ROLES as readonly string[]).includes(person.role) ? person.role : "contact",
      ...(person.primary ? { metadata: { primary: true } } : {}),
    }))
    if (item.assignee)
      wanted.push({ from: self, to: { type: "user", id: item.assignee }, kind: "related-to", role: "owner" })
    // Only what the CRM said: its contacts cover the client's roles, its assignee the owner.
    const roles = [
      ...(item.people === undefined ? [] : DEAL_ROLES.filter((role) => role !== "owner")),
      ...(item.assignee === undefined ? [] : ["owner"]),
    ]
    reportFrom(key, accountId, self, wanted, { from: [`${kind}:${id}`], kinds: ["related-to"], roles }, tally)
    return null
  }

  const saveItems = (key: AccountKey, kind: DealKind, items: CrmItem[]): CrmSaved =>
    write(database, () => {
      const accountId = account(key)
      const at = now()
      const skipped: CrmSkipped[] = []
      const tally = tallied()
      for (const item of items)
        try {
          const missing = saveItem(key, accountId, kind, item, at, tally)
          if (missing) skipped.push(missing)
        } catch (error) {
          if (!(error instanceof CliError) || error.code !== "validation_error") throw error
          skipped.push({ externalId: item.externalId, reason: "crm.item-invalid", message: error.message })
        }
      return { saved: items.length - skipped.length, skipped, ...relationNotes(tally) }
    })

  const saveOrganizations = (key: AccountKey, organizations: CrmOrganization[]): CrmSaved =>
    write(database, () => {
      const accountId = account(key)
      const at = now()
      for (const organization of organizations) {
        const name = textOf(organization.name, 200) ?? `${key.provider} company ${organization.externalId}`
        const fields = {
          name,
          ...(organization.url ? { url: organization.url } : {}),
          ...(organization.own ? { own: true } : {}),
          ...(organization.type ? { type: organization.type } : {}),
          ...(organization.metadata ?? {}),
        }
        const fingerprint = recordFingerprint(fields, [])
        const held = database
          .prepare("SELECT * FROM records WHERE account_id = ? AND type = 'organization' AND external_id = ?")
          .get(accountId, organization.externalId)
        const previous = held ? (JSON.parse(String(held.fields)) as { name?: unknown; own?: unknown }) : {}
        const before = previous.name
        let entity = held?.entity_type === "organization" && held.entity_id != null ? Number(held.entity_id) : null
        if (entity === null)
          entity = Number(
            database
              .prepare(
                "INSERT INTO organizations (kind, name, scope, created_at, updated_at) VALUES ('company', ?, 'work', ?, ?) " +
                  "RETURNING id",
              )
              .get(name, at, at)?.id,
          )
        // The owner may have renamed it here; only a name nobody changed follows the CRM's.
        else if (before !== name)
          database
            .prepare("UPDATE organizations SET name = ?, updated_at = ? WHERE id = ? AND name = ?")
            .run(name, at, entity, typeof before === "string" ? before : name)
        if (organization.own)
          database
            .prepare(
              "UPDATE organizations SET metadata = json_set(coalesce(metadata, '{}'), '$.own', json('true')), " +
                "updated_at = ? WHERE id = ? AND json_extract(coalesce(metadata, '{}'), '$.own') IS NOT 1",
            )
            .run(at, entity)
        // Only a flag the CRM set goes when the CRM drops it: one the owner set stays.
        else if (previous.own === true)
          database
            .prepare("UPDATE organizations SET metadata = json_remove(metadata, '$.own'), updated_at = ? WHERE id = ?")
            .run(at, entity)
        if (held)
          database
            .prepare(
              "UPDATE records SET fields = ?, fingerprint = ?, entity_type = 'organization', entity_id = ?, " +
                "projected_fingerprint = ?, batch_id = ?, updated_at = ?, deleted_at = NULL WHERE id = ?",
            )
            .run(JSON.stringify(fields), fingerprint, entity, fingerprint, SOURCE, at, Number(held.id))
        else
          database
            .prepare(
              "INSERT INTO records (account_id, type, external_id, fields, fingerprint, entity_type, entity_id, " +
                "projected_fingerprint, batch_id, created_at, updated_at) " +
                "VALUES (?, 'organization', ?, ?, ?, 'organization', ?, ?, ?, ?, ?)",
            )
            .run(
              accountId,
              organization.externalId,
              JSON.stringify(fields),
              fingerprint,
              entity,
              fingerprint,
              SOURCE,
              at,
              at,
            )
      }
      const tally = tallied()
      const types = crmCompanyTypes(database, key)
      const own = ownCompanies(accountId)
      if (Object.keys(types).length)
        for (const organization of organizations) {
          if (organization.type === undefined || organization.own || own.includes(organization.externalId)) continue
          const company: CrmRef = { type: "company", id: organization.externalId }
          const meaning = organization.type === null ? undefined : types[organization.type]
          const wanted = own.flatMap((id): Omit<PendingRelation, "owner">[] => {
            const mine: CrmRef = { type: "company", id }
            if (meaning === "customer-of") return [{ from: company, to: mine, kind: "customer-of", role: null }]
            if (meaning === "supplier") return [{ from: mine, to: company, kind: "customer-of", role: null }]
            if (meaning === "partner-of") return [{ from: company, to: mine, kind: "partner-of", role: null }]
            return []
          })
          const ref = refOf(key, accountId, company) as string
          const scope = { from: [ref], to: [ref], kinds: ["customer-of" as const, "partner-of" as const] }
          reportFrom(key, accountId, company, wanted, scope, tally)
        }
      return { saved: organizations.length, skipped: [], ...relationNotes(tally) }
    })

  /** The account's own companies, by the CRM's ids. */
  const ownCompanies = (accountId: number): string[] =>
    database
      .prepare(
        "SELECT r.external_id FROM records r JOIN organizations o ON o.id = r.entity_id WHERE r.account_id = ? " +
          "AND r.type = 'organization' AND r.entity_type = 'organization' AND r.deleted_at IS NULL " +
          "AND json_extract(o.metadata, '$.own') = 1 ORDER BY o.id",
      )
      .all(accountId)
      .map((row) => String(row.external_id))

  const saveUsers = (key: AccountKey, users: CrmUser[], departments: CrmDepartment[] | undefined): CrmSaved => {
    const accountId = account(key)
    const tally = tallied()
    for (const user of users) nameUnnamed(key, user.externalId, "user", textOf(user.name, 200))
    const active = new Map(users.filter((user) => user.active !== false).map((user) => [user.externalId, user]))
    const own = ownCompanies(accountId)
    if (own.length === 0)
      tally.issues.push({
        reason: "crm.own-unknown",
        message: "no own company of this account is stored, so no user is its employee yet",
      })
    const byId = new Map((departments ?? []).map((department) => [department.externalId, department]))
    for (const user of users) {
      const self: CrmRef = { type: "user", id: user.externalId }
      const ref = refOf(key, accountId, self)
      if (ref === null) continue
      const working = active.has(user.externalId)
      const position = textOf(user.position, 200)
      if (own.length) {
        const wanted = working
          ? own.map((id) => ({
              from: self,
              to: { type: "company" as const, id },
              kind: "member-of" as const,
              role: "employee",
              ...(position ? { metadata: { position } } : {}),
            }))
          : []
        reportFrom(key, accountId, self, wanted, { from: [ref], kinds: ["member-of"], roles: ["employee"] }, tally)
      }
      // Without departments, or without a user's own list of them, who it reports to is unknown, not none.
      if (departments === undefined || user.departments === undefined) continue
      const heads = new Set<string>()
      for (const id of working ? user.departments : []) {
        const department = byId.get(id)
        const head = department?.head === user.externalId ? byId.get(department.parent ?? "")?.head : department?.head
        if (head && head !== user.externalId && active.has(head)) heads.add(head)
      }
      const lines = [...heads].map((head) => ({
        from: self,
        to: { type: "user" as const, id: head },
        kind: "reports-to" as const,
        role: null,
        metadata: { derived: "department-head" },
      }))
      const owner = { type: "user" as const, id: `${user.externalId}/reports-to` }
      reportFrom(key, accountId, owner, lines, { from: [ref], kinds: ["reports-to"] }, tally)
    }
    return { saved: users.length, skipped: [], ...relationNotes(tally) }
  }

  const stored = (key: AccountKey, kind: CrmKind): Row[] => {
    const accountId = findAccountPk(context, key)
    if (accountId === undefined || kind === "person") return []
    return kind === "organization"
      ? database
          .prepare(
            "SELECT id, external_id, updated_at FROM records WHERE account_id = ? AND type = 'organization' " +
              "AND deleted_at IS NULL",
          )
          .all(accountId)
      : database
          .prepare(
            `SELECT id, external_id, updated_at FROM ${TABLES[kind]} WHERE account_id = ? AND deleted_at IS NULL`,
          )
          .all(accountId)
  }

  const markDeleted = (kind: CrmKind, ids: number[]) => {
    const table = kind === "organization" ? "records" : TABLES[kind as DealKind]
    const mark = database.prepare(`UPDATE ${table} SET deleted_at = ? WHERE id = ?`)
    const at = now()
    for (const id of ids) mark.run(at, id)
    return ids.length
  }

  return {
    savePipelines: async (key, kind, pipelines) => savePipelines(key, kind, pipelines),
    saveItems: async (key, kind, items) => saveItems(key, kind, items),
    savePeople: async (key, contacts) => {
      await people.savePeople(
        key,
        contacts.map((contact) => ({
          id: crmIdentityId(key, contact.externalId),
          name: textOf(contact.name, 200),
          email: textOf(contact.email, 320)?.toLowerCase() ?? null,
          phone: textOf(contact.phone, 64),
        })),
      )
      return write(database, () => {
        const accountId = account(key)
        const tally = tallied()
        for (const contact of contacts) {
          const person = nameUnnamed(key, contact.externalId, "contact", textOf(contact.name, 200))
          const email = textOf(contact.email, 320)?.toLowerCase()
          const sharing = email ? peopleSharing(key, contact.externalId, email) : 0
          if (sharing > 1)
            tally.issues.push({
              externalId: contact.externalId,
              reason: "crm.email-ambiguous",
              message: `contact ${contact.externalId}'s email belongs to ${sharing} people: say which one it is`,
            })
          if (person === null || contact.organizations === undefined) continue
          const self: CrmRef = { type: "contact", id: contact.externalId }
          const position = textOf(contact.position, 200)
          const wanted = contact.organizations.map((company) => {
            const sourceRole = textOf(company.sourceRole, 200)
            const metadata = {
              ...(position ? { position } : {}),
              ...(sourceRole ? { source_role: sourceRole } : {}),
              ...(company.primary ? { primary: true } : {}),
            }
            return {
              from: self,
              to: { type: "company" as const, id: company.externalId },
              kind: "member-of" as const,
              role: "contact",
              ...(Object.keys(metadata).length ? { metadata } : {}),
            }
          })
          const scope = { from: [`person:${person}`], kinds: ["member-of" as const], roles: ["contact"] }
          reportFrom(key, accountId, self, wanted, scope, tally)
        }
        return { saved: contacts.length, skipped: [], ...relationNotes(tally) }
      })
    },
    retryPending: async (key) => retryPending(key),
    saveUsers: async (key, users, departments) => {
      await people.savePeople(
        key,
        users.map((user) => ({
          id: crmIdentityId(key, user.externalId, "user"),
          name: textOf(user.name, 200),
          email: textOf(user.email, 320)?.toLowerCase() ?? null,
        })),
      )
      return write(database, () => saveUsers(key, users, departments))
    },
    saveOrganizations: async (key, organizations) => saveOrganizations(key, organizations),
    saveFields: async (key, kind, fields) => saveFields(key, kind, fields),
    fields: async (key, kind) => fieldsOf(key, kind),
    remove: async (key, kind, externalIds) =>
      write(database, () => {
        const gone = new Set(externalIds)
        return markDeleted(
          kind,
          stored(key, kind)
            .filter((row) => gone.has(String(row.external_id)))
            .map((row) => Number(row.id)),
        )
      }),
    removeUnlisted: async (key, kind, listed, before, { dryRun } = {}) =>
      write(database, () => {
        const held = new Set(listed)
        const gone = stored(key, kind)
          .filter((row) => !held.has(String(row.external_id)) && Number(row.updated_at) < before)
          .map((row) => Number(row.id))
        return dryRun ? gone.length : markDeleted(kind, gone)
      }),
    count: async (key, kind) =>
      kind === "person"
        ? Number(
            database
              .prepare("SELECT count(*) AS n FROM identities WHERE provider = ? AND substr(external_id, 1, ?) = ?")
              .get(key.provider, key.account.length + 1, `${key.account}/`)?.n,
          )
        : stored(key, kind).length,
    refOf: async (key, kind, externalId) => {
      const accountId = findAccountPk(context, key)
      const row =
        accountId === undefined
          ? undefined
          : database
              .prepare(`SELECT id FROM ${TABLES[kind]} WHERE account_id = ? AND external_id = ?`)
              .get(accountId, externalId)
      return row ? `${kind}:${row.id}` : null
    },
  }
}
