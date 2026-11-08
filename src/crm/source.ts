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

/**
 * What a CRM account did not report in the last sync, so an answer can name it: a kind it has not, users or departments
 * it does not list, a list the sign-in's scope refused (`code`, and the `scope` the adapter named), or a part a source
 * said it could not read.
 */
export interface CrmGap {
  kind: CrmKind | "users" | "departments"
  reason: "not-listed" | "refused" | "partial"
  code?: string
  scope?: string
  message: string
}

/** What the engine hands every source call; a source that ignores it works as before. */
export interface CrmCallContext {
  /**
   * Takes one request from the run's budget, for each request beyond the one the engine takes before the call (a
   * source that pages internally). Throws once the budget is spent: the run stops there as `partial`.
   */
  spend(): void
  /** Says what the call could not read without failing it, such as e-mails a missing scope hides. */
  gap(gap: { kind: CrmGap["kind"]; message: string; scope?: string }): void
}

/** One CRM account, as an adapter reads it. The engine never sees a provider word. */
export interface CrmSource {
  /** The registry name: `bitrix24`, `pipedrive`, `hubspot`, `amocrm`. */
  readonly provider: string
  readonly traits: CrmSourceTraits
  /** One kind's pipelines with their stages; a CRM whose leads have no pipelines answers one of its own making. */
  pipelines(kind: DealKind, context?: CrmCallContext): Promise<CrmPipeline[]>
  /**
   * What changed since `cursor`, a page at a time; `cursor: null` lists everything. A CRM without a change feed
   * reads by its own modified time, with an overlap, and gives that time back as the cursor.
   */
  changes<K extends CrmKind>(
    kind: K,
    cursor: string | null,
    page?: string,
    context?: CrmCallContext,
  ): Promise<CrmChanges<CrmRecords[K]>>
  /**
   * The CRM's own fields on one kind, in its order: what the codes in a row's `metadata` mean. Read every sync; a CRM
   * without custom fields leaves it out, and one that has none on a kind answers `[]`.
   */
  fields?(kind: CrmKind, context?: CrmCallContext): Promise<CrmField[]>
  /** Every id the CRM holds of the kind, a page at a time: how deletions are found when `removedInChanges` is false. */
  ids?(kind: CrmKind, page?: string, context?: CrmCallContext): Promise<CrmIdPage>
  /** Every user of the account, active or not; a CRM that cannot list them leaves it out, and its users stay. */
  users?(context?: CrmCallContext): Promise<CrmUser[]>
  /** Every department; left out, reporting lines are unknown and none stored is withdrawn. */
  departments?(context?: CrmCallContext): Promise<CrmDepartment[]>
}
