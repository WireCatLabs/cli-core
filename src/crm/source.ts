import type { CrmDepartment, CrmField, CrmKind, CrmPipeline, CrmRecords, CrmUser } from "../domain/crm.js"
import type { DealKind } from "../domain/deals.js"

export interface CrmSourceTraits {
  /** What this CRM has: one without leads leaves `lead` out. Contacts and companies come before the items on them. */
  kinds: readonly CrmKind[]
  /**
   * `changes()` names what was deleted in `removed`, so the engine never lists every id to find them. A CRM that
   * only lists what exists leaves this false and gives `ids()`.
   */
  removedInChanges: boolean
}

export interface CrmPage<T> {
  items: T[]
  /** Ids the CRM says it deleted since the cursor; never one that only left a filter. */
  removed?: string[]
  /** More pages in this round. */
  nextPage?: string
  /** On the last page: the cursor the next run reads changes after; `null` when the CRM keeps none. */
  cursor?: string | null
}

/** `reset`: the cursor is dead, and the CRM must be listed in full again. */
export type CrmChanges<T> = CrmPage<T> | { reset: true }

export interface CrmIdPage {
  ids: string[]
  nextPage?: string
}

/** One CRM account, as an adapter reads it. The engine never sees a provider word. */
export interface CrmSource {
  /** The registry name: `bitrix24`, `pipedrive`, `hubspot`, `amocrm`. */
  readonly provider: string
  readonly traits: CrmSourceTraits
  /** One kind's pipelines with their stages; a CRM whose leads have no pipelines answers one of its own making. */
  pipelines(kind: DealKind): Promise<CrmPipeline[]>
  /**
   * What changed since `cursor`, a page at a time; `cursor: null` lists everything. A CRM without a change feed
   * reads by its own modified time, with an overlap, and gives that time back as the cursor.
   */
  changes<K extends CrmKind>(kind: K, cursor: string | null, page?: string): Promise<CrmChanges<CrmRecords[K]>>
  /**
   * The CRM's own fields on one kind, in its order: what the codes in a row's `metadata` mean. Read every sync; a CRM
   * without custom fields leaves it out, and one that has none on a kind answers `[]`.
   */
  fields?(kind: CrmKind): Promise<CrmField[]>
  /** Every id the CRM holds of the kind, a page at a time: how deletions are found when `removedInChanges` is false. */
  ids?(kind: CrmKind, page?: string): Promise<CrmIdPage>
  /** Every user of the account, active or not; a CRM that cannot list them leaves it out, and its users stay. */
  users?(): Promise<CrmUser[]>
  /** Every department; left out, reporting lines are unknown and none stored is withdrawn. */
  departments?(): Promise<CrmDepartment[]>
}
