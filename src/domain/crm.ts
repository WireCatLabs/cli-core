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
  /** Unique among the account's pipelines of its kind; a deal pipeline and a lead pipeline may share one. */
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
  /**
   * Contacts on it, by their id, the part each plays and whether the CRM marks one its main contact. Left out, the CRM
   * did not say who is on it, and the people stored stay.
   */
  people?: { externalId: string; role: DealRole; primary?: boolean }[]
  /** A lead's: the deal it became. */
  deal?: string | null
  /** Epoch milliseconds, as the CRM gives them; the stage history counts from these. */
  createdAt?: number | null
  updatedAt?: number | null
  /** The CRM's own page for it, http or https. */
  url?: string | null
  /** The CRM user it is assigned to, by the user's id: never a contact's. It makes that user's person its `owner`. */
  assignee?: string | null
  /**
   * What the CRM sends that has no column; never a secret. Its own fields' values are here by code as `CrmValue`,
   * which the deal's `provider_metadata` answers.
   */
  metadata?: Record<string, unknown>
}

/** One of the CRM's own fields' values: its label, and for a list field the option's label and `option_id`. */
export interface CrmValue {
  label: string | null
  value: unknown
  option_id?: string | string[]
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
  /** The job title as the CRM writes it: kept beside the relationship, never a role. */
  position?: string | null
  /**
   * The companies the contact represents, by their id; each becomes `member-of` with role `contact`. Left out, the CRM
   * did not say, and the relationships stored stay.
   */
  organizations?: { externalId: string; primary?: boolean; sourceRole?: string | null }[]
}

/** A CRM company: it becomes an organization of its own, never one matched by name. */
export interface CrmOrganization {
  externalId: string
  name: string
  url?: string | null
  /** One of the account's own companies, the owner's side of every deal, not a client. */
  own?: boolean
  /** The CRM's company type code; `crm.<provider>:<account>.company-types` says what one means, nothing by default. */
  type?: string | null
  metadata?: Record<string, unknown>
}

/**
 * A CRM user: someone of the owner's own company, such as a deal's owner. It becomes an identity of the CRM's provider,
 * `<account>/user/<id>`, joined to a person by exact email only, and `member-of` the own company as an `employee`
 * while it is active.
 */
export interface CrmUser {
  externalId: string
  name: string | null
  email?: string | null
  position?: string | null
  /** The departments it belongs to, by their id. */
  departments?: string[]
  active?: boolean
}

/** A department of the own company: a user reports to its head, a head to the head of the parent. */
export interface CrmDepartment {
  externalId: string
  name: string
  parent?: string | null
  /** The user who heads it, by the user's id. */
  head?: string | null
}

/** One of a CRM account's own fields on a kind: what the code a row's `metadata` is keyed by means. */
export interface CrmField {
  /** The CRM's key for it, unique in its kind. */
  code: string
  /** Its title in the CRM; null when the CRM gives none. */
  label: string | null
  /** The CRM's own word for its type, such as `string` or `enumeration`. */
  type: string
  multiple: boolean
  /** Whether the CRM can filter a list by it. */
  filterable: boolean
  /** A list field's options in the CRM's order; absent on any other field. */
  options?: { id: string; label: string }[]
}

export interface CrmRecords {
  deal: CrmItem
  lead: CrmItem
  person: CrmPerson
  organization: CrmOrganization
}

export const isItemKind = (kind: CrmKind): kind is DealKind => kind === "deal" || kind === "lead"
