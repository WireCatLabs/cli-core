import { CliError } from "@wirecat/cli-base"
import * as v from "valibot"
import type { ServiceApiCall } from "../../cli/service-api-call.js"
import type { ServiceApiManifest } from "../../cli/service-api-manifest.js"
import { CRM_KINDS, type CrmKind, type CrmRecords } from "../../domain/crm.js"
import { DEAL_KINDS, type DealKind, STAGE_OUTCOMES, type StageOutcome } from "../../domain/deals.js"
import { editDistance } from "../../search/correct.js"
import type { CrmSource } from "../source.js"
import { type CrmRaw, isRaw } from "../values.js"
import type { CrmWriteFields } from "../writer.js"
import { FIELDS } from "./map.js"

/**
 * Where one of our fields comes from in a row the service answered. A path is dotted (`properties.firstname`); the
 * engine converts the value by the field it fills (an id to a string, a time to epoch ms, a day to `YYYY-MM-DD`).
 */
export type CrmRule =
  | string
  | { first: readonly string[] }
  | { join: readonly string[] }
  | { all: readonly string[]; split?: string }
  | { path: string; split?: string }
  | { path: string; map: Readonly<Record<string, unknown>> }
  | { each: string; id: string; primary?: string }
  | { each: string; value: string }
  | { value: unknown }
  | ((raw: CrmRaw) => unknown)

/**
 * One request to the service: an operation of the generated API manifest by its id, with fixed parameters. A string
 * value `"{since}"`, `"{select}"` or `"{id}"` anywhere in `path`, `query` or `body` is filled in by the engine; an empty
 * `"{select}"` leaves the parameter out.
 */
export interface CrmOperationCall {
  operation: string
  path?: Readonly<Record<string, string>>
  query?: Readonly<Record<string, string | number | boolean>>
  body?: unknown
  /** Where the answer's rows are when the operation has no `pagination`; absent, the answer itself is the list. */
  items?: string
}

export interface CrmChangesCall extends CrmOperationCall {
  /** How `{since}` is written: epoch ms or seconds as digits, ISO, or `YYYY-MM-DD HH:MM:SS` in UTC. */
  since: "ms" | "seconds" | "iso" | "datetime"
  /**
   * The answer is sorted by `field`, a time, ascending: pages go on from the last row's time, so a row that changes
   * mid-round moves nothing under the next page. Past `cap` rows at one time the round answers `reset`.
   */
  keyset?: { field: string; cap?: number }
}

export interface CrmManifestEntity<K extends CrmKind = CrmKind> {
  /** Every row of the kind, page by page by the operation's own `pagination`. */
  list: CrmOperationCall
  /** Rows changed since `{since}`, the last cursor less the overlap; absent, every sync lists in full. */
  changes?: CrmChangesCall
  /** Every id, to find deletions; absent, `list` with an empty `{select}`. */
  ids?: CrmOperationCall
  /** One row by `{id}`, for a live read of a contact or company; a 403 or 404 is no row. */
  get?: CrmOperationCall
  /**
   * Contacts or companies whose name holds `{query}`, for a live `people list` and `organizations list`; a list with no
   * words reads `list`. Both page by the operation's own `pagination`. Absent, the source has no live list.
   */
  search?: CrmOperationCall
  /**
   * The service names the fields a read returns (HubSpot `properties=`, Bitrix24 `select`): `{select}` becomes the
   * names under `from` that `map` reads, the custom field codes, and `also`.
   */
  select?: {
    from: string
    also?: readonly string[]
    /** The longest `{select}` the service takes, in characters joined by commas; the rest is a gap. */
    max?: number
  }
  map: { readonly [F in keyof CrmRecords[K]]?: CrmRule } & { amount?: CrmRule; currency?: CrmRule }
  /** The account's own fields' values, by the codes `fields` lists, under this object of the row. */
  custom?: { from: string; split?: string; typed?: CrmTypedValues }
  /**
   * A kind the plan or the sign-in may not have (HubSpot's leads, Attio's Deals object when it is off): the service
   * refusing it, or answering that it is not there, is a gap with this text and scope, and the other kinds still sync.
   */
  optional?: { message: string; scope?: string }
  /**
   * Contacts or companies: the sync copies only the ones a deal names, each read by `get`, as Bitrix24's does; the
   * rest stay in the service and are read live. For a service whose own contacts and companies grow from mail
   * (Attio), where a full copy would hold thousands nobody sells to.
   */
  linked?: true
}

