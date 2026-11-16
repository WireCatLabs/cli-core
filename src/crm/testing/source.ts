import { CliError } from "@wirecat/cli-base"
import type {
  CrmActivity,
  CrmField,
  CrmItem,
  CrmKind,
  CrmOrganization,
  CrmPerson,
  CrmPipeline,
  CrmRecords,
  CrmStageEntry,
  CrmValue,
} from "../../domain/crm.js"
import type { DealKind } from "../../domain/deals.js"
import { foldName } from "../../resolve.js"
import { crmFileId } from "../files.js"
import type {
  CrmChanges,
  CrmCondition,
  CrmFileOwner,
  CrmFileSourceKind,
  CrmIdPage,
  CrmLiveKind,
  CrmLiveQuery,
  CrmOpenableFile,
  CrmSource,
  CrmSourceTraits,
} from "../source.js"
import { crmWindowOf, walk } from "../walk.js"
import {
  CRM_VERBS,
  type CrmDraft,
  type CrmFields,
  type CrmPersonFields,
  type CrmVerb,
  type CrmWriteCapabilities,
  type CrmWriter,
} from "../writer.js"

export interface FakeCrmSourceOptions {
  traits?: Partial<CrmSourceTraits>
  /** Rows per page of `changes()` and `ids()`; 2 when absent, so every list has several pages. */
  pageSize?: number
  /** What the write side takes: every verb on every kind, not idempotent, when absent. */
  capabilities?: Partial<CrmWriteCapabilities>
  /** The sign-in's own user, as `self()` answers it; absent, the fake names none and is copied whole. */
  self?: string
  /** Gives the fake `isAdmin()`, so the daily limit on foreign contacts applies unless it answers true. */
  admin?: boolean
  /** The contacts and companies `ownClients()` counts as the sign-in's own; with it, the fake has `ownClients`. */
  ownClients?: Partial<Record<CrmLiveKind, readonly string[]>>
  /** Gives the fake `stageHistory()` over these entries, the array read on each call so a test may add to it. */
  stageHistory?: CrmStageEntry[]
  /** Gives the fake `activities()` over these, the array read on each call, by `updatedAt` after `since`. */
  activities?: CrmActivity[]
  /**
   * Gives the fake `files()` over these, the array read on each call. Each listed file also carries a `url` with
   * `FAKE_FILE_TOKEN`, as a careless adapter's might, so a test sees whether the token gets out.
   */
  files?: FakeCrmFile[]
}

/** The token in every fake file link: it must reach no output, store, file or error. */
export const FAKE_FILE_TOKEN = "fake-file-token-5f2a9c"

/** A file of one of the fake's records. */
export interface FakeCrmFile {
  owner: CrmFileOwner
  /** `record` when absent. */
  source?: CrmFileSourceKind
  /** The CRM's own id of the file. */
  id: string
  name: string
  bytes: string | Uint8Array
  mime?: string | null
  /** Epoch ms. */
  created?: number | null
  /** What the CRM says the size is; the bytes' length when absent, unknown when null. */
  size?: number | null
  /** `open` fails with an error that names the tokened link, as a raw fetch error would. */
  broken?: boolean
  /** `open` answers an HTML page, as a CRM does for a link that is not a server link. */
  html?: boolean
  /** The link answers from this host instead of the account's own. */
  host?: string
}

