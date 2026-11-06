import type { CrmItem, CrmKind, CrmOrganization, CrmPerson, CrmPipeline, CrmRecords } from "../../domain/crm.js"
import type { DealKind } from "../../domain/deals.js"
import type { CrmChanges, CrmIdPage, CrmSource, CrmSourceTraits } from "../source.js"

export interface FakeCrmSourceOptions {
  traits?: Partial<CrmSourceTraits>
  /** Rows per page of `changes()` and `ids()`; 2 when absent, so every list has several pages. */
  pageSize?: number
}

/** A CRM held in memory, with a change feed: what the contracts sync against, and what a CLI's tests may use. */
export interface FakeCrmSource extends CrmSource {
  /** Adds or changes a row; it is in the next `changes()`. */
  put<K extends CrmKind>(kind: K, record: CrmRecords[K]): void
  /** Deletes a row: named in `removed` when `removedInChanges`, otherwise only missing from `ids()`. */
  delete(kind: CrmKind, externalId: string): void
  setPipelines(kind: DealKind, pipelines: CrmPipeline[]): void
  /** The kind's cursors older than its latest change are refused, once, with `{ reset: true }`. */
  expireCursors(kind: CrmKind): void
  /** Lists no id at all, as a CRM does for a sign-in that lost its rights. */
  hideAll(hidden: boolean): void
  /** Requests made, by method. */
  readonly calls: { pipelines: number; changes: number; ids: number }
}

interface Held {
  record: unknown
  version: number
  deleted: boolean
}

/** When the fake CRM's changes happened: well before any `now` a contract syncs at. */
const STAMPED_FROM = Date.UTC(2026, 0, 1)

export const SALES_PIPELINE: CrmPipeline = {
  externalId: "deal-1",
  name: "Example sales",
  stages: [
    { externalId: "new", name: "New", position: 1, outcome: "open" },
    { externalId: "quote", name: "Quote sent", position: 2, outcome: "open" },
    { externalId: "won", name: "Won", position: 3, outcome: "won" },
    { externalId: "lost", name: "Lost", position: 4, outcome: "lost" },
  ],
}

export const LEAD_PIPELINE: CrmPipeline = {
  externalId: "lead-1",
  name: "Example leads",
  stages: [
    { externalId: "lead-new", name: "New", position: 1, outcome: "open" },
    { externalId: "lead-good", name: "Converted", position: 2, outcome: "won" },
    { externalId: "lead-junk", name: "Junk", position: 3, outcome: "lost" },
  ],
}

export const fakeCrmSource = (options: FakeCrmSourceOptions = {}): FakeCrmSource => {
  const traits: CrmSourceTraits = {
    kinds: ["organization", "person", "deal", "lead"],
    removedInChanges: false,
    ...options.traits,
  }
  const size = options.pageSize ?? 2
  const rows = new Map<CrmKind, Map<string, Held>>()
  const pipelines: Record<DealKind, CrmPipeline[]> = { deal: [SALES_PIPELINE], lead: [LEAD_PIPELINE] }
  let version = 0
  const expired = new Map<CrmKind, number>()
  let hidden = false
  const calls = { pipelines: 0, changes: 0, ids: 0 }
  const of = (kind: CrmKind) => {
    const held = rows.get(kind) ?? new Map<string, Held>()
    rows.set(kind, held)
    return held
  }
  const window = <T>(list: T[], page: string | undefined) => {
    const at = page === undefined ? 0 : Number(page)
    const next = at + size
    return { slice: list.slice(at, next), nextPage: next < list.length ? String(next) : undefined }
  }
  return {
    provider: "example-crm",
    traits,
    calls,
    put(kind, record) {
      version += 1
      // A CRM stamps each change; without one here the store would take its own clock, which an id pass skips.
      const stamped =
        (kind === "deal" || kind === "lead") && (record as CrmItem).updatedAt == null
          ? { ...(record as CrmItem), updatedAt: STAMPED_FROM + version * 1000 }
          : record
      of(kind).set((record as { externalId: string }).externalId, { record: stamped, version, deleted: false })
    },
    delete(kind, externalId) {
      const held = of(kind).get(externalId)
      if (!held) return
      version += 1
      of(kind).set(externalId, { ...held, version, deleted: true })
    },
    setPipelines(kind, list) {
      pipelines[kind] = list
    },
    expireCursors(kind) {
      expired.set(kind, version)
    },
    hideAll(value) {
      hidden = value
    },
    async pipelines(kind) {
      calls.pipelines += 1
      return pipelines[kind]
    },
    async changes<K extends CrmKind>(
      kind: K,
      cursor: string | null,
      page?: string,
    ): Promise<CrmChanges<CrmRecords[K]>> {
      calls.changes += 1
      const since = cursor === null ? null : Number(cursor)
      if (since !== null && since < (expired.get(kind) ?? 0)) {
        expired.delete(kind)
        return { reset: true }
      }
      const changed = [...of(kind).entries()]
        .filter(([, held]) => (since === null ? !held.deleted : held.version > since))
        .filter(([, held]) => !held.deleted || traits.removedInChanges)
        .sort(([, a], [, b]) => a.version - b.version)
      const { slice, nextPage } = window(changed, page)
      return {
        items: slice.filter(([, held]) => !held.deleted).map(([, held]) => held.record as CrmRecords[K]),
        ...(traits.removedInChanges ? { removed: slice.filter(([, held]) => held.deleted).map(([id]) => id) } : {}),
        ...(nextPage === undefined ? { cursor: String(version) } : { nextPage }),
      }
    },
    async ids(kind, page): Promise<CrmIdPage> {
      calls.ids += 1
      const listed = hidden ? [] : [...of(kind).entries()].filter(([, held]) => !held.deleted).map(([id]) => id)
      const { slice, nextPage } = window(listed, page)
      return { ids: slice, ...(nextPage === undefined ? {} : { nextPage }) }
    },
  }
}

export const exampleDeal = (externalId: string, extra: Partial<CrmItem> = {}): CrmItem => ({
  externalId,
  title: `Example deal ${externalId}`,
  pipeline: SALES_PIPELINE.externalId,
  stage: "new",
  ...extra,
})

export const exampleLead = (externalId: string, extra: Partial<CrmItem> = {}): CrmItem => ({
  externalId,
  title: `Example lead ${externalId}`,
  pipeline: LEAD_PIPELINE.externalId,
  stage: "lead-new",
  ...extra,
})

export const examplePerson = (externalId: string, extra: Partial<CrmPerson> = {}): CrmPerson => ({
  externalId,
  name: `Example person ${externalId}`,
  ...extra,
})

export const exampleOrganization = (externalId: string, extra: Partial<CrmOrganization> = {}): CrmOrganization => ({
  externalId,
  name: `Example company ${externalId}`,
  ...extra,
})