/**
 * Values kept as a list of typed entries, each naming its type (Attio's `values.<slug>`): the entry's type picks where
 * its value is, and a replaced entry, one with a time at `current`, is skipped.
 */
export interface CrmTypedValues {
  /** Where an entry names its type: `attribute_type`. */
  by: string
  /** A time an entry was replaced at; an entry with one is history, not the value. */
  current?: string
  /** Where the value is for each type, over `TYPED_VALUE_PATHS`. */
  paths?: Readonly<Record<string, string>>
}

export interface CrmManifestPipelines {
  call: CrmOperationCall
  /** Read from the pipeline's row, or from its first stage when the call answers stages (`stages.each` is `.`). */
  map: { externalId: CrmRule; name: CrmRule }
  stages: {
    /** The stages in a pipeline's row; `.` when the call answers the stages themselves, one row each. */
    each: string
    /** With `each` `.`: the stage's pipeline, by which the stages are grouped; absent, they are all one pipeline. */
    pipeline?: string
    map: { externalId: CrmRule; name: CrmRule; position?: CrmRule }
    /** Which stages are won or lost by one field; any other is open. A rule a field cannot say is a function. */
    outcome:
      | { path: string; won?: readonly string[]; lost?: readonly string[] }
      | { value: StageOutcome }
      | ((stage: CrmRaw, pipeline: CrmRaw) => StageOutcome)
  }
}

export interface CrmManifestFields {
  call: CrmOperationCall
  map: {
    code: CrmRule
    label?: CrmRule
    type?: CrmRule
    multiple?: CrmRule
    filterable?: CrmRule
    options?:
      | { each: string; id: string; label: string }
      | ((raw: CrmRaw) => { id: string; label: string }[] | undefined)
  }
  /** Which listed fields are the account's own, not the service's built-in ones the map already reads. */
  keep?: { path: string; is: unknown } | ((raw: CrmRaw) => boolean)
}

/**
 * How one of our fields is written under the call's `"{values}"`: at `to`, in the shape `each` gives one value, where
 * `"{value}"` stands for ours. Rules that share a `to` merge into one entry, as Attio's personal name takes the first
 * and last name together.
 */
export interface CrmWriteRule {
  to: string
  /** Absent, the value itself. */
  each?: unknown
  /** The service takes a list even for one value (Attio); without it, a list of more than one is refused. */
  list?: true
  /** A decimal string goes as a number: an amount. */
  number?: true
  /** The most decimal places the service keeps; more is refused (Attio's currency takes 4). */
  decimals?: number
}

/** A value the service keeps elsewhere (Attio's currency is the attribute's): read once, and another one is refused. */
export interface CrmFixedValue {
  fixed: CrmOperationCall
  /** Where the value is in the answer. */
  at: string
}

/** The fields a write of each kind may name, as `CrmWriteFields` has them; `custom` has its own rule. */
export const CRM_WRITE_FIELDS: { readonly [K in CrmKind]: readonly string[] } = {
  deal: ["title", "pipeline", "stage", "amount", "currency", "closeDate", "organization", "people", "owner", "reason"],
  lead: ["title", "pipeline", "stage", "amount", "currency", "closeDate", "organization", "people", "owner", "reason"],
  person: ["name", "firstName", "lastName", "position", "emails", "phones", "owner"],
  organization: ["name", "emails", "phones", "owner"],
}

/** The fields that take a list: each value goes through `each`. */
export const CRM_LIST_FIELDS: readonly string[] = ["emails", "phones", "people"]

/**
 * Writes of one kind. A field with no rule is refused before anything is sent. The item is read back by the
 * entity's `get` after each write, so the store keeps what the service holds.
 */
