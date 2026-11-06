import { CliError } from "@wirecat/cli-base"
import type {
  CrmField,
  CrmItem,
  CrmKind,
  CrmOrganization,
  CrmPerson,
  CrmPipeline,
  CrmRecords,
} from "../../domain/crm.js"
import type { DealKind } from "../../domain/deals.js"
import type { CrmChanges, CrmIdPage, CrmSource, CrmSourceTraits } from "../source.js"
import { CRM_VERBS, type CrmFields, type CrmVerb, type CrmWriteCapabilities, type CrmWriter } from "../writer.js"

export interface FakeCrmSourceOptions {
  traits?: Partial<CrmSourceTraits>
  /** Rows per page of `changes()` and `ids()`; 2 when absent, so every list has several pages. */
  pageSize?: number
  /** What the write side takes: every verb on both kinds, not idempotent, when absent. */
  capabilities?: Partial<CrmWriteCapabilities>
}

/** One write the fake CRM was sent, in order. */
export interface FakeCrmWrite {
  verb: CrmVerb
  kind: DealKind
  externalId: string | null
  operationId: string
}

/**
 * A CRM held in memory, with a change feed and a write side: what the contracts sync and write against, and what a
 * CLI's tests may use. Custom field codes `stage`, `pipeline`, `owner` and `status` are refused, as an adapter refuses
 * a custom code that names one of the neutral fields.
 */
export interface FakeCrmSource extends CrmSource, CrmWriter {
  /** Adds or changes a row; it is in the next `changes()`. */
  put<K extends CrmKind>(kind: K, record: CrmRecords[K]): void
  /** Deletes a row: named in `removed` when `removedInChanges`, otherwise only missing from `ids()`. */
  delete(kind: CrmKind, externalId: string): void
  setPipelines(kind: DealKind, pipelines: CrmPipeline[]): void
  /** The kind's own fields from the next `fields()` on: deals have `SOURCE_FIELD` and the rest none until set. */
  setFields(kind: CrmKind, fields: CrmField[]): void
  /** The kind's cursors older than its latest change are refused, once, with `{ reset: true }`. */
  expireCursors(kind: CrmKind): void
  /** Lists no id at all, as a CRM does for a sign-in that lost its rights. */
  hideAll(hidden: boolean): void
  /** The next write is carried out and its answer lost: it throws `outcome_unknown`. */
  loseNextAnswer(): void
  /** Requests made, by method. */
  readonly calls: { pipelines: number; fields: number; changes: number; ids: number }
  /** Writes sent, refused ones included. */
  readonly writes: FakeCrmWrite[]
}

/** Custom codes the fake refuses: each is a neutral field under another name. */
export const FAKE_CRM_ALIASES = ["stage", "pipeline", "owner", "status"]

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