/** One write the fake CRM was sent, in order. */
export interface FakeCrmWrite {
  verb: CrmVerb
  kind: CrmKind
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
  /** The next write is carried out and its item cannot be read back: it throws with `sent: true`. */
  failNextReadBack(): void
  /** Requests made, by method. */
  readonly calls: {
    pipelines: number
    fields: number
    changes: number
    ids: number
    list: number
    get: number
    files: number
    open: number
  }
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
  const calls = { pipelines: 0, fields: 0, changes: 0, ids: 0, list: 0, get: 0, files: 0, open: 0 }
  const capabilities: CrmWriteCapabilities = {
    kinds: ["deal", "lead", "person", "organization"],
    verbs: CRM_VERBS,
    idempotent: false,
    ...options.capabilities,
  }
  const writes: FakeCrmWrite[] = []
  const answered = new Map<string, unknown>()
  let made = 0
  let lose = false
  let unread = false
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
  /** A custom value as a CRM answers it: by code, with the field's label and a list option's label. */
  const customValue = (kind: CrmKind, code: string, value: string | string[]) => {
    const field = fields[kind].find((one) => one.code === code)
    const label = (id: string) => field?.options?.find((option) => option.id === id)?.label ?? id
    if (!field?.options) return { label: field?.label ?? null, value }
    return {
      label: field.label,
      value: Array.isArray(value) ? value.map(label) : label(value),
      option_id: value,
    }
  }
  const applied = (kind: DealKind, item: CrmItem, given: CrmFields): CrmItem => {
    const { custom, owner, pipeline, stage, ...named } = given
    const metadata: Record<string, unknown> = { ...item.metadata }
    for (const [code, value] of Object.entries(custom ?? {}))
      if (value === null) delete metadata[code]
      else metadata[code] = customValue(kind, code, value)
    return {
      ...item,
      ...Object.fromEntries(Object.entries(named).filter(([, value]) => value !== undefined)),
      ...(pipeline === undefined ? {} : { pipeline }),
      ...(stage === undefined ? {} : { stage }),
      ...(owner === undefined ? {} : { assignee: owner }),
      metadata,
      updatedAt: null,
    }
  }
  const refuseAliases = (fields: Pick<CrmFields, "custom">) => {
    const refused = Object.keys(fields.custom ?? {}).find((code) => FAKE_CRM_ALIASES.includes(code))
    if (refused) throw new CliError("validation_error", `${refused} is not a custom field`)
  }
  /** Each write once: a repeated idempotent id answers its first outcome; a lost answer still made the change. */
  const write = <T>(verb: CrmVerb, kind: CrmKind, externalId: string | null, operationId: string, act: () => T): T => {
    writes.push({ verb, kind, externalId, operationId })
    if (capabilities.idempotent && answered.has(operationId)) return answered.get(operationId) as T
    const done = act()
    if (capabilities.idempotent) answered.set(operationId, done)
    if (lose) {
      lose = false
      throw new CliError("outcome_unknown", "the CRM did not answer")
    }
    if (unread) {
      unread = false
      throw new CliError("provider_error", `the CRM made the ${verb} but its ${kind} could not be read back`, {
        sent: true,
      })
    }
    return done
  }
  const saved = (kind: DealKind, item: CrmItem) => {
    fake.put(kind, item)
    return held(kind, item.externalId)
  }
  const liveRecord = (kind: CrmLiveKind, externalId: string) => {
    const found = of(kind).get(externalId)
    if (!found || found.deleted) throw new CliError("not_found", `the CRM has no ${kind} ${externalId}`)
    return found.record as CrmPerson & CrmOrganization
  }
  /** A contact's or company's fields onto its record, as the CRM answers it whole. */
  const recordApplied = (kind: CrmLiveKind, record: CrmPerson | CrmOrganization, given: CrmPersonFields) => {
    const { custom, owner, emails, phones, name, firstName, lastName, position } = given
    const metadata: Record<string, CrmValue> = { ...(record as CrmPerson).metadata }
    for (const [code, value] of Object.entries(custom ?? {}))
      if (value === null) delete metadata[code]
      else metadata[code] = customValue(kind, code, value) as CrmValue
    const parts = { ...(firstName === undefined ? {} : { firstName }), ...(lastName === undefined ? {} : { lastName }) }
    const next = { ...(record as CrmPerson), ...parts } as CrmPerson & CrmOrganization
    const whole = [next.firstName, next.lastName].filter(Boolean).join(" ") || null
    return {
      ...next,
      ...(name !== undefined ? { name } : firstName !== undefined || lastName !== undefined ? { name: whole } : {}),
      ...(position === undefined ? {} : { position }),
      ...(emails === undefined ? {} : { emails, email: emails[0] ?? null }),
      ...(phones === undefined ? {} : { phones, phone: phones[0] ?? null }),
      ...(owner === undefined ? {} : { assignee: owner }),
      metadata,
      updatedAt: STAMPED_FROM + (version + 1) * 1000,
    }
  }
  const putLive = (kind: CrmLiveKind, record: CrmPerson | CrmOrganization) => {
    fake.put(kind, record)
    return liveRecord(kind, record.externalId)
  }
  /** Strict: a condition the shared commands never send fails the test instead of matching everything. */
  const holds = (kind: CrmLiveKind, record: CrmPerson & CrmOrganization, { field, op, value }: CrmCondition) => {
    const metadataValue = record.metadata?.[field] as CrmValue | undefined
    const had =
      field === "assigned_to"
        ? record.assignee
        : field === "type"
          ? record.type
          : field === "created_at"
            ? record.createdAt
            : field === "updated_at"
              ? record.updatedAt
              : metadataValue
                ? (metadataValue.option_id ?? metadataValue.value)
                : fields[kind].some((one) => one.code === field)
                  ? undefined
                  : unknownCondition(field)
    if (op === "=") return Array.isArray(had) ? had.map(String).includes(String(value)) : String(had) === String(value)
    if (typeof had !== "number" || typeof value !== "number") return false
    return op === ">=" ? had >= value : op === "<=" ? had <= value : op === ">" ? had > value : had < value
  }
  const unknownCondition = (field: string): never => {
    throw new CliError("validation_error", `the fake CRM cannot filter by ${field}`, {
      reason: "query.unsupported-field",
    })
  }
  const fake: FakeCrmSource = {
    provider: "example-crm",
    traits,
    ...(options.self === undefined ? {} : { self: () => options.self as string }),
    calls,
    capabilities,
    writes,
    loseNextAnswer() {
      lose = true
    },
    failNextReadBack() {
      unread = true
    },
    async create(kind, draft, { operationId }) {
      refuseAliases(draft)
      const answer = write("create", kind, null, operationId, () => {
        made += 1
        const externalId = `${kind}-new-${made}`
        if (kind === "person" || kind === "organization") {
          const blank = { externalId, name: null, createdAt: STAMPED_FROM + (version + 1) * 1000 }
          return putLive(kind, recordApplied(kind, blank as CrmPerson, draft as CrmPersonFields))
        }
        const deal = draft as CrmDraft
        const { pipeline, stage } = placed(kind, deal.pipeline, deal.stage)
        const blank: CrmItem = { externalId, title: deal.title, pipeline, stage }
        return saved(kind, applied(kind, blank, { ...deal, pipeline, stage }))
      })
      return answer as never
    },
    async update(kind, externalId, patch, { operationId }) {
      refuseAliases(patch)
      const answer = write("update", kind, externalId, operationId, () => {
        if (kind === "person" || kind === "organization")
          return putLive(kind, recordApplied(kind, liveRecord(kind, externalId), patch as CrmPersonFields))
        const fields = patch as CrmFields
        const item = held(kind, externalId)
        const at = fields.stage === undefined ? {} : placed(kind, fields.pipeline ?? item.pipeline, fields.stage)
        return saved(kind, applied(kind, item, { ...fields, ...at }))
      })
      return answer as never
    },
    ...(options.admin === undefined ? {} : { isAdmin: async () => options.admin as boolean }),
    ...(options.stageHistory === undefined
      ? {}
      : {
          stageHistory: async (kind: DealKind, since: number, after?: string) => {
            const all = options.stageHistory as CrmStageEntry[]
            const from = after === undefined ? -1 : all.findIndex((one) => one.externalId === after)
            const items = all.filter(
              (one, at) => one.kind === kind && at > from && (after !== undefined || one.at >= since),
            )
            return { items, hasMore: false, cursor: items.at(-1)?.externalId ?? after ?? null }
          },
        }),
    ...(options.activities === undefined
      ? {}
      : {
          activities: async (since: number) => {
            const items = (options.activities as CrmActivity[]).filter((one) => one.updatedAt > since)
            const newest = Math.max(since, ...items.map((one) => one.updatedAt))
            return { items, hasMore: false, cursor: String(newest) }
          },
        }),
    ...(options.files === undefined
      ? {}
      : {
          files: async (owner: CrmFileOwner) => {
            calls.files += 1
            const record = of(owner.kind).get(owner.id)
            if (!record || record.deleted) return null
            const listed = (options.files as FakeCrmFile[]).filter(
              (one) => one.owner.kind === owner.kind && one.owner.id === owner.id,
            )
            return {
              assignee: (record.record as { assignee?: string | null }).assignee ?? null,
              files: listed.map((one) => fakeFile(one, () => (calls.open += 1))),
            }
          },
        }),
    ...(options.ownClients === undefined
      ? {}
      : {
          ownClients: async (kind: CrmLiveKind, ids: readonly string[]) =>
            new Set(ids.filter((id) => options.ownClients?.[kind]?.includes(id))),
        }),
    async list(kind, query: CrmLiveQuery) {
      calls.list += 1
      const want = query.text ? foldName(query.text) : undefined
      const found = [...of(kind).values()]
        .filter((one) => !one.deleted)
        .sort((a, b) => b.version - a.version)
        .map((one) => one.record as CrmPerson & CrmOrganization)
        .filter((one) => want === undefined || foldName(one.name ?? "").includes(want))
        .filter((one) => query.conditions.every((condition) => holds(kind, one, condition)))
      // Pages of `size` rows, so a page the command asks for is read over several of the fake's own.
      return walk(crmWindowOf(query), size, async (offset, count) => ({
        rows: found.slice(offset, offset + count),
        more: offset + count < found.length,
      })) as never
    },
    async get(kind, externalId) {
      calls.get += 1
      const found = of(kind).get(externalId)
      return (found && !found.deleted ? found.record : null) as never
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
        ...(nextPage === undefined
          ? { hasMore: false, cursor: String(version) }
          : { hasMore: true, nextCursor: nextPage }),
      }
    },
    async ids(kind, page): Promise<CrmIdPage> {
      calls.ids += 1
      const listed = hidden ? [] : [...of(kind).entries()].filter(([, held]) => !held.deleted).map(([id]) => id)
      const { slice, nextPage } = window(listed, page)
      return nextPage === undefined
        ? { items: slice, hasMore: false }
        : { items: slice, hasMore: true, nextCursor: nextPage }
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

const fakeFile = (file: FakeCrmFile, opened: () => void): CrmOpenableFile => {
  const bytes = typeof file.bytes === "string" ? new TextEncoder().encode(file.bytes) : file.bytes
  const link = `https://${file.host ?? "portal.example"}/download/${file.id}?token=${FAKE_FILE_TOKEN}`
  const listed = {
    id: crmFileId(file.owner, file.source ?? "record", file.id),
    name: file.name,
    size: file.size === undefined ? bytes.byteLength : file.size,
    mime: file.mime ?? null,
    created: file.created ?? null,
    owner: { ...file.owner },
    source: file.source ?? "record",
    url: link,
    async open() {
      opened()
      if (file.broken) throw new Error(`GET ${link} failed: socket hang up`)
      if (file.host && file.host !== "portal.example")
        throw new CliError("provider_error", `the file link points to another host than the account's: ${link}`)
      if (file.html) throw new CliError("provider_error", `the CRM answered a web page, not the file: ${link}`)
      return new ReadableStream<Uint8Array>({
        start(controller) {
          // Two chunks, so a cap is checked between them.
          const half = Math.ceil(bytes.byteLength / 2)
          controller.enqueue(bytes.slice(0, half))
          if (half < bytes.byteLength) controller.enqueue(bytes.slice(half))
          controller.close()
        },
      })
    },
  }
  return listed as CrmOpenableFile
}
