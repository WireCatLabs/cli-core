import type { ConditionalKey } from "../cli/permission-keys.js"
import type { CrmItem, CrmKind, CrmRecords } from "../domain/crm.js"
import type { DealKind, DealRole } from "../domain/deals.js"
import type { Level, PermissionKey } from "../sends/permissions.js"

export const CRM_VERBS = ["create", "update", "move", "close", "remove"] as const
export type CrmVerb = (typeof CRM_VERBS)[number]

export interface CrmWriteCapabilities {
  /** The kinds the CRM takes writes for; a contact or a company takes only `create` and `update`. */
  kinds: readonly CrmKind[]
  verbs: readonly CrmVerb[]
  /**
   * The CRM answers a repeat of an `operationId` from its record instead of doing the write again. Only then may the
   * owner repeat a write whose answer was lost with the same id. Bitrix24 is not: a live portal (2026-11-07) made a
   * create repeated with one REST 3.0 `Idempotency-Key` a second time.
   */
  idempotent: boolean
}

/**
 * A deal's or lead's fields in `CrmItem`'s names, each the CRM's own id; `null` clears one. `custom` holds the CRM's
 * own fields by their code. A custom code that is one of the named fields under another name (a stage, a pipeline, an
 * owner or a status) is refused by the adapter: through it a write would get round the keys those fields check.
 */
export interface CrmFields {
  title?: string
  pipeline?: string
  stage?: string
  /** A decimal string in `currency`; both or neither. */
  amount?: string | null
  currency?: string | null
  /** `YYYY-MM-DD`. */
  closeDate?: string | null
  organization?: string | null
  /** Replaces the whole list. */
  people?: { externalId: string; role: DealRole }[]
  /** The CRM user it is assigned to: a user's id, never a contact's. */
  owner?: string | null
  /** A list field's option by its id; a multiple field's values as a list; `null` clears it. */
  custom?: Record<string, string | string[] | null>
}

export type CrmDraft = CrmFields & { title: string }

/** A contact's fields; `null` clears one. Each list replaces the whole list. */
export interface CrmPersonFields {
  /** The whole name, for a CRM that keeps one; a CRM with parts splits it. */
  name?: string
  firstName?: string | null
  lastName?: string | null
  position?: string | null
  emails?: string[]
  phones?: string[]
  /** The CRM user it is assigned to. */
  owner?: string | null
  custom?: Record<string, string | string[] | null>
}

/** A company's fields; `null` clears one. */
export interface CrmOrganizationFields {
  name?: string
  /** Each list replaces the CRM's whole list. */
  emails?: string[]
  phones?: string[]
  owner?: string | null
  custom?: Record<string, string | string[] | null>
}

/** What a write of each kind sends. */
export interface CrmWriteFields {
  deal: CrmFields
  lead: CrmFields
  person: CrmPersonFields
  organization: CrmOrganizationFields
}

/** What a create of each kind sends: a deal its title, a company its name, a contact a name or one of its parts. */
export interface CrmDrafts {
  deal: CrmDraft
  lead: CrmDraft
  person: CrmPersonFields
  organization: CrmOrganizationFields & { name: string }
}

export interface CrmWriteOptions {
  /** Journaled before the call; an idempotent CRM gets it as its idempotency key. */
  operationId: string
}

/**
 * Writes to one CRM account. Each answers the whole item as the CRM holds it after the write, every field and not
 * only the changed ones: the store replaces its copy with it. None of them retries: a write whose answer was lost
 * throws `outcome_unknown`. A write the CRM made whose item could then not be read back throws with `sent: true` in
 * its details: it is journaled as sent, and the read's failure is answered on its own.
 */
export interface CrmWriter {
  readonly provider: string
  readonly capabilities: CrmWriteCapabilities
  create<K extends CrmKind>(kind: K, draft: CrmDrafts[K], options: CrmWriteOptions): Promise<CrmRecords[K]>
  update<K extends CrmKind>(
    kind: K,
    externalId: string,
    patch: CrmWriteFields[K],
    options: CrmWriteOptions,
  ): Promise<CrmRecords[K]>
  /** To `stage`, a stage of the item's own pipeline. */
  move(kind: DealKind, externalId: string, stage: string, options: CrmWriteOptions): Promise<CrmItem>
  /**
   * Won or lost, the CRM's own way: Pipedrive sets a status, Kommo and Bitrix24 move it to the pipeline's closing
   * stage, HubSpot to a closed stage.
   */
  close(
    kind: DealKind,
    externalId: string,
    outcome: "won" | "lost",
    options: CrmWriteOptions & { reason?: string },
  ): Promise<CrmItem>
  remove(kind: DealKind, externalId: string, options: CrmWriteOptions): Promise<void>
}

/** Giving a record to a CRM user other than the one the sign-in acts as. */
export const CRM_ASSIGN_OTHERS_KEY: PermissionKey = "crm.assign-others"

/** The keys the CRM writes check beyond their command paths, for a CLI's `commandPermissions({ extra })`. */
export const CRM_WRITE_KEYS: readonly PermissionKey[] = [CRM_ASSIGN_OTHERS_KEY]

const PLURALS: Record<string, CrmKind> = {
  deals: "deal",
  leads: "lead",
  people: "person",
  organizations: "organization",
}
const VERB_OF: Record<string, CrmVerb> = {
  create: "create",
  update: "update",
  move: "move",
  close: "close",
  delete: "remove",
}

/**
 * Every key a CRM write command may check beyond its own path, for `commandPermissions({ alsoChecks })`, so its
 * `--dry-run` names each: a stage implies the move key and a won or lost one the close key, an owner other than the
 * sign-in's `crm.assign-others`, and `also` the CLI's own (the same `CrmWrites.alsoChecks` the real run checks).
 */
export const crmAlsoChecks =
  (also?: (kind: CrmKind, verb: CrmVerb) => readonly PermissionKey[]) =>
  (path: readonly string[]): readonly (PermissionKey | ConditionalKey)[] => {
    const [noun, command] = path
    const kind = noun === undefined ? undefined : PLURALS[noun]
    const verb = command === undefined ? undefined : VERB_OF[command]
    if (path.length !== 2 || kind === undefined || verb === undefined) return []
    const close = { key: `${noun}.close`, when: "a won or lost stage" }
    const assign = { key: CRM_ASSIGN_OTHERS_KEY, when: "--owner other than the sign-in's user" }
    const implied: ConditionalKey[] =
      kind === "person" || kind === "organization"
        ? verb === "create" || verb === "update"
          ? [assign]
          : []
        : verb === "create" || verb === "update"
          ? [{ key: `${noun}.move`, when: "--stage" }, close, assign]
          : verb === "move"
            ? [close]
            : []
    return [...implied, ...(also?.(kind, verb) ?? [])]
  }

/**
 * Built in, and only ever tightening (WC-PERM-7): an ordinary change goes ahead, a deletion asks, and a record is not
 * given to somebody else until the owner allows it.
 */
export const CRM_WRITE_DEFAULTS: Readonly<Record<PermissionKey, Level>> = {
  "deals.delete": "ask",
  "leads.delete": "ask",
  [CRM_ASSIGN_OTHERS_KEY]: "deny",
}
