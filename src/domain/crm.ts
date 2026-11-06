import type { DealKind, DealRole, DealStatus, StageOutcome } from "./deals.js"

/** What a CRM holds that the store copies: its deals and leads, and the contacts and companies on them. */
export const CRM_KINDS = ["organization", "person", "deal", "lead"] as const
export type CrmKind = (typeof CRM_KINDS)[number]

/** One stage of a CRM pipeline, as the CRM orders and marks it. */
export interface CrmStage {
  /** Unique in its pipeline. */
  externalId: string
  name: string
  /** Any numbers; the store keeps the order they give. */
  position: number
  outcome: StageOutcome
}

export interface CrmPipeline {
  /**
   * Unique among the account's pipelines of its kind. Until the store's key is widened, one with the id of a stored
   * pipeline of the other kind is skipped and named.
   */
  externalId: string
  name: string
  stages: CrmStage[]
}

/** A deal or a lead as the CRM has it. Every reference is the CRM's own id; the store resolves them. */
export interface CrmItem {
  externalId: string
  title: string
  pipeline: string
  stage: string
  /**
   * Whether it is still open, won or lost, where the CRM keeps that on the item (Pipedrive's `status`); left out, the
   * stage's outcome says it.
   */
  status?: DealStatus | null
  /** A decimal string in `currency`; both or neither. */
  amount?: string | null
  /** ISO 4217. */
  currency?: string | null
  /** `YYYY-MM-DD`: when it is expected to close. */
  closeDate?: string | null
  /** `YYYY-MM-DD`: when it was won or lost. */
  closedDate?: string | null
  /** Why it was won or lost, as the CRM keeps it. */
  closedReason?: string | null
  /** A company's id. */
  organization?: string | null
  /** Contacts on it, by their id, and the part each plays. */
  people?: { externalId: string; role: DealRole }[]
  /** A lead's: the deal it became. */
  deal?: string | null
  /** Epoch milliseconds, as the CRM gives them; the stage history counts from these. */
  createdAt?: number | null
  updatedAt?: number | null
  /** The CRM's own page for it, http or https. */
  url?: string | null
  /** What the CRM sends that has no column, such as custom fields with their labels; never a secret. */
  metadata?: Record<string, unknown>
}

/**
 * A CRM contact: it becomes an identity of the CRM's provider, `<account>/contact/<id>`, joined to a person by exact
 * email only. A CRM user, such as a deal's owner, is not a contact: its ids are another sequence (`<account>/user/<id>`).
 */
export interface CrmPerson {
  externalId: string
  name: string | null
  email?: string | null
  phone?: string | null
}

/** A CRM company: it becomes an organization of its own, never one matched by name. */
export interface CrmOrganization {
  externalId: string
  name: string
  url?: string | null
  metadata?: Record<string, unknown>
}

export interface CrmRecords {
  deal: CrmItem
  lead: CrmItem
  person: CrmPerson
  organization: CrmOrganization
}

export const isItemKind = (kind: CrmKind): kind is DealKind => kind === "deal" || kind === "lead"
