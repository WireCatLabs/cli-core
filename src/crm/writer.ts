import type { CrmItem } from "../domain/crm.js"
import type { DealKind, DealRole } from "../domain/deals.js"
import type { Level, PermissionKey } from "../sends/permissions.js"

export const CRM_VERBS = ["create", "update", "move", "close", "remove"] as const
export type CrmVerb = (typeof CRM_VERBS)[number]

export interface CrmWriteCapabilities {
  /** The kinds the CRM takes writes for. */
  kinds: readonly DealKind[]
  verbs: readonly CrmVerb[]
  /**
   * The CRM answers a repeat of an `operationId` from its record instead of doing the write again (Bitrix24 REST
   * 3.0's `Idempotency-Key`). Only then may the owner repeat a write whose answer was lost with the same id.
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
  custom?: Record<string, string | null>
}

export type CrmDraft = CrmFields & { title: string }

export interface CrmWriteOptions {
  /** Journaled before the call; an idempotent CRM gets it as its idempotency key. */
  operationId: string
}

/**
 * Writes to one CRM account. Each answers the whole item as the CRM holds it after the write, every field and not
 * only the changed ones: the store replaces its copy with it. None of them retries: a write whose answer was lost
 * throws `outcome_unknown`.
 */
export interface CrmWriter {
  readonly provider: string
  readonly capabilities: CrmWriteCapabilities
  create(kind: DealKind, draft: CrmDraft, options: CrmWriteOptions): Promise<CrmItem>
  update(kind: DealKind, externalId: string, patch: CrmFields, options: CrmWriteOptions): Promise<CrmItem>
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

/**
 * Built in, and only ever tightening (WC-PERM-7): an ordinary change goes ahead, a deletion asks, and a record is not
 * given to somebody else until the owner allows it.
 */
export const CRM_WRITE_DEFAULTS: Readonly<Record<PermissionKey, Level>> = {
  "deals.delete": "ask",
  "leads.delete": "ask",
  [CRM_ASSIGN_OTHERS_KEY]: "deny",
}