export interface CrmManifestWrite<K extends CrmKind = CrmKind> {
  /** Its body holds `"{values}"` where the object of values goes. */
  create?: CrmOperationCall
  /** `"{id}"` in its path, `"{values}"` in its body. Only the fields given are sent. */
  update?: CrmOperationCall
  /** `"{id}"` in its path; a deal or lead only. */
  remove?: CrmOperationCall
  /** Where the new record's id is in the create's answer: `data.id.record_id`. */
  id?: string
  /**
   * Our fields by the names `CrmWriteFields` gives them, and `reason` for a close's reason. `implied`: the field is
   * not sent, as Attio's one pipeline follows from the stage. `currency` may be a fixed value.
   */
  fields: {
    readonly [F in Exclude<keyof CrmWriteFields[K], "custom" | "currency"> | "reason"]?: CrmWriteRule | "implied"
  } & { readonly currency?: CrmWriteRule | CrmFixedValue }
  /** The account's own fields, each written at its code; absent, `--field` is refused. */
  custom?: Omit<CrmWriteRule, "to">
  /** What clears a field: Attio `[]`, HubSpot `""`. Default `null`. */
  clear?: unknown
}

/** A CRM account described as data: what to call for each kind and where each of our fields is in the answer. */
export interface CrmManifest {
  /** The registry name: `hubspot`, `pipedrive`. */
  provider: string
  /** Contacts and companies before the items on them. */
  kinds: readonly CrmKind[]
  /** Re-read before the last cursor: rows saved while the round ran, and a clock running ahead. Default 10 min. */
  overlapMs?: number
  entities: { readonly [K in CrmKind]?: CrmManifestEntity<K> }
  pipelines?: { readonly [K in DealKind]?: CrmManifestPipelines }
  fields?: { readonly [K in CrmKind]?: CrmManifestFields }
  users?: {
    call: CrmOperationCall
    map: { externalId: CrmRule; name?: CrmRule; email?: CrmRule; position?: CrmRule; active?: CrmRule }
  }
  writes?: { readonly [K in CrmKind]?: CrmManifestWrite<K> }
}

/** Corrects one record after the map; `call` reads more from the service, spent from the run's budget. */
export type CrmAfterHook<K extends CrmKind> = (
  record: CrmRecords[K],
  raw: CrmRaw,
  service: { call: ServiceApiCall },
) => CrmRecords[K] | Promise<CrmRecords[K]>

/** Code a service needs beyond what the manifest says. */
export interface CrmManifestHooks {
  /** Corrects one record after the map, such as a default the account keeps elsewhere. */
  after?: { readonly [K in CrmKind]?: CrmAfterHook<K> }
  /**
   * Reads more for a whole page before the map, in one batch request: what an answer leaves out and another operation
   * gives (HubSpot's associations, which a search does not answer).
   */
  enrich?: {
    readonly [K in CrmKind]?: (rows: CrmRaw[], service: { call: ServiceApiCall }) => Promise<CrmRaw[]>
  }
  /** The outcome of a stage the data cannot say (Attio names a lost stage only by its title); `found` is the data's. */
  pipelines?: {
    readonly [K in DealKind]?: {
      outcome?: (stage: CrmRaw, pipeline: CrmRaw, found: StageOutcome) => StageOutcome
    }
  }
  /** Adds or replaces source methods (`self`, `activities`, a live `list`); `base` is what the manifest built. */
  extend?: (base: CrmSource, service: { call: ServiceApiCall }) => Partial<CrmSource>
}

const path = v.pipe(v.string(), v.regex(/^[^.\s]+(\.[^.\s]+)*$/, "a dotted path such as properties.name"))
const paths = v.pipe(v.array(path), v.minLength(1))

export const crmRuleSchema: v.GenericSchema<CrmRule> = v.union(
  [
    path,
    v.strictObject({ first: paths }),
    v.strictObject({ join: paths }),
    v.strictObject({ all: paths, split: v.optional(v.string()) }),
    v.strictObject({ path, split: v.optional(v.string()) }),
    v.strictObject({ path, map: v.record(v.string(), v.unknown()) }),
    v.strictObject({ each: path, id: path, primary: v.optional(path) }),
    v.strictObject({ each: path, value: path }),
    v.strictObject({ value: v.unknown() }),
    v.function(),
  ],
  "a path, one of first, join, all, path, each, value, or a function",
) as v.GenericSchema<CrmRule>

const rule = crmRuleSchema

const call = v.strictObject({
  operation: v.pipe(v.string(), v.minLength(1)),
  path: v.optional(v.record(v.string(), v.string())),
  query: v.optional(v.record(v.string(), v.union([v.string(), v.number(), v.boolean()]))),
  body: v.optional(v.unknown()),
  items: v.optional(path),
})

