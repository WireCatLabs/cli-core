import { CliError } from "@wirecat/cli-base"
import {
  type CrmActivity,
  type CrmDepartment,
  type CrmField,
  type CrmItem,
  type CrmKind,
  type CrmOrganization,
  type CrmPerson,
  type CrmPipeline,
  type CrmScopeSetting,
  type CrmStageEntry,
  type CrmUser,
  isItemKind,
  normalCrmUserId,
} from "../../domain/crm.js"
import { DEAL_ROLES, type DealKind } from "../../domain/deals.js"
import { recordFingerprint } from "../../domain/records.js"
import type { RelationKind } from "../../domain/relations.js"
import type { AccountPeople } from "../people.js"
import type { AccountKey } from "../types.js"
import { accountPk, findAccountPk } from "./accounts.js"
import { suggestBaseStages } from "./base-suggest.js"
import { type CrmActivitiesSaved, crmActivitiesOver, type StoredActivity } from "./crm-activities.js"
import { type CrmContactsRemoved, removeCrmContacts } from "./crm-contacts.js"
import { type CrmSkipped, crmAccountPrefix, crmIdentityId, crmRowsOver, SOURCE, TABLES, textOf } from "./crm-rows.js"
import {
  type CrmStageMove,
  type CrmStageTasks,
  crmActivitiesOn,
  crmCompanyTypes,
  crmOwnUser,
  crmScope,
  crmScopeUsers,
  crmSettingKey,
  crmStageMoves,
  crmStageTasks,
  crmStageTasksSince,
  saveCrmSetting,
  saveStageMovesMark,
} from "./crm-settings.js"
import { crmStageEntriesOver } from "./crm-stage-entries.js"
import type { StoreContext } from "./open.js"
import { type ReportedRelation, type ReportedScope, syncReportedIn } from "./reported-relations.js"
import { clearState, syncStateOf, writeState } from "./sync.js"
import { write } from "./transaction.js"

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
  /** Deal owners the CRM names among users it cannot list: nothing waits for them. */
  unlistedUsers?: number
  /** Relationships that waited too long, or were too many, for an end that never came. */
  droppedPending?: number
}

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
  /** When it was held back, epoch ms: an end that never comes is dropped after `PENDING_DAYS`. */
  at: number
}

/** One read and one write of the pending relationships per call, however many rows it saves. */
interface PendingBook {
  replace(owner: string, entries: PendingRelation[]): void
  forget(owner: string): void
  all(): PendingRelation[]
  /** Writes them back, oldest past the age or the count dropped; answers how many it dropped. */
  flush(): number
}

/** What a CRM row reports, by the CRM's ids; `pend: false` drops one whose end is not stored instead of waiting. */
type Wanted = Omit<PendingRelation, "owner" | "at"> & { pend?: false }

interface Tally {
  issues: CrmRelationIssue[]
  skippedOwnerRejected: number
  /** Deal owners who are CRM users the source cannot list, so nothing waits for them. */
  unlistedUsers: number
  droppedPending: number
}

const PENDING = "crm:pending-relations"
const PENDING_DAYS = 30
const PENDING_MOST = 5000

/**
 * A CRM account's copies in the store, written as the CRM has them: nothing waits for review (NEED-2271 A), and
 * nothing is ever matched by name (WC-DATA-6). Rows the CRM no longer has are marked deleted, never removed
 * (WC-DATA-7). Every write is one transaction per call.
 */
