import { CliError } from "@wirecat/cli-base"
import type { CrmItem, CrmKind, CrmOrganization, CrmPerson, CrmPipeline } from "../../domain/crm.js"
import { DEAL_ROLES, type DealKind, STAGE_OUTCOMES } from "../../domain/deals.js"
import { currencyOf, minorUnits } from "../../domain/money.js"
import { recordFingerprint } from "../../domain/records.js"
import { fold } from "../normalize.js"
import type { AccountPeople } from "../people.js"
import type { AccountKey } from "../types.js"
import { accountPk, findAccountPk } from "./accounts.js"
import { linkKind } from "./link-kinds.js"
import { authorActor } from "./memories.js"
import type { StoreContext } from "./open.js"
import { write } from "./transaction.js"

/** An item the store could not keep, and why: its stage is not stored yet, or a field the store refuses. */
export interface CrmSkipped {
  externalId: string
  reason: "crm.stage-unknown" | "crm.item-invalid"
  message: string
}

export interface CrmSaved {
  saved: number
  skipped: CrmSkipped[]
}

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
  /** How many of the kind the account holds, not deleted. */
  count(key: AccountKey, kind: CrmKind): Promise<number>
}

type Row = Record<string, unknown>

const TABLES = { deal: "deals", lead: "leads" } as const
/** Who writes a CRM's copies: the sync, not an agent, so `author.kind` is `rule`. */
const SOURCE = "crm"

/**
 * A contact's identity id: identities are unique per provider, and two portals of one CRM both have a contact 5.
 * `contact:` references percent-encode it, so the `/` stays one part.
 */
export const crmIdentityId = (key: AccountKey, externalId: string): string => `${key.account}/${externalId}`

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

  const pipelineOf = (accountId: number, externalId: string) =>
    database.prepare("SELECT * FROM pipelines WHERE account_id = ? AND external_id = ?").get(accountId, externalId)

  const savePipelines = (key: AccountKey, kind: DealKind, pipelines: CrmPipeline[]): CrmSaved =>
    write(database, () => {
      const accountId = account(key)
      const at = now()
      for (const pipeline of pipelines) {
        const name = textOf(pipeline.name, 80) ?? pipeline.externalId
        const held = pipelineOf(accountId, pipeline.externalId)
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
        if (held && (held.name !== name || held.kind !== kind))
          database
            .prepare("UPDATE pipelines SET name = ?, name_folded = ?, kind = ?, updated_at = ? WHERE id = ?")
            .run(name, fold(name), kind, at, id)
        saveStages(id, pipeline, at)
      }
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
    for (const row of held) {
      if (row.external_id != null && listed.has(String(row.external_id))) rename.run(`\u0000${row.id}`, Number(row.id))
      else if (taken.has(String(row.name_folded)))
        rename.run(`${row.name_folded} (${row.external_id ?? row.id})`, Number(row.id))
    }
    const byId = new Map(held.map((row) => [String(row.external_id), row]))
    for (const stage of wanted) {
      const row = byId.get(stage.externalId)
      if (row)
        database
          .prepare(
            "UPDATE pipeline_stages SET name = ?, name_folded = ?, position = ?, outcome = ?, updated_at = ? WHERE id = ?",
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

  const personIdOf = (key: AccountKey, externalId: string): number | null => {
    const row = database
      .prepare(
        "SELECT l.person_id FROM identities i JOIN identity_links l ON l.identity_id = i.id " +
          "WHERE i.provider = ? AND i.external_id = ?",
      )
      .get(key.provider, crmIdentityId(key, externalId))
    return row ? Number(row.person_id) : null
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

  const saveItem = (key: AccountKey, accountId: number, kind: DealKind, item: CrmItem, at: number) => {
    const pipeline = pipelineOf(accountId, item.pipeline)
    const stage =
      pipeline &&
      database
        .prepare("SELECT id, outcome FROM pipeline_stages WHERE pipeline_id = ? AND external_id = ?")
        .get(Number(pipeline.id), item.stage)
    if (!pipeline || pipeline.kind !== kind || !stage)
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
    const status = String(stage.outcome)
    const closed =
      status === "open"
        ? null
        : (day(item.closedDate, "a closed day") ?? new Date(epoch(item.updatedAt, at)).toISOString().slice(0, 10))
    const deal =
      kind === "lead" && item.deal
        ? database.prepare("SELECT id FROM deals WHERE account_id = ? AND external_id = ?").get(accountId, item.deal)
        : undefined
    const metadata = { ...(item.metadata ?? {}), ...(item.url ? { url: item.url } : {}) }
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
    database
      .prepare(
        `DELETE FROM links WHERE from_type = ? AND from_id = ? AND to_type = 'person' AND kind = ${linkKind("related-to")} ` +
          "AND source = ?",
      )
      .run(kind, id, SOURCE)
    const link = database.prepare(
      "INSERT INTO links (from_type, from_id, to_type, to_id, kind, role, source, confirmed, created_at, author, " +
        `updated_at) VALUES (?, ?, 'person', ?, ${linkKind("related-to")}, ?, ?, 1, ?, 'rule', ?)`,
    )
    const seen = new Set<number>()
    for (const person of item.people ?? []) {
      const personId = personIdOf(key, person.externalId)
      const role = (DEAL_ROLES as readonly string[]).includes(person.role) ? person.role : "contact"
      if (personId === null || seen.has(personId)) continue
      seen.add(personId)
      link.run(kind, id, personId, role, SOURCE, at, at)
    }
    return null
  }

  const saveItems = (key: AccountKey, kind: DealKind, items: CrmItem[]): CrmSaved =>
    write(database, () => {
      const accountId = account(key)
      const at = now()
      const skipped: CrmSkipped[] = []
      for (const item of items)
        try {
          const missing = saveItem(key, accountId, kind, item, at)
          if (missing) skipped.push(missing)
        } catch (error) {
          if (!(error instanceof CliError) || error.code !== "validation_error") throw error
          skipped.push({ externalId: item.externalId, reason: "crm.item-invalid", message: error.message })
        }
      return { saved: items.length - skipped.length, skipped }
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
          ...(organization.metadata ?? {}),
        }
        const fingerprint = recordFingerprint(fields, [])
        const held = database
          .prepare("SELECT * FROM records WHERE account_id = ? AND type = 'organization' AND external_id = ?")
          .get(accountId, organization.externalId)
        const before = held ? (JSON.parse(String(held.fields)) as { name?: unknown }).name : undefined
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
      return { saved: contacts.length, skipped: [] }
    },
    saveOrganizations: async (key, organizations) => saveOrganizations(key, organizations),
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
    count: async (key, kind) => stored(key, kind).length,
  }
}