const entity = v.strictObject({
  list: call,
  changes: v.optional(
    v.strictObject({
      ...call.entries,
      since: v.picklist(["ms", "seconds", "iso", "datetime"]),
      keyset: v.optional(
        v.strictObject({ field: path, cap: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))) }),
      ),
    }),
  ),
  ids: v.optional(call),
  get: v.optional(call),
  search: v.optional(call),
  select: v.optional(
    v.strictObject({
      from: path,
      also: v.optional(v.array(v.string())),
      max: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
    }),
  ),
  map: v.record(v.string(), rule),
  custom: v.optional(
    v.strictObject({
      from: path,
      split: v.optional(v.string()),
      typed: v.optional(
        v.strictObject({ by: path, current: v.optional(path), paths: v.optional(v.record(v.string(), path)) }),
      ),
    }),
  ),
  optional: v.optional(v.strictObject({ message: v.pipe(v.string(), v.minLength(1)), scope: v.optional(v.string()) })),
  linked: v.optional(v.literal(true)),
})

const pipelines = v.strictObject({
  call,
  map: v.strictObject({ externalId: rule, name: rule }),
  stages: v.strictObject({
    each: v.union([v.literal("."), path]),
    pipeline: v.optional(path),
    map: v.strictObject({ externalId: rule, name: rule, position: v.optional(rule) }),
    outcome: v.union([
      v.strictObject({ path, won: v.optional(v.array(v.string())), lost: v.optional(v.array(v.string())) }),
      v.strictObject({ value: v.picklist(STAGE_OUTCOMES) }),
      v.function(),
    ]),
  }),
})

const fields = v.strictObject({
  call,
  map: v.strictObject({
    code: rule,
    label: v.optional(rule),
    type: v.optional(rule),
    multiple: v.optional(rule),
    filterable: v.optional(rule),
    options: v.optional(v.union([v.strictObject({ each: path, id: path, label: path }), v.function()])),
  }),
  keep: v.optional(v.union([v.strictObject({ path, is: v.unknown() }), v.function()])),
})

const kind = v.picklist(CRM_KINDS)

const writeShape = {
  each: v.optional(v.unknown()),
  list: v.optional(v.literal(true)),
  number: v.optional(v.literal(true)),
  decimals: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
}
const writeRule = v.strictObject({ to: v.pipe(v.string(), v.minLength(1)), ...writeShape })

const write = v.strictObject({
  create: v.optional(call),
  update: v.optional(call),
  remove: v.optional(call),
  id: v.optional(path),
  fields: v.record(v.string(), v.union([writeRule, v.literal("implied"), v.strictObject({ fixed: call, at: path })])),
  custom: v.optional(v.strictObject(writeShape)),
  clear: v.optional(v.unknown()),
})

const schema = v.strictObject({
  provider: v.pipe(v.string(), v.regex(/^[a-z][a-z0-9-]*$/, "a registry name such as hubspot")),
  kinds: v.pipe(v.array(kind), v.minLength(1)),
  overlapMs: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
  entities: v.record(kind, v.optional(entity)),
  pipelines: v.optional(v.record(v.picklist(DEAL_KINDS), v.optional(pipelines))),
  fields: v.optional(v.record(kind, v.optional(fields))),
  users: v.optional(
    v.strictObject({
      call,
      map: v.strictObject({
        externalId: rule,
        name: v.optional(rule),
        email: v.optional(rule),
        position: v.optional(rule),
        active: v.optional(rule),
      }),
    }),
  ),
  writes: v.optional(v.record(kind, v.optional(write))),
})

const invalid = (where: string, message: string) =>
  new CliError("configuration_error", `source manifest: ${where}: ${message}`, { reason: "manifest.invalid" })

/** The known name a typo most likely meant: at most two edits away, else none. */
const nearest = (wanted: string, known: readonly string[]) =>
  known
    .map((one) => ({ one, edits: editDistance(wanted, one, 2) }))
    .filter(({ edits }) => edits <= 2)
    .sort((a, b) => a.edits - b.edits)[0]?.one

const hasPlaceholder = (value: unknown, placeholder: string): boolean =>
  value === placeholder ||
  (Array.isArray(value) && value.some((one) => hasPlaceholder(one, placeholder))) ||
  (typeof value === "object" && value !== null && Object.values(value).some((one) => hasPlaceholder(one, placeholder)))