export interface CrmCopies {
  /** One kind's pipelines and their stages, by the CRM's ids. A stage the CRM dropped stays: deals may stand in it. */
  savePipelines(key: AccountKey, kind: DealKind, pipelines: CrmPipeline[]): Promise<CrmSaved>
  /** Deals or leads; one whose stage is not stored, or whose fields the store refuses, is skipped and named. */
  /** `users: false`: the source lists no users, so a deal owner not stored yet is counted, never waited for. */
  saveItems(key: AccountKey, kind: DealKind, items: CrmItem[], options?: { users?: boolean }): Promise<CrmSaved>
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
  /**
   * Writes the relationships earlier syncs held back for an end not stored then, and drops those that waited past
   * their time; answers how many of each.
   */
  retryPending(key: AccountKey): Promise<{ written: number; dropped: number }>
  /** Every stored company of the account against its company-types setting; run after a sync read the companies. */
  saveCompanyTypes(key: AccountKey): Promise<CrmSaved>
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
  /** Which deals and leads the account's sync copies: its `scope` and `unassigned` settings. */
  scope(key: AccountKey): Promise<CrmScopeSetting>
  /** The CRM user whose copy this is (`self` setting); none before the first sync of a source that names one. */
  ownUser(key: AccountKey): Promise<string | undefined>
  saveOwnUser(key: AccountKey, userId: string): Promise<void>
  /** The owner's `stage-tasks` rules, by kind and the CRM's stage id. */
  stageTasks(key: AccountKey): Promise<CrmStageTasks>
  /**
   * Each stage a deal or lead of the account entered from another one since `markStageMoves` last ran, oldest first;
   * a new row's first stage is no move. `through` is what to mark once they are handled.
   */
  stageMoves(key: AccountKey): Promise<{ moves: CrmStageMove[]; through: number }>
  markStageMoves(key: AccountKey, through: number): Promise<void>
  /** When stage tasks were last opened, or the rules first set; null without rules. */
  stageTasksSince(key: AccountKey): Promise<number | null>
  /** Entries from the CRM's stage history on kept deals and leads; answers how many were new. */
  saveStageEntries(key: AccountKey, entries: readonly CrmStageEntry[]): Promise<number>
  /** The stored history entries whose stage task is not handled yet, oldest first. */
  stageEntries(key: AccountKey): Promise<CrmStageMove[]>
  handleStageEntries(ids: readonly number[]): Promise<void>
  /** Whether the owner turned on reading activities and tasks (`activities` setting). */
  activitiesOn(key: AccountKey): Promise<boolean>
  /** Activities and tasks, each on the kept deals and leads it names; one on none of them is not stored. */
  saveActivities(key: AccountKey, activities: readonly CrmActivity[]): Promise<CrmActivitiesSaved>
  /** One deal's or lead's activities, open ones first. */
  activitiesOf(key: AccountKey, kind: DealKind, externalId: string, limit: number): Promise<StoredActivity[]>
  /**
   * Marks deleted every stored deal or lead of the kind assigned to a user outside `userIds`; one with no assignee
   * stays. Reads only the store. Answers how many; `dryRun` only counts them.
   */
  removeOutOfScope(
    key: AccountKey,
    kind: DealKind,
    userIds: readonly string[],
    options?: { dryRun?: boolean },
  ): Promise<number>
  /**
   * Removes the contacts no kept deal, lead or company names, and the people they leave empty; see
   * `removeCrmContacts`. A deal or lead assigned to a user outside `users` counts as gone; without `users`, outside
   * those scope mine keeps (`self` and `unassigned`), whatever the scope is now. `dryRun` only counts.
   */
  removeContacts(
    key: AccountKey,
    options: { users?: readonly string[]; before: number; dryRun?: boolean },
  ): Promise<CrmContactsRemoved>
  /** How many of the kind the account holds, not deleted; every contact it ever saved. */
  count(key: AccountKey, kind: CrmKind): Promise<number>
  /** The stored copy's `deal:<id>` or `lead:<id>`, deleted or not; `null` when the store holds none. */
  refOf(key: AccountKey, kind: DealKind, externalId: string): Promise<string | null>
}

type Row = Record<string, unknown>

export type { CrmActivitiesSaved, StoredActivity } from "./crm-activities.js"
export type { CrmContactsRemoved } from "./crm-contacts.js"
export { type CrmSkipped, crmIdentityId, crmRowsOver, type ItemWriter } from "./crm-rows.js"

const tallied = (): Tally => ({ issues: [], skippedOwnerRejected: 0, unlistedUsers: 0, droppedPending: 0 })
const relationNotes = ({ issues, skippedOwnerRejected, unlistedUsers, droppedPending }: Tally) => ({
  ...(issues.length ? { issues } : {}),
  ...(skippedOwnerRejected ? { skippedOwnerRejected } : {}),
  ...(unlistedUsers ? { unlistedUsers } : {}),
  ...(droppedPending ? { droppedPending } : {}),
})

/** At most this many of a contact's phones or addresses: a CRM field holds what people typed into it. */
const MOST_CONTACTS = 20

const listOf = (values: readonly unknown[], most: number): string[] =>
  values.flatMap((value) => textOf(value, most) ?? []).slice(0, MOST_CONTACTS)