/** A deal's list field, as a CRM lists one: what the fake's deals have. */
export const SOURCE_FIELD: CrmField = {
  code: "UF_SOURCE",
  label: "Source",
  type: "enumeration",
  multiple: false,
  filterable: true,
  options: [
    { id: "1", label: "Website" },
    { id: "2", label: "Fair" },
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
  const fields: Record<CrmKind, CrmField[]> = { deal: [SOURCE_FIELD], lead: [], person: [], organization: [] }
  let version = 0
  const expired = new Map<CrmKind, number>()
  let hidden = false
  const calls = { pipelines: 0, fields: 0, changes: 0, ids: 0 }
  const capabilities: CrmWriteCapabilities = {
    kinds: ["deal", "lead"],
    verbs: CRM_VERBS,
    idempotent: false,
    ...options.capabilities,
  }
  const writes: FakeCrmWrite[] = []
  const answered = new Map<string, CrmItem | undefined>()
  let made = 0
  let lose = false
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
  const held = (kind: DealKind, externalId: string) => {
    const found = of(kind).get(externalId)
    if (!found || found.deleted) throw new CliError("not_found", `the CRM has no ${kind} ${externalId}`)
    return found.record as CrmItem
  }
  const placed = (kind: DealKind, pipelineId: string | undefined, stageId: string | undefined) => {
    const pipeline =
      pipelineId === undefined ? pipelines[kind][0] : pipelines[kind].find((one) => one.externalId === pipelineId)
    const stage =
      stageId === undefined ? pipeline?.stages[0] : pipeline?.stages.find((one) => one.externalId === stageId)
    if (!pipeline || !stage) throw new CliError("validation_error", `the CRM has no stage ${stageId} there`)
    return { pipeline: pipeline.externalId, stage: stage.externalId, outcome: stage.outcome }
  }
  const applied = (item: CrmItem, fields: CrmFields): CrmItem => {
    const { custom, owner, pipeline, stage, ...named } = fields
    const metadata = {
      ...item.metadata,
      ...(owner === undefined ? {} : { owner }),
      ...(custom ? { custom: { ...(item.metadata?.custom as object), ...custom } } : {}),
    }
    return {
      ...item,
      ...Object.fromEntries(Object.entries(named).filter(([, value]) => value !== undefined)),
      ...(pipeline === undefined ? {} : { pipeline }),
      ...(stage === undefined ? {} : { stage }),
      metadata,
      updatedAt: null,
    }
  }
  const refuseAliases = (fields: CrmFields) => {
    const refused = Object.keys(fields.custom ?? {}).find((code) => FAKE_CRM_ALIASES.includes(code))
    if (refused) throw new CliError("validation_error", `${refused} is not a custom field`)
  }
  /** Each write once: a repeated idempotent id answers its first outcome; a lost answer still made the change. */
  const write = <T extends CrmItem | undefined>(
    verb: CrmVerb,
    kind: DealKind,
    externalId: string | null,
    operationId: string,
    act: () => T,
  ): T => {
    writes.push({ verb, kind, externalId, operationId })
    if (capabilities.idempotent && answered.has(operationId)) return answered.get(operationId) as T
    const done = act()
    if (capabilities.idempotent) answered.set(operationId, done)
    if (lose) {
      lose = false
      throw new CliError("outcome_unknown", "the CRM did not answer")
    }
    return done
  }
  const saved = (kind: DealKind, item: CrmItem) => {
    fake.put(kind, item)
    return held(kind, item.externalId)
  }
  const fake: FakeCrmSource = {
    provider: "example-crm",
    traits,
    calls,
    capabilities,
    writes,
    loseNextAnswer() {
      lose = true
    },
    async create(kind, draft, { operationId }) {
      refuseAliases(draft)
      return write("create", kind, null, operationId, () => {
        const { pipeline, stage } = placed(kind, draft.pipeline, draft.stage)
        made += 1
        const blank: CrmItem = { externalId: `${kind}-new-${made}`, title: draft.title, pipeline, stage }
        return saved(kind, applied(blank, { ...draft, pipeline, stage }))
      })
    },
    async update(kind, externalId, patch, { operationId }) {
      refuseAliases(patch)
      return write("update", kind, externalId, operationId, () => {
        const item = held(kind, externalId)
        const at = patch.stage === undefined ? {} : placed(kind, patch.pipeline ?? item.pipeline, patch.stage)
        return saved(kind, applied(item, { ...patch, ...at }))
      })
    },
    async move(kind, externalId, stage, { operationId }) {
      return write("move", kind, externalId, operationId, () => {
        const item = held(kind, externalId)
        return saved(kind, { ...item, stage: placed(kind, item.pipeline, stage).stage, status: null, updatedAt: null })
      })
    },
    async close(kind, externalId, outcome, { operationId, reason }) {
      return write("close", kind, externalId, operationId, () => {
        const item = held(kind, externalId)
        const pipeline = pipelines[kind].find((one) => one.externalId === item.pipeline)
        const closing = pipeline?.stages.find((one) => one.outcome === outcome)
        return saved(kind, {
          ...item,
          ...(closing ? { stage: closing.externalId } : {}),
          status: outcome,
          closedReason: reason ?? null,
          updatedAt: null,
        })
      })
    },
    async remove(kind, externalId, { operationId }) {
      write("remove", kind, externalId, operationId, () => {
        held(kind, externalId)
        fake.delete(kind, externalId)
        return undefined
      })
    },
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
    setFields(kind, list) {
      fields[kind] = list
    },
    async fields(kind) {
      calls.fields += 1
      return fields[kind]
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
  return fake
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