/**
 * The manifest checked against its shape and the generated API: each operation exists, a list pages or says where its
 * rows are, a change call places `{since}`, a deal or lead kind has pipelines. Every error names where it is.
 */
export const parseCrmManifest = (input: unknown, api: ServiceApiManifest): CrmManifest => {
  const parsed = v.safeParse(schema, input)
  if (!parsed.success) {
    const [issue] = parsed.issues
    throw invalid(v.getDotPath(issue) ?? "(root)", issue.message)
  }
  const manifest = parsed.output as CrmManifest
  const operations = new Map(api.operations.map((one) => [one.id, one]))
  const known = [...operations.keys()]
  const checkCall = (where: string, one: CrmOperationCall, pages: boolean) => {
    const operation = operations.get(one.operation)
    if (!operation) {
      const near = nearest(one.operation, known)
      throw invalid(
        `${where}.operation`,
        `no operation ${one.operation} in the API${near ? `; did you mean ${near}?` : ""}`,
      )
    }
    if (operation.effect !== "read")
      throw invalid(`${where}.operation`, `${one.operation} is a ${operation.effect}, and a source only reads`)
    if (pages && operation.pagination?.style === "link")
      throw invalid(`${where}.operation`, `${one.operation} pages by a link, which a source does not read yet`)
  }
  for (const kind of manifest.kinds) {
    const one = manifest.entities[kind]
    if (!one) throw invalid(`entities.${kind}`, `${kind} is in kinds but has no entity`)
    checkCall(`entities.${kind}.list`, one.list, true)
    if (one.changes) {
      checkCall(`entities.${kind}.changes`, one.changes, true)
      if (!hasPlaceholder([one.changes.path, one.changes.query, one.changes.body], "{since}"))
        throw invalid(`entities.${kind}.changes`, 'no "{since}" in its path, query or body')
    }
    if (one.ids) checkCall(`entities.${kind}.ids`, one.ids, true)
    if (one.get) {
      checkCall(`entities.${kind}.get`, one.get, false)
      if (!hasPlaceholder([one.get.path, one.get.query, one.get.body], "{id}"))
        throw invalid(`entities.${kind}.get`, 'no "{id}" in its path, query or body')
    }
    if (one.search) {
      if (kind !== "person" && kind !== "organization")
        throw invalid(`entities.${kind}.search`, "only contacts and companies are read live")
      checkCall(`entities.${kind}.search`, one.search, true)
      for (const [name, live] of [
        ["search", one.search],
        ["list", one.list],
      ] as const) {
        const style = operations.get(live.operation)?.pagination?.style
        if (style !== undefined && style !== "offset")
          throw invalid(`entities.${kind}.${name}`, `a live list pages by offset or not at all, not by ${style}`)
      }
      if (!hasPlaceholder([one.search.path, one.search.query, one.search.body], "{query}"))
        throw invalid(`entities.${kind}.search`, 'no "{query}" in its path, query or body')
    }
    if (one.linked) {
      if (kind !== "person" && kind !== "organization")
        throw invalid(`entities.${kind}.linked`, "only contacts and companies are copied as a deal names them")
      if (!one.get) throw invalid(`entities.${kind}.linked`, "each one is read by its get, and this kind has none")
      const link = kind === "person" ? "people" : "organization"
      if (!manifest.kinds.includes("deal") || manifest.entities.deal?.map[link] === undefined)
        throw invalid(`entities.${kind}.linked`, `no deal entity maps ${link}`)
    }
    if (one.map.externalId === undefined) throw invalid(`entities.${kind}.map.externalId`, "every kind maps its id")
    const fields = [...Object.keys(FIELDS[kind]), "amount", "currency"]
    for (const field of Object.keys(one.map))
      if (!fields.includes(field)) {
        const near = nearest(field, fields)
        throw invalid(
          `entities.${kind}.map.${field}`,
          `${kind} has no such field${near ? `; did you mean ${near}?` : ""}`,
        )
      }
  }
  for (const kind of DEAL_KINDS.filter((one) => manifest.kinds.includes(one))) {
    const one = manifest.pipelines?.[kind]
    if (!one) throw invalid(`pipelines.${kind}`, `${kind} is in kinds, and every deal or lead stands in a pipeline`)
    checkCall(`pipelines.${kind}.call`, one.call, true)
    if (one.stages.pipeline !== undefined && one.stages.each !== ".")
      throw invalid(`pipelines.${kind}.stages.pipeline`, 'groups stages only when the call answers them: each "."')
  }
  for (const [kind, one] of Object.entries(manifest.fields ?? {}))
    if (one) checkCall(`fields.${kind}.call`, one.call, true)
  if (manifest.users) checkCall("users.call", manifest.users.call, true)
  for (const [kind, one] of Object.entries(manifest.writes ?? {}) as [CrmKind, CrmManifestWrite][])
    if (one) checkWrite(kind, one, manifest, { operations, known, checkCall })
  return manifest
}