export const crmCopiesOver = (context: StoreContext, people: AccountPeople): CrmCopies => {
  const { database, now } = context
  const { savePipeline, saveItemRow } = crmRowsOver(context)
  const account = (key: AccountKey) => accountPk(context, key)
  const activityStore = crmActivitiesOver(context)
  const stageEntryStore = crmStageEntriesOver(context)

  /**
   * One kind's whole list: a pipeline it lacks is marked deleted, one listed again comes back. An empty list marks
   * nothing: a sign-in that lost its CRM rights lists no pipeline at all.
   */
  const savePipelines = (key: AccountKey, kind: DealKind, pipelines: CrmPipeline[]): CrmSaved =>
    write(database, () => {
      const accountId = account(key)
      const at = now()
      const saved = pipelines.map((pipeline) => savePipeline(accountId, kind, pipeline, at))
      suggestBaseStages(database, kind, saved, { onlyEmpty: true })
      if (pipelines.length === 0) return { saved: 0, skipped: [] }
      const listed = new Set(pipelines.map(({ externalId }) => externalId))
      const mark = database.prepare("UPDATE pipelines SET deleted_at = ?, updated_at = ? WHERE id = ?")
      for (const row of database
        .prepare("SELECT id, external_id FROM pipelines WHERE account_id = ? AND kind = ? AND deleted_at IS NULL")
        .all(accountId, kind))
        if (!listed.has(String(row.external_id))) mark.run(at, at, Number(row.id))
      return { saved: pipelines.length, skipped: [] }
    })

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

  /**
   * A person a CRM contact or user made has no name when it joined the mail contact of its address first. The owner's
   * name is never a CRM's: a contact on the owner's person by mistake must not rename them.
   */
  const nameUnnamed = (key: AccountKey, externalId: string, type: "contact" | "user", name: string | null) => {
    const person = personIdOf(key, externalId, type)
    if (person !== null && name)
      database
        .prepare("UPDATE persons SET name = ?, updated_at = ? WHERE id = ? AND name IS NULL AND owner = 0")
        .run(name, now(), person)
    return person
  }

  const refOf = (key: AccountKey, accountId: number, ref: CrmRef): string | null => {
    if (ref.type === "contact" || ref.type === "user") {
      const person = personIdOf(key, ref.id, ref.type)
      return person === null ? null : `person:${person}`
    }
    // A row the CRM deleted is no end: a relationship waiting for it is never written.
    const row =
      ref.type === "company"
        ? database
            .prepare(
              "SELECT entity_id AS id FROM records WHERE account_id = ? AND type = 'organization' AND external_id = ? " +
                "AND entity_type = 'organization' AND deleted_at IS NULL",
            )
            .get(accountId, ref.id)
        : database
            .prepare(
              `SELECT id FROM ${TABLES[ref.type]} WHERE account_id = ? AND external_id = ? AND deleted_at IS NULL`,
            )
            .get(accountId, ref.id)
    if (row?.id == null) return null
    return `${ref.type === "company" ? "organization" : ref.type}:${row.id}`
  }

  const pendingBook = (accountId: number): PendingBook => {
    let byOwner: Map<string, PendingRelation[]> | undefined
    let changed = false
    const load = () => {
      if (byOwner) return byOwner
      byOwner = new Map()
      try {
        const value = JSON.parse(syncStateOf(context, accountId, PENDING)?.value ?? "[]") as unknown
        for (const one of Array.isArray(value) ? (value as PendingRelation[]) : [])
          byOwner.set(one.owner, [...(byOwner.get(one.owner) ?? []), { ...one, at: Number(one.at) || now() }])
      } catch {}
      return byOwner
    }
    return {
      replace: (owner, entries) => {
        const held = load()
        if (!entries.length && !held.has(owner)) return
        if (entries.length) held.set(owner, entries)
        else held.delete(owner)
        changed = true
      },
      forget: (owner) => {
        if (load().delete(owner)) changed = true
      },
      all: () => [...load().values()].flat(),
      flush: () => {
        if (!byOwner) return 0
        const all = [...byOwner.values()].flat()
        const fresh = all
          .filter((one) => one.at > now() - PENDING_DAYS * 86_400_000)
          .sort((a, b) => b.at - a.at)
          .slice(0, PENDING_MOST)
        if (!changed && fresh.length === all.length) return 0
        if (fresh.length) writeState(context, accountId, PENDING, JSON.stringify(fresh))
        else clearState(context, accountId, PENDING)
        changed = false
        return all.length - fresh.length
      },
    }
  }

  /**
   * Reports one CRM row's relationships as a diff (`relations.syncReported`) inside `scope`. One whose other end is not
   * stored yet waits in the account's sync state and is tried again after the next sync, so a deal read before its
   * contact still gets the contact.
   */
  const reportFrom = (
    key: AccountKey,
    accountId: number,
    owner: CrmRef,
    wanted: Wanted[],
    scope: ReportedScope,
    tally: Tally,
    pending: PendingBook,
  ) => {
    const name = `${owner.type}:${owner.id}`
    const relationships: ReportedRelation[] = []
    const waiting: PendingRelation[] = []
    for (const one of wanted) {
      const from = refOf(key, accountId, one.from)
      const to = refOf(key, accountId, one.to)
      if (from === null || to === null) {
        const missing = from === null ? one.from : one.to
        if (one.pend === false) {
          tally.unlistedUsers += 1
          continue
        }
        const { pend: _, ...kept } = one
        waiting.push({ owner: name, ...kept, at: now() })
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
    pending.replace(name, waiting)
    const done = syncReportedIn(context, key, relationships, scope, { source: SOURCE })
    tally.skippedOwnerRejected += done.skippedOwnerRejected
    for (const one of done.issues) tally.issues.push({ externalId: owner.id, reason: one.reason, message: one.message })
  }

  /** The pending relationships whose ends are stored now, written without withdrawing anything. */
  const retryPending = (key: AccountKey): { written: number; dropped: number } =>
    write(database, () => {
      const accountId = findAccountPk(context, key)
      if (accountId === undefined) return { written: 0, dropped: 0 }
      const pending = pendingBook(accountId)
      let written = 0
      const owners = new Map<string, PendingRelation[]>()
      for (const one of pending.all()) owners.set(one.owner, [...(owners.get(one.owner) ?? []), one])
      for (const [owner, entries] of owners) {
        const kept: PendingRelation[] = []
        for (const one of entries) {
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
        if (kept.length !== entries.length) pending.replace(owner, kept)
      }
      return { written, dropped: pending.flush() }
    })

  const saveItem = (
    key: AccountKey,
    accountId: number,
    kind: DealKind,
    item: CrmItem,
    at: number,
    report: { tally: Tally; pending: PendingBook; users: boolean },
  ) => {
    const saved = saveItemRow(key, accountId, kind, item, at)
    if ("reason" in saved) return saved
    const { id } = saved
    if (item.people === undefined && item.assignee === undefined) return null
    const self: CrmRef = { type: kind, id: item.externalId }
    const wanted: Wanted[] = (item.people ?? []).map((person) => ({
      from: self,
      to: { type: "contact", id: person.externalId },
      kind: "related-to",
      role: (DEAL_ROLES as readonly string[]).includes(person.role) ? person.role : "contact",
      ...(person.primary ? { metadata: { primary: true } } : {}),
    }))
    if (item.assignee)
      wanted.push({
        from: self,
        to: { type: "user", id: item.assignee },
        kind: "related-to",
        role: "owner",
        ...(report.users ? {} : { pend: false as const }),
      })
    // Only what the CRM said: its contacts cover the client's roles, its assignee the owner.
    const roles = [
      ...(item.people === undefined ? [] : DEAL_ROLES.filter((role) => role !== "owner")),
      ...(item.assignee === undefined ? [] : ["owner"]),
    ]
    const scope = { from: [`${kind}:${id}`], kinds: ["related-to" as const], roles }
    reportFrom(key, accountId, self, wanted, scope, report.tally, report.pending)
    return null
  }

  const saveItems = (key: AccountKey, kind: DealKind, items: CrmItem[], users: boolean): CrmSaved =>
    write(database, () => {
      const accountId = account(key)
      const at = now()
      const skipped: CrmSkipped[] = []
      const tally = tallied()
      const pending = pendingBook(accountId)
      for (const item of items)
        try {
          const missing = saveItem(key, accountId, kind, item, at, { tally, pending, users })
          if (missing) skipped.push(missing)
        } catch (error) {
          if (!(error instanceof CliError) || error.code !== "validation_error") throw error
          skipped.push({ externalId: item.externalId, reason: "crm.item-invalid", message: error.message })
        }
      tally.droppedPending += pending.flush()
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
          ...(organization.type === undefined ? {} : { type: organization.type }),
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
        // The owner's mark (`own_by: "owner"`) is his: the CRM sets and clears only its own.
        if (organization.own)
          database
            .prepare(
              "UPDATE organizations SET metadata = json_set(coalesce(metadata, '{}'), '$.own', json('true'), " +
                "'$.own_by', 'crm'), updated_at = ? WHERE id = ? " +
                "AND json_extract(coalesce(metadata, '{}'), '$.own_by') IS NOT 'owner' " +
                "AND json_extract(coalesce(metadata, '{}'), '$.own') IS NOT 1",
            )
            .run(at, entity)
        else if (previous.own === true)
          database
            .prepare(
              "UPDATE organizations SET metadata = json_remove(metadata, '$.own', '$.own_by'), updated_at = ? " +
                "WHERE id = ? AND json_extract(metadata, '$.own_by') IS 'crm'",
            )
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
      return { saved: organizations.length, skipped: [] }
    })

  const ownCompanies = (accountId: number): string[] =>
    database
      .prepare(
        "SELECT r.external_id FROM records r JOIN organizations o ON o.id = r.entity_id WHERE r.account_id = ? " +
          "AND r.type = 'organization' AND r.entity_type = 'organization' AND r.deleted_at IS NULL " +
          "AND json_extract(o.metadata, '$.own') = 1 ORDER BY o.id",
      )
      .all(accountId)
      .map((row) => String(row.external_id))

  /**
   * Every stored company of the account against `crm.<provider>:<account>.company-types`, after the run read them all:
   * a customer listed before the own company, or a setting made after the first sync, applies on the next sync.
   */
  const saveCompanyTypes = (key: AccountKey): CrmSaved =>
    write(database, () => {
      const accountId = account(key)
      const tally = tallied()
      const types = crmCompanyTypes(database, key)
      const own = ownCompanies(accountId)
      const mine = own.flatMap((id) => refOf(key, accountId, { type: "company", id }) ?? [])
      const companies = database
        .prepare(
          "SELECT external_id, entity_id, json_extract(fields, '$.type') AS type FROM records WHERE account_id = ? " +
            "AND type = 'organization' AND entity_type = 'organization' AND deleted_at IS NULL " +
            "AND json_type(fields, '$.type') IS NOT NULL",
        )
        .all(accountId)
      for (const company of companies) {
        if (own.includes(String(company.external_id))) continue
        const ref = `organization:${company.entity_id}`
        const meaning = company.type == null ? undefined : types[String(company.type)]
        const relationships = mine.flatMap((other): ReportedRelation[] => {
          if (meaning === "customer-of") return [{ from: ref, to: other, kind: "customer-of" }]
          if (meaning === "supplier") return [{ from: other, to: ref, kind: "customer-of" }]
          if (meaning === "partner-of") return [{ from: ref, to: other, kind: "partner-of" }]
          return []
        })
        const scope = { from: [ref], to: [ref], kinds: ["customer-of" as const, "partner-of" as const] }
        const done = syncReportedIn(context, key, relationships, scope, { source: SOURCE })
        tally.skippedOwnerRejected += done.skippedOwnerRejected
        for (const one of done.issues)
          tally.issues.push({ externalId: String(company.external_id), reason: one.reason, message: one.message })
      }
      return { saved: companies.length, skipped: [], ...relationNotes(tally) }
    })

  const saveUsers = (key: AccountKey, users: CrmUser[], departments: CrmDepartment[] | undefined): CrmSaved => {
    const accountId = account(key)
    const tally = tallied()
    const pending = pendingBook(accountId)
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
        const scope = { from: [ref], kinds: ["member-of" as const], roles: ["employee"] }
        reportFrom(key, accountId, self, wanted, scope, tally, pending)
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
      reportFrom(key, accountId, owner, lines, { from: [ref], kinds: ["reports-to"] }, tally, pending)
    }
    tally.droppedPending += pending.flush()
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

  const markDeleted = (key: AccountKey, kind: CrmKind, rows: Row[]) => {
    const table = kind === "organization" ? "records" : TABLES[kind as DealKind]
    const mark = database.prepare(`UPDATE ${table} SET deleted_at = ? WHERE id = ?`)
    const at = now()
    for (const row of rows) mark.run(at, Number(row.id))
    const accountId = findAccountPk(context, key)
    if (isItemKind(kind) && accountId !== undefined && rows.length) {
      const pending = pendingBook(accountId)
      for (const row of rows) pending.forget(`${kind}:${row.external_id}`)
      pending.flush()
    }
    return rows.length
  }

  return {
    savePipelines: async (key, kind, pipelines) => savePipelines(key, kind, pipelines),
    saveItems: async (key, kind, items, options) => saveItems(key, kind, items, options?.users !== false),
    savePeople: async (key, contacts) => {
      await people.savePeople(
        key,
        contacts.map((contact) => ({
          id: crmIdentityId(key, contact.externalId),
          name: textOf(contact.name, 200),
          email: textOf(contact.email, 320)?.toLowerCase() ?? null,
          phone: textOf(contact.phone, 64),
          ...(contact.phones === undefined ? {} : { phones: listOf(contact.phones, 64) }),
          ...(contact.emails === undefined ? {} : { emails: listOf(contact.emails, 320) }),
        })),
      )
      return write(database, () => {
        const accountId = account(key)
        const tally = tallied()
        const pending = pendingBook(accountId)
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
              ...(sourceRole ? { source_role: [sourceRole] } : {}),
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
          reportFrom(key, accountId, self, wanted, scope, tally, pending)
        }
        tally.droppedPending += pending.flush()
        return { saved: contacts.length, skipped: [], ...relationNotes(tally) }
      })
    },
    retryPending: async (key) => retryPending(key),
    saveCompanyTypes: async (key) => saveCompanyTypes(key),
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
          key,
          kind,
          stored(key, kind).filter((row) => gone.has(String(row.external_id))),
        )
      }),
    removeUnlisted: async (key, kind, listed, before, { dryRun } = {}) =>
      write(database, () => {
        const held = new Set(listed)
        const gone = stored(key, kind).filter(
          (row) => !held.has(String(row.external_id)) && Number(row.updated_at) < before,
        )
        return dryRun ? gone.length : markDeleted(key, kind, gone)
      }),
    scope: async (key) => crmScope(database, key),
    ownUser: async (key) => crmOwnUser(database, key),
    saveOwnUser: async (key, userId) => saveCrmSetting(database, crmSettingKey(key, "self"), userId, now()),
    stageTasks: async (key) => crmStageTasks(database, key),
    stageMoves: async (key) => crmStageMoves(database, key, findAccountPk(context, key)),
    markStageMoves: async (key, through) => saveStageMovesMark(database, key, through, now()),
    stageTasksSince: async (key) => crmStageTasksSince(database, key),
    saveStageEntries: async (key, entries) => stageEntryStore.save(key, entries),
    stageEntries: async (key) => stageEntryStore.pending(key),
    handleStageEntries: async (ids) => stageEntryStore.handled(ids),
    activitiesOn: async (key) => crmActivitiesOn(database, key),
    saveActivities: async (key, activities) => activityStore.save(key, activities),
    activitiesOf: async (key, kind, externalId, limit) => activityStore.of(key, kind, externalId, limit),
    removeOutOfScope: async (key, kind, userIds, { dryRun } = {}) =>
      write(database, () => {
        const keep = new Set(userIds.map((id) => crmIdentityId(key, id, "user")))
        const accountId = findAccountPk(context, key)
        if (accountId === undefined) return 0
        const rows = database
          .prepare(
            `SELECT id, external_id, json_extract(metadata, '$.assignee') AS assignee FROM ${TABLES[kind]} ` +
              "WHERE account_id = ? AND deleted_at IS NULL",
          )
          .all(accountId)
          .filter((row) => row.assignee != null && !keep.has(String(row.assignee)))
        return dryRun ? rows.length : markDeleted(key, kind, rows)
      }),
    removeContacts: async (key, options) =>
      removeCrmContacts(context, key, {
        ...options,
        users: options.users ?? crmScopeUsers(database, key).map(normalCrmUserId),
      }),
    count: async (key, kind) =>
      kind === "person"
        ? Number(
            database
              .prepare("SELECT count(*) AS n FROM identities WHERE provider = ? AND substr(external_id, 1, ?) = ?")
              .get(key.provider, crmAccountPrefix(key).length, crmAccountPrefix(key))?.n,
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