const checkWrite = (
  kind: CrmKind,
  one: CrmManifestWrite,
  manifest: CrmManifest,
  {
    operations,
    known,
    checkCall,
  }: {
    operations: ReadonlyMap<string, ServiceApiManifest["operations"][number]>
    known: readonly string[]
    checkCall: (where: string, one: CrmOperationCall, pages: boolean) => void
  },
) => {
  const where = `writes.${kind}`
  if (!manifest.kinds.includes(kind)) throw invalid(where, `${kind} is not in kinds`)
  if (!manifest.entities[kind]?.get)
    throw invalid(where, `each write is read back by entities.${kind}.get, and it has none`)
  if (!one.create && !one.update && !one.remove) throw invalid(where, "names no create, update or remove")
  if (one.remove && !(DEAL_KINDS as readonly string[]).includes(kind))
    throw invalid(`${where}.remove`, "only a deal or a lead is removed")
  if (one.create && one.id === undefined) throw invalid(`${where}.id`, "a create says where the new record's id is")
  for (const verb of ["create", "update", "remove"] as const) {
    const sent = one[verb]
    if (!sent) continue
    const operation = operations.get(sent.operation)
    if (!operation) {
      const near = nearest(sent.operation, known)
      throw invalid(
        `${where}.${verb}.operation`,
        `no operation ${sent.operation} in the API${near ? `; did you mean ${near}?` : ""}`,
      )
    }
    if (operation.effect === "read") throw invalid(`${where}.${verb}.operation`, `${sent.operation} is a read`)
    if (verb !== "create" && !hasPlaceholder([sent.path, sent.query, sent.body], "{id}"))
      throw invalid(`${where}.${verb}`, 'no "{id}" in its path, query or body')
    if (verb !== "remove" && !hasPlaceholder(sent.body, "{values}"))
      throw invalid(`${where}.${verb}`, 'no "{values}" in its body')
  }
  const fields = CRM_WRITE_FIELDS[kind]
  const shared = new Map<string, string[]>()
  for (const [field, rule] of Object.entries(one.fields) as [string, CrmWriteRule | "implied" | CrmFixedValue][]) {
    if (!fields.includes(field)) {
      const near = nearest(field, fields)
      throw invalid(
        `${where}.fields.${field}`,
        `a ${kind} writes no such field${near ? `; did you mean ${near}?` : ""}`,
      )
    }
    if (rule === "implied") {
      if (field !== "pipeline") throw invalid(`${where}.fields.${field}`, "only a pipeline follows from the stage")
      continue
    }
    if ("fixed" in rule) {
      if (field !== "currency") throw invalid(`${where}.fields.${field}`, "only a currency is a fixed value")
      checkCall(`${where}.fields.${field}.fixed`, rule.fixed, false)
      continue
    }
    if (rule.each !== undefined && !hasPlaceholder(rule.each, "{value}"))
      throw invalid(`${where}.fields.${field}.each`, 'no "{value}" in it')
    shared.set(rule.to, [...(shared.get(rule.to) ?? []), field])
  }
  for (const [to, named] of shared) {
    const rules = named.map((field) => (one.fields as Record<string, CrmWriteRule>)[field] as CrmWriteRule)
    if (named.length > 1 && !named.every((field, n) => !CRM_LIST_FIELDS.includes(field) && isRaw(rules[n]?.each)))
      throw invalid(`${where}.fields`, `${named.join(", ")} share ${to}: only single values in objects merge`)
  }
  if (one.custom?.each !== undefined && !hasPlaceholder(one.custom.each, "{value}"))
    throw invalid(`${where}.custom.each`, 'no "{value}" in it')
}
