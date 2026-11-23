import {
  type FakeAnswer,
  type FakeApi,
  type FakeCall,
  fakeApi,
  type Pagination,
  type SchemaNode,
  sampleOf,
} from "@wirecat/cli-base/codegen"
import { serviceApiCall, serviceApiSend } from "../../cli/service-api-call.js"
import { manifestBaseUrl, type ServiceApiManifest } from "../../cli/service-api-manifest.js"
import type { CrmKind } from "../../domain/crm.js"
import { DEAL_KINDS, type DealKind } from "../../domain/deals.js"
import type { ContractCase } from "../../meetings/index.js"
import {
  CRM_LIST_FIELDS,
  type CrmChangesCall,
  type CrmManifest,
  type CrmManifestHooks,
  type CrmManifestWrite,
  type CrmOperationCall,
  type CrmRule,
  parseCrmManifest,
} from "../manifest/manifest.js"
import { at, type Conversion, convert, evaluate, FIELDS, MISSING, mapRecord } from "../manifest/map.js"
import { itemOf, resolve, step, walk } from "../manifest/paths.js"
import { crmSourceFromManifest } from "../manifest/source.js"
import { crmWriterFromManifest } from "../manifest/writer.js"
import type { CrmSource } from "../source.js"
import { type CrmRaw, id, isRaw } from "../values.js"
import { type CrmSourceFixture, crmSourceContract } from "./source-contract.js"
import { type CrmWriteFixture, crmWriteContract } from "./write-contract.js"

type Definitions = Readonly<Record<string, SchemaNode>>

export interface CrmManifestFakeOptions {
  /** The generated API manifest the source manifest names its operations in. */
  api: ServiceApiManifest
  /** The generated schemas the operations answer by: each row is sampled from them. */
  definitions: Definitions
  /** In place of the API manifest's first server. */
  baseUrl?: string
}

export interface CrmManifestFake extends FakeApi {
  /** The rows of each kind, as the service holds them; a test may change them. */
  rows: Partial<Record<CrmKind, CrmRaw[]>>
  /** Makes one row answer `status` to a read by id from now on. */
  deny(kind: CrmKind, id: string, status: number): void
  /** Moves one row's change time to now, for the next read of changes to list it. */
  touch(kind: CrmKind, id: string): void
  /** Makes the next write's answer lost after the service made the change, as a dropped connection does. */
  loseNextAnswer(): void
  /** How many write requests reached the service so far. */
  requests(): number
}

export const FAKE_MANIFEST_TOKEN = "fake-manifest-token"

/** Three rows in pages of two: every kind pages at least once, whatever limit the manifest asks for. */
const ROWS = 3
const PAGE = 2
const SEEDED = Date.parse("2026-11-01T10:00:00Z")
/** The currency of every amount, and what a fixed currency reads. */
const CURRENCY = "EUR"

type Value = string | number | boolean | { ms: number }

/** Where a rule can be written to: the first path it reads, or none for a function or a list it walks. */
const pathOf = (rule: CrmRule | undefined): string | undefined => {
  if (rule === undefined || typeof rule === "function") return undefined
  if (typeof rule === "string") return rule
  if ("each" in rule || "value" in rule) return undefined
  if ("first" in rule) return rule.first[0]
  if ("join" in rule) return rule.join[0]
  if ("all" in rule) return rule.all[0]
  return rule.path
}

const trailOf = (value: unknown, placeholder: string, trail: string[] = []): string[] | undefined => {
  if (value === placeholder) return trail
  if (!Array.isArray(value) && !isRaw(value)) return undefined
  for (const [key, inner] of Object.entries(value)) {
    const found = trailOf(inner, placeholder, [...trail, key])
    if (found) return found
  }
  return undefined
}

const placeOf = (call: CrmOperationCall, placeholder: string) => {
  for (const where of ["path", "query", "body"] as const) {
    const found = trailOf(call[where], placeholder)
    if (found) return { in: where, path: found.length ? found.join(".") : "." }
  }
  return undefined
}

/**
 * Our fields, in the names a read maps, that a write's values give: each rule read backwards, `"{value}"` in its
 * `each` the place of ours. A value the service clears with is a cleared field.
 */
const givenOf = (spec: CrmManifestWrite, values: unknown): Record<string, unknown> => {
  const given: Record<string, unknown> = {}
  if (!isRaw(values)) return given
  const clear = JSON.stringify(spec.clear === undefined ? null : spec.clear)
  for (const [field, rule] of Object.entries(spec.fields)) {
    if (typeof rule !== "object" || !("to" in rule) || !(rule.to in values)) continue
    const name = field === "owner" ? "assignee" : field
    const list = CRM_LIST_FIELDS.includes(field)
    const raw = values[rule.to]
    if (JSON.stringify(raw) === clear) {
      given[name] = list ? [] : null
      continue
    }
    const trail = rule.each === undefined ? [] : (trailOf(rule.each, "{value}") ?? [])
    const found = (rule.list ? (Array.isArray(raw) ? raw : []) : [raw])
      .map((one) => (trail.length ? at(one, trail.join(".")) : one))
      .filter((one) => one !== undefined && one !== null)
      .map(String)
    if (list) given[name] = field === "people" ? found.map((one) => ({ externalId: one, role: "contact" })) : found
    else if (found.length) given[name] = found[0]
  }
  return given
}

type Place = NonNullable<ReturnType<typeof placeOf>>

const readPlace = (call: FakeCall, place: { in: "path" | "query" | "body"; path: string }): unknown => {
  if (place.in === "body") return at(call.body, place.path)
  const found = call[place.in][place.path]
  return Array.isArray(found) ? found.join(",") : found
}

const SINCE: Record<CrmChangesCall["since"], (value: string) => number> = {
  ms: (value) => (/^\d+$/.test(value) ? Number(value) : Number.NaN),
  seconds: (value) => (/^\d+$/.test(value) ? Number(value) * 1000 : Number.NaN),
  iso: (value) => Date.parse(value),
  datetime: (value) => Date.parse(`${value.replace(" ", "T")}Z`),
}

const pageParameter = (pagination: Pagination) =>
  pagination.style === "cursor"
    ? pagination.cursor
    : pagination.style === "offset"
      ? pagination.offset
      : pagination.style === "page"
        ? pagination.page
        : undefined

/** Every fixed value of a call's template by its dotted path; a placeholder is not fixed. */
const fixedOf = (value: unknown, trail: readonly string[] = []): [string, string | number | boolean][] => {
  if (Array.isArray(value) || isRaw(value))
    return Object.entries(value).flatMap(([key, inner]) => fixedOf(inner, [...trail, key]))
  if (!["string", "number", "boolean"].includes(typeof value) || /^\{\w+\}$/.test(String(value))) return []
  return [[trail.join("."), value as string | number | boolean]]
}

const fixedCount = (call: CrmOperationCall, paging: (where: "query" | "body", key: string) => boolean) =>
  fixedOf(call.path).length +
  fixedOf(call.query).filter(([key]) => !paging("query", key)).length +
  fixedOf(call.body).filter(([key]) => !paging("body", key)).length

interface Route {
  call: CrmOperationCall
  rows: () => CrmRaw[]
  kind?: CrmKind
  write?: { verb: "create" | "update" | "remove"; spec: CrmManifestWrite; id?: Place; values?: Place }
  /** A value read once, at this path of the answer: the fixed currency. */
  fixed?: string
  get?: Place
  /** A live search: only the rows whose text holds the words at this place. */
  query?: Place
  since?: { place: Place; format: CrmChangesCall["since"]; at: (row: CrmRaw) => number | null }
}

/**
 * A CRM service in memory, built from a source manifest and the generated API it names: rows sampled from each
 * operation's answer schema with distinct ids and the values the map reads, paged by each operation's own pagination,
 * read for changes by the time the manifest names. A call no route of the manifest makes is refused and recorded.
 */
export const crmManifestFake = (input: CrmManifest, options: CrmManifestFakeOptions): CrmManifestFake => {
  const { api, definitions } = options
  const manifest = parseCrmManifest(input, api)
  const operations = new Map(api.operations.map((one) => [one.id, one]))
  const own: string[] = []

  const rootOf = (call: CrmOperationCall): SchemaNode | undefined => {
    const schema = operations.get(call.operation)?.response?.schema
    return schema === undefined ? undefined : { type: "ref", ref: schema }
  }
  const itemsOf = (call: CrmOperationCall) => call.items ?? operations.get(call.operation)?.pagination?.items
  const nodeAt = (node: SchemaNode | undefined, path: string) => {
    if (node === undefined) return undefined
    const found = walk(node, path, definitions)
    return "node" in found ? found.node : undefined
  }
  const rowNodeOf = (call: CrmOperationCall) => {
    const root = rootOf(call)
    const items = itemsOf(call)
    return itemOf(items === undefined ? root : nodeAt(root, items), definitions)
  }
  const sample = (node: SchemaNode | undefined) => (node === undefined ? undefined : sampleOf(node, definitions))

  const scalarOf = (node: SchemaNode | undefined): SchemaNode | undefined => {
    if (node === undefined) return undefined
    const found = resolve(node, definitions)
    return found.type === "union"
      ? scalarOf(found.of.find((one) => resolve(one, definitions).type !== "unknown"))
      : found
  }

  /** The value as the schema at its place takes it; `undefined` when it cannot. */
  const typed = (node: SchemaNode | undefined, value: Value): unknown => {
    const found = scalarOf(node)
    const type = found?.type ?? "string"
    // A place whose schema the walk cannot name keeps a flag a flag: the strict fake still checks it.
    if (typeof value === "boolean") return type === "boolean" || found === undefined ? value : undefined
    if (typeof value === "object")
      return type === "integer" || type === "number" ? value.ms : new Date(value.ms).toISOString()
    if (type === "integer" || type === "number") return Number.isFinite(Number(value)) ? Number(value) : undefined
    if (type === "string" && found?.type === "string" && found.enum) return undefined
    return ["string", "unknown"].includes(type) ? String(value) : undefined
  }

  /**
   * The schema with each union on the way to `keys` cut to the branch that has the rest of the path: a sample of the
   * first branch of Attio's seventeen value types would carry another type's fields, and the strict fake refuses it.
   */
  const narrowed = (node: SchemaNode, keys: readonly string[], value?: Value): SchemaNode => {
    if (keys.length === 0) return node
    const found = resolve(node, definitions)
    const [key, ...rest] = keys as [string, ...string[]]
    // A branch fits when it has the path, and, with a value to write, takes it there: Attio's `value` is text in one
    // branch and a flag in another.
    const fits = (one: SchemaNode) => {
      const leaf = walk(one, keys.join("."), definitions)
      return "node" in leaf && (value === undefined || typed(leaf.node, value) !== undefined)
    }
    switch (found.type) {
      case "union": {
        const branch = found.of.find(fits) ?? found.of.find((one) => "node" in walk(one, keys.join("."), definitions))
        return branch ? narrowed(branch, keys, value) : node
      }
      case "allOf":
        return { ...found, of: found.of.map((one) => (fits(one) ? narrowed(one, keys, value) : one)) }
      case "array":
        return /^\d+$/.test(key) ? { ...found, items: narrowed(found.items, rest, value) } : node
      case "object": {
        const inner = found.properties[key] ?? found.additionalProperties
        return inner ? { ...found, properties: { ...found.properties, [key]: narrowed(inner, rest, value) } } : node
      }
      default:
        return node
    }
  }

  /** The object a dotted path ends in, with its last key and schema: what is missing is built from the schema's sample. */
  const parentOf = (row: CrmRaw, path: string, node: SchemaNode | undefined) => {
    const keys = path.split(".")
    const key = keys.pop() as string
    let here: Record<string, unknown> = row
    let schema = node
    for (const [place, one] of keys.entries()) {
      const inner = schema === undefined ? undefined : (step(schema, one, definitions) ?? undefined)
      if (typeof here[one] !== "object" || here[one] === null) {
        const made = sample(inner && narrowed(inner, [...keys.slice(place + 1), key]))
        here[one] = typeof made === "object" && made !== null ? made : /^\d+$/.test(keys[place + 1] ?? key) ? [] : {}
      }
      here = here[one] as Record<string, unknown>
      schema = inner
    }
    return { here, key, node: schema === undefined ? undefined : (step(schema, key, definitions) ?? undefined) }
  }

  /** Writes a value as the schema at its place takes it; one it cannot take is left out. */
  const put = (row: CrmRaw, path: string, value: Value, node: SchemaNode | undefined) => {
    const { here, key, node: inner } = parentOf(row, path, node)
    const written = typed(inner, value)
    if (written !== undefined) here[key] = written
  }

  const putList = (row: CrmRaw, path: string, value: unknown, node: SchemaNode | undefined) => {
    const { here, key } = parentOf(row, path, node)
    here[key] = value
  }

  /** Drops the next page's token on the last page: the shallowest optional field on its path, else an empty token. */
  const drop = (answer: CrmRaw, path: string, root: SchemaNode | undefined) => {
    const keys = path.split(".")
    let here: unknown = answer
    let schema = root
    for (const [place, key] of keys.entries()) {
      if (!isRaw(here)) return
      const found = schema === undefined ? undefined : resolve(schema, definitions)
      if (found?.type !== "object" || !found.required.includes(key) || place === keys.length - 1) {
        if (found?.type === "object" && found.required.includes(key))
          here[key] = typed(step(found, key, definitions) ?? undefined, "")
        else delete here[key]
        return
      }
      here = here[key]
      schema = step(found, key, definitions) ?? undefined
    }
  }

  const rowOf = (
    node: SchemaNode | undefined,
    rules: Readonly<Record<string, CrmRule | undefined>>,
    types: Readonly<Record<string, Conversion>>,
    n: number,
    given: Readonly<Record<string, Value | undefined>>,
  ): CrmRaw => {
    const sampledValue = (field: string, rule: CrmRule | undefined): Value | undefined => {
      const mapped = typeof rule === "object" && "map" in rule ? Object.keys(rule.map)[0] : undefined
      const reverse =
        typeof rule === "object" && "map" in rule && field in given
          ? Object.keys(rule.map).find((key) => String(rule.map[key]) === String(given[field]))
          : undefined
      if (reverse !== undefined) return reverse
      if (field in given) return given[field]
      if (mapped !== undefined) return mapped
      if (types[field] === "text") return `${field} ${n + 1}`
      if (types[field] === "epoch") return { ms: SEEDED + (n + 1) * 60_000 }
      return types[field] === "day" ? `2026-11-0${n + 1}` : undefined
    }
    const writes = Object.entries(rules).flatMap(([field, rule]) => {
      const path = pathOf(rule)
      return path === undefined ? [] : [{ path, value: sampledValue(field, rule) }]
    })
    // Sampled from the schema cut to the branches the rules write into, each one that takes its value: Attio's
    // `value` is text in one branch and a flag in another, and a list the first sample holds must have the right type.
    const cut = node && writes.reduce((one, { path, value }) => narrowed(one, path.split("."), value), node)
    const made = sample(cut)
    const row = isRaw(made) ? made : {}
    for (const { path, value } of writes) if (value !== undefined) put(row, path, value, cut)
    return row
  }

  const userSpec = manifest.users
  const users = userSpec
    ? Array.from({ length: ROWS }, (_, n) =>
        rowOf(rowNodeOf(userSpec.call), userSpec.map, { name: "text", email: "text" }, n, {
          externalId: String(7001 + n),
        }),
      )
    : []

  const pipelines = new Map<DealKind, { rows: CrmRaw[]; id: string; stages: string[] }>()
  for (const [index, kind] of DEAL_KINDS.entries()) {
    const spec = manifest.pipelines?.[kind]
    if (!spec || !manifest.kinds.includes(kind)) continue
    const rule = manifest.entities[kind]?.map.pipeline
    const id = typeof rule === "object" && "value" in rule ? String(rule.value) : String(9001 + index)
    const node = rowNodeOf(spec.call)
    const flat = spec.stages.each === "."
    const stageNode = flat ? node : itemOf(nodeAt(node, spec.stages.each), definitions)
    const outcome = spec.stages.outcome
    const stages = Array.from({ length: ROWS }, (_, n) => {
      const stage = rowOf(stageNode, spec.stages.map, { name: "text" }, n, {
        externalId: `${id}0${n + 1}`,
        position: n,
      })
      const won =
        typeof outcome === "object" && "path" in outcome ? [outcome.won?.[0], outcome.lost?.[0]][n - 1] : undefined
      if (won !== undefined && typeof outcome === "object" && "path" in outcome)
        for (const value of won === "true" || won === "false" ? [won === "true", won] : [won]) {
          // A flag the schema keeps as a boolean takes one; a text field the word.
          put(stage, outcome.path, value, stageNode)
          if (at(stage, outcome.path) === value) break
        }
      if (flat && spec.stages.pipeline) put(stage, spec.stages.pipeline, id, stageNode)
      return stage
    })
    const ids = stages.map((_, n) => `${id}0${n + 1}`)
    if (flat) {
      pipelines.set(kind, { rows: stages, id, stages: ids })
      continue
    }
    const row = rowOf(node, spec.map, { name: "text" }, 0, { externalId: id })
    putList(row, spec.stages.each, stages, node)
    pipelines.set(kind, { rows: [row], id, stages: ids })
  }

  const idAt = (kind: CrmKind, n: number) => {
    const index = manifest.kinds.indexOf(kind)
    return index < 0 ? undefined : String((index + 1) * 1000 + n + 1)
  }
  /** A list a rule walks, one entry for each value: a deal's people, a contact's e-mails. */
  const putEach = (row: CrmRaw, rule: CrmRule | undefined, node: SchemaNode | undefined, values: readonly string[]) => {
    if (typeof rule !== "object" || !("each" in rule)) return
    const inner = "id" in rule ? rule.id : rule.value
    const entry = itemOf(nodeAt(node, rule.each), definitions)
    const items = values.map((value) => {
      const made = sample(entry && narrowed(entry, inner.split("."), value))
      const item = isRaw(made) ? made : {}
      put(item, inner, value, entry)
      return item
    })
    putList(row, rule.each, items, node)
  }

  const rows: Partial<Record<CrmKind, CrmRaw[]>> = {}
  const changeAt: Partial<Record<CrmKind, (string | undefined)[]>> = {}
  for (const [index, kind] of manifest.kinds.entries()) {
    const entity = manifest.entities[kind]
    if (!entity) continue
    const map = entity.map as Readonly<Record<string, CrmRule | undefined>>
    const node = rowNodeOf(entity.list)
    const pipeline = pipelines.get(kind as DealKind)
    const money = pathOf(map.amount) !== undefined && pathOf(map.currency) !== undefined
    const keyset = entity.changes?.keyset?.field
    changeAt[kind] = [...new Set([pathOf(map.updatedAt), keyset])].filter(Boolean)
    rows[kind] = Array.from({ length: ROWS }, (_, n) => {
      const time = { ms: SEEDED + (n + 1) * 60_000 }
      const row = rowOf(node, map, FIELDS[kind], n, {
        externalId: String((index + 1) * 1000 + n + 1),
        assignee: "7001",
        ...(pipeline ? { pipeline: pipeline.id, stage: pipeline.stages[n % pipeline.stages.length] } : {}),
        ...(money ? { amount: "100.50", currency: CURRENCY } : { amount: undefined, currency: undefined }),
        ...(pipeline && idAt("organization", n) ? { organization: idAt("organization", n) } : {}),
      })
      const person = idAt("person", n)
      if (pipeline && person) putEach(row, map.people, node, [person])
      if (keyset) put(row, keyset, time, node)
      return row
    })
  }

  const idOf = (kind: CrmKind, row: CrmRaw) => externalIdOf(manifest, kind, row)
  const timeOf = (kind: CrmKind, row: CrmRaw) => {
    const path = changeAt[kind]?.[0]
    const found = path === undefined ? null : convert("epoch", at(row, path))
    return typeof found === "number" ? found : null
  }

  for (const kind of manifest.kinds) {
    if (!manifest.entities[kind]?.changes) continue
    const unread = (rows[kind] ?? []).some((row) => timeOf(kind, row) === null)
    if (!changeAt[kind]?.length || unread)
      throw new Error(
        `the fake cannot write a change time ${kind} rows read back: map updatedAt or keyset.field to a path`,
      )
  }

  const routes: Route[] = []
  for (const kind of manifest.kinds) {
    const entity = manifest.entities[kind]
    if (!entity) continue
    const all = () => rows[kind] ?? []
    if (entity.changes) {
      const place = placeOf(entity.changes, "{since}") as Place
      routes.push({
        call: entity.changes,
        kind,
        rows: all,
        since: { place, format: entity.changes.since, at: (row) => timeOf(kind, row) },
      })
    }
    for (const call of [entity.list, entity.ids]) if (call) routes.push({ call, kind, rows: all })
    if (entity.get) routes.push({ call: entity.get, kind, rows: all, get: placeOf(entity.get, "{id}") as Place })
    if (entity.search)
      routes.push({ call: entity.search, kind, rows: all, query: placeOf(entity.search, "{query}") as Place })
  }
  for (const [kind, one] of pipelines) {
    const spec = manifest.pipelines?.[kind]
    if (spec) routes.push({ call: spec.call, rows: () => one.rows })
  }
  for (const [kind, spec] of Object.entries(manifest.fields ?? {})) {
    if (!spec) continue
    const node = rowNodeOf(spec.call)
    const { options: _, ...map } = spec.map
    const keep = typeof spec.keep === "object" ? spec.keep : undefined
    const fields = Array.from({ length: PAGE }, (_, n) => {
      const field = rowOf(node, map, { code: "text", label: "text" }, n, { code: `${kind}_field_${n + 1}` })
      if (keep && typeof keep.is !== "object") putList(field, keep.path, keep.is, node)
      return field
    })
    routes.push({ call: spec.call, rows: () => fields })
  }
  if (manifest.users) routes.push({ call: manifest.users.call, rows: () => users })
  for (const kind of manifest.kinds) {
    const spec = manifest.writes?.[kind] as CrmManifestWrite | undefined
    if (!spec) continue
    for (const verb of ["create", "update", "remove"] as const) {
      const call = spec[verb]
      if (!call) continue
      const id = placeOf(call, "{id}")
      const values = placeOf(call, "{values}")
      routes.push({
        call,
        kind,
        rows: () => rows[kind] ?? [],
        write: { verb, spec, ...(id ? { id } : {}), ...(values ? { values } : {}) },
      })
    }
    const currency = spec.fields.currency
    if (typeof currency === "object" && "fixed" in currency)
      routes.push({ call: currency.fixed, rows: () => [], fixed: currency.at })
  }

  const denied = new Map<string, number>()
  let writes = 0
  let made = 0
  let lose = false

  /** A record, in the names a read maps, as a row the read maps back: what it does not name stays out. */
  const rowFor = (kind: CrmKind, fields: Readonly<Record<string, unknown>>): CrmRaw => {
    const entity = manifest.entities[kind] as NonNullable<CrmManifest["entities"][CrmKind]>
    const map = entity.map as Readonly<Record<string, CrmRule | undefined>>
    const node = rowNodeOf(entity.list)
    const scalar = (field: string, value: unknown): Value | undefined => {
      if (typeof value === "number" && FIELDS[kind][field] === "epoch") return { ms: value }
      return ["string", "number", "boolean"].includes(typeof value) ? (value as Value) : undefined
    }
    const given = Object.fromEntries(
      Object.keys(map).flatMap((field) => {
        const value = scalar(field, fields[field])
        return value === undefined ? [] : [[field, value]]
      }),
    )
    // Only the rules with a value shape the sample: one without would sample a value where the record has none.
    const rules = Object.fromEntries(Object.entries(map).filter(([field]) => field in given || field === "pipeline"))
    const row = rowOf(node, rules, FIELDS[kind], 0, given)
    for (const [field, value] of Object.entries(fields)) {
      if (!Array.isArray(value)) continue
      const ids = value.map((one) => (isRaw(one) ? String(one.externalId) : String(one)))
      const rule = map[field]
      const path = pathOf(rule)
      if (typeof rule === "object" && "each" in rule) putEach(row, rule, node, ids)
      else if (path !== undefined && ids[0] !== undefined) put(row, path, ids[0], node)
    }
    return row
  }

  /** A create, update or remove of one record, as the service would make it, answered as its schema says. */
  const written = (route: Route & { kind: CrmKind; write: NonNullable<Route["write"]> }, call: FakeCall) => {
    writes += 1
    const { kind, write } = route
    const list = rows[kind] ?? []
    rows[kind] = list
    const root = rootOf(route.call)
    const sampled = sample(root)
    const answer = isRaw(sampled) ? sampled : {}
    const externalId =
      write.verb === "create"
        ? String((manifest.kinds.indexOf(kind) + 1) * 1000 + 500 + ++made)
        : String(readPlace(call, write.id as Place) ?? "")
    const place = list.findIndex((one) => idOf(kind, one) === externalId)
    if (write.verb !== "create" && place < 0)
      return refuse(`${call.operation}: no ${kind} ${externalId} in the fake`, 404)
    if (write.verb === "remove") {
      list.splice(place, 1)
      return { body: answer }
    }
    const entity = manifest.entities[kind] as NonNullable<CrmManifest["entities"][CrmKind]>
    const before = place < 0 ? {} : (mapRecord(kind, entity, list[place] as CrmRaw) ?? {})
    const given = givenOf(write.spec, write.values ? readPlace(call, write.values) : undefined)
    const pipeline = pipelines.get(kind as DealKind)
    const fields: Record<string, unknown> = {
      ...(pipeline ? { pipeline: pipeline.id } : {}),
      ...before,
      ...given,
      externalId,
      updatedAt: Date.now(),
    }
    const currency = write.spec.fields.currency
    if (typeof currency === "object" && "fixed" in currency && fields.amount != null) fields.currency = CURRENCY
    const row = rowFor(kind, fields)
    if (place < 0) list.push(row)
    else list[place] = row
    if (write.verb === "create" && write.spec.id) putList(answer, write.spec.id, externalId, root)
    return { body: answer }
  }

  const refuse = (message: string, status = 400): FakeAnswer => {
    own.push(message)
    return { status, body: { message } }
  }

  /** A page's size and place are the engine's to set: a live list asks for its own, whatever the template says. */
  const paging = (operation: string, where: "query" | "body", key: string) => {
    const pagination = operations.get(operation)?.pagination
    if (!pagination) return false
    const parameters = [pageParameter(pagination), "limit" in pagination ? pagination.limit : undefined]
    return parameters.some((one) => one?.in === where && one.name === key)
  }

  const matches = (route: Route, call: FakeCall) =>
    route.call.operation === call.operation &&
    fixedOf(route.call.path).every(([key, value]) => call.path[key] === String(value)) &&
    fixedOf(route.call.query).every(
      ([key, value]) =>
        paging(route.call.operation, "query", key) || readPlace(call, { in: "query", path: key }) === String(value),
    ) &&
    fixedOf(route.call.body).every(
      ([key, value]) => paging(route.call.operation, "body", key) || at(call.body, key) === value,
    )

  /**
   * The route whose template the call matches most closely; a list wins a tie with a change read, and a search a tie
   * with a list only when its words were sent.
   */
  const routeOf = (call: FakeCall) =>
    routes
      .filter((route) => matches(route, call) && (!route.query || readPlace(call, route.query) !== undefined))
      .sort(
        (a, b) =>
          fixedCount(b.call, (where, key) => paging(b.call.operation, where, key)) -
            fixedCount(a.call, (where, key) => paging(a.call.operation, where, key)) ||
          Number(!!b.query) - Number(!!a.query) ||
          Number(!!a.since) - Number(!!b.since),
      )[0]

  const page = (route: Route, call: FakeCall, listed: CrmRaw[]): FakeAnswer => {
    const operation = operations.get(route.call.operation)
    const pagination = operation?.pagination
    const root = rootOf(route.call)
    const items = itemsOf(route.call)
    if (items === undefined) return { body: listed }
    const made = sample(root)
    const answer = isRaw(made) ? made : {}
    if (!pagination) {
      putList(answer, items, listed, root)
      return { body: answer }
    }
    // The manifest refuses a link-paged read; the check stays for a style cli-base adds later.
    if (pagination.style !== "cursor" && pagination.style !== "offset" && pagination.style !== "page")
      throw new Error(`${route.call.operation}: the fake does not page by ${pagination.style}`)
    const parameter =
      pagination.style === "cursor"
        ? pagination.cursor
        : pagination.style === "offset"
          ? pagination.offset
          : pagination.page
    const sent = readPlace(
      call,
      parameter.in === "query" ? { in: "query", path: parameter.name } : { in: "body", path: parameter.name },
    )
    const number = sent === undefined ? undefined : Number(sent)
    if (number !== undefined && !Number.isSafeInteger(number))
      return refuse(`${route.call.operation}: ${parameter.name} ${String(sent)} is not a page this fake gave`)
    const limited = pagination.limit
      ? Number(readPlace(call, { in: pagination.limit.in, path: pagination.limit.name }))
      : NaN
    const size = Number.isSafeInteger(limited) && limited > 0 ? Math.min(limited, PAGE) : PAGE
    const from = pagination.style === "page" ? ((number ?? 1) - 1) * size : (number ?? 0)
    const chunk = listed.slice(from, from + size)
    const more = from + size < listed.length
    putList(answer, items, chunk, root)
    if (pagination.style === "cursor") {
      if (more) {
        put(answer, pagination.next, String(from + size), root)
        const written = at(answer, pagination.next)
        if (typeof written !== "string" || written === "")
          throw new Error(`${route.call.operation}: the schema takes no text cursor at ${pagination.next}`)
      } else drop(answer, pagination.next, root)
      if (pagination.hasMore) put(answer, pagination.hasMore, more, root)
    } else if (pagination.total) put(answer, pagination.total, listed.length, root)
    return { body: answer }
  }

  const answerOf = (call: FakeCall): FakeAnswer => {
    const route = routeOf(call)
    if (!route) return refuse(`${call.operation ?? call.url.pathname}: no call of the source manifest is this one`, 404)
    if (route.write && route.kind) return written({ ...route, kind: route.kind, write: route.write }, call)
    if (route.fixed !== undefined) {
      const root = rootOf(route.call)
      const sampled = sample(root)
      const answer = isRaw(sampled) ? sampled : {}
      putList(answer, route.fixed, CURRENCY, root)
      return { body: answer }
    }
    const changes = route.since ? route : undefined
    if (changes?.since && readPlace(call, changes.since.place) === undefined)
      return refuse(`${call.operation}: a read of changes without its since`)
    if (route.get && route.kind) {
      const kind = route.kind
      const id = String(readPlace(call, route.get) ?? "")
      const status = denied.get(`${kind} ${id}`)
      if (status) return { status, body: { message: "denied" } }
      const row = route.rows().find((one) => idOf(kind, one) === id)
      // The contract asks for this id on purpose; any other id the fake lacks is one the source made up.
      if (!row && id.startsWith("contract-missing")) return { status: 404, body: { message: "not found" } }
      if (!row) return refuse(`${call.operation}: no ${kind} ${id} in the fake`, 404)
      if (route.call.items === undefined) return { body: row }
      const root = rootOf(route.call)
      const made = sample(root)
      const answer = isRaw(made) ? made : {}
      putList(answer, route.call.items, row, root)
      return { body: answer }
    }
    if (changes?.since) {
      const { place, format, at: timeAt } = changes.since
      const from = SINCE[format](String(readPlace(call, place)))
      if (!Number.isFinite(from))
        return refuse(`${call.operation}: since ${String(readPlace(call, place))} is unreadable`)
      const listed = changes
        .rows()
        .filter((row) => (timeAt(row) ?? Number.NEGATIVE_INFINITY) >= from)
        .sort((a, b) => (timeAt(a) ?? 0) - (timeAt(b) ?? 0))
      return page(changes, call, listed)
    }
    if (route.query) {
      const words = String(readPlace(call, route.query)).toLowerCase()
      return page(
        route,
        call,
        route.rows().filter((row) => JSON.stringify(row).toLowerCase().includes(words)),
      )
    }
    return page(route, call, route.rows())
  }

  const fake = fakeApi({
    operations: api.operations,
    definitions,
    baseUrl: options.baseUrl ?? manifestBaseUrl(api),
    token: FAKE_MANIFEST_TOKEN,
    ...(api.security ? { security: api.security } : {}),
    ...(api.securitySchemes ? { securitySchemes: api.securitySchemes } : {}),
    answers: Object.fromEntries(api.operations.map((one) => [one.id, answerOf])),
  })

  return {
    async fetch(input, init) {
      const before = writes
      const answer = await fake.fetch(input, init)
      if (lose && writes > before) {
        lose = false
        throw new TypeError("fetch failed")
      }
      return answer
    },
    calls: fake.calls,
    get refusals() {
      return [...fake.refusals, ...own]
    },
    rows,
    deny: (kind, id, status) => denied.set(`${kind} ${id}`, status),
    touch(kind, id) {
      const row = rows[kind]?.find((one) => idOf(kind, one) === id)
      if (!row) throw new Error(`the fake holds no ${kind} ${id}`)
      const node = rowNodeOf((manifest.entities[kind] as NonNullable<CrmManifest["entities"][CrmKind]>).list)
      const paths = changeAt[kind] ?? []
      for (const path of paths) if (path) put(row, path, { ms: Date.now() }, node)
      if (timeOf(kind, row) === null) throw new Error(`the fake cannot change the time of ${kind} ${id}`)
    },
    loseNextAnswer: () => {
      lose = true
    },
    requests: () => writes,
  }
}

const externalIdOf = (manifest: CrmManifest, kind: CrmKind, row: CrmRaw | undefined) => {
  const rule = manifest.entities[kind]?.map.externalId
  const found = rule === undefined || row === undefined ? MISSING : evaluate(rule, row)
  return found === MISSING ? null : id(found)
}

export interface CrmManifestFixtureOptions extends CrmManifestFakeOptions {
  hooks?: CrmManifestHooks
}

/**
 * A `crmSourceContract` fixture for a source built from a manifest, over `crmManifestFake`: the source, the rows it
 * holds, a dead cursor, every fault the manifest allows, and the fake itself, whose `refusals` a test asserts empty.
 */
export const crmManifestFixture = (
  manifest: CrmManifest,
  options: CrmManifestFixtureOptions,
): CrmSourceFixture & { fake: CrmManifestFake } => {
  const fake = crmManifestFake(manifest, options)
  const call = serviceApiCall({
    manifest: options.api,
    service: manifest.provider,
    fetch: fake.fetch,
    token: () => FAKE_MANIFEST_TOKEN,
    ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
  })
  const sourceAt = (now: () => number = Date.now): CrmSource =>
    crmSourceFromManifest(manifest, { api: options.api, call, now, ...(options.hooks ? { hooks: options.hooks } : {}) })
  const source = sourceAt()
  const held = Object.fromEntries(
    manifest.kinds.map((kind) => [
      kind,
      (fake.rows[kind] ?? []).map((row) => externalIdOf(manifest, kind, row) as string),
    ]),
  ) as Partial<Record<CrmKind, string[]>>
  const live = (["person", "organization"] as const).find((kind) => manifest.entities[kind]?.get)
  const changed = manifest.kinds.find((kind) => manifest.entities[kind]?.changes)
  const first = (kind: CrmKind) => held[kind]?.[0] as string
  return {
    source,
    fake,
    held,
    ...(source.list ? { live: { person: held.person ?? [], organization: held.organization ?? [] } } : {}),
    deadCursor: { kind: manifest.kinds[0] as CrmKind, cursor: "not a time" },
    faults: {
      ...(live
        ? {
            async deny(status: 403 | 404) {
              const id = first(live)
              // A get that reads a wrong id answers null too: the row must read before it is denied.
              if ((await source.get?.(live, id)) == null) throw new Error(`get(${live}, ${id}) did not read the row`)
              fake.deny(live, id, status)
              return { kind: live, id }
            },
          }
        : {}),
      skewed: (ms: number) => sourceAt(() => Date.now() + ms),
      ...(changed
        ? {
            change: () => {
              const id = first(changed)
              fake.touch(changed, id)
              return { kind: changed, id }
            },
          }
        : {}),
      sameToken: () => sourceAt(),
    },
  }
}

/**
 * `crmSourceContract` over `crmManifestFixture`, each case failing too when the fake refused a call: what a generated
 * test runs, `for (const { name, run } of crmManifestContract(SOURCE, { api, definitions })) it(name, run)`.
 */
export const crmManifestContract = (manifest: CrmManifest, options: CrmManifestFixtureOptions): ContractCase[] => {
  const fakes: CrmManifestFake[] = []
  return crmSourceContract(() => {
    const fixture = crmManifestFixture(manifest, options)
    fakes.push(fixture.fake)
    return fixture
  }).map(({ name, run }) => ({
    name,
    async run() {
      fakes.length = 0
      await run()
      const refused = fakes.flatMap((fake) => fake.refusals)
      if (refused.length) throw new Error(`the fake refused calls the source made:\n${refused.join("\n")}`)
    },
  }))
}

/**
 * A `crmWriteContract` fixture for a writer built from a manifest's `writes`, over `crmManifestFake`: the writer, the
 * first pipeline of the deal kind it writes, the service's own names of stage and owner, and the fake.
 */
export const crmManifestWriteFixture = async (
  manifest: CrmManifest,
  options: CrmManifestFixtureOptions,
): Promise<CrmWriteFixture & { fake: CrmManifestFake }> => {
  const fake = crmManifestFake(manifest, options)
  const sending = {
    manifest: options.api,
    service: manifest.provider,
    fetch: fake.fetch,
    token: () => FAKE_MANIFEST_TOKEN,
    ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
  }
  const source = crmSourceFromManifest(manifest, {
    api: options.api,
    call: serviceApiCall(sending),
    ...(options.hooks ? { hooks: options.hooks } : {}),
  })
  const writer = crmWriterFromManifest(manifest, {
    api: options.api,
    service: manifest.provider,
    send: serviceApiSend(sending),
    source: () => source,
  })
  const kind = DEAL_KINDS.find((one) => writer.capabilities.kinds.includes(one))
  if (!kind) throw new Error("the manifest writes no deal or lead, and the write contract needs one")
  const [pipeline] = await source.pipelines(kind)
  if (!pipeline) throw new Error(`the fake holds no ${kind} pipeline`)
  const fields = (manifest.writes?.[kind]?.fields ?? {}) as Readonly<Record<string, unknown>>
  const aliases = [fields.stage, fields.owner].flatMap((rule) =>
    isRaw(rule) && typeof rule.to === "string" ? [rule.to] : [],
  )
  return {
    writer,
    kind,
    pipeline,
    aliases,
    loseNextAnswer: fake.loseNextAnswer,
    requests: fake.requests,
    fake,
  }
}

/** `crmWriteContract` over `crmManifestWriteFixture`, each case failing too when the fake refused a call. */
export const crmManifestWriteContract = (manifest: CrmManifest, options: CrmManifestFixtureOptions): ContractCase[] => {
  const fakes: CrmManifestFake[] = []
  return crmWriteContract(async () => {
    const fixture = await crmManifestWriteFixture(manifest, options)
    fakes.push(fixture.fake)
    return fixture
  }).map(({ name, run }) => ({
    name,
    async run() {
      fakes.length = 0
      await run()
      const refused = fakes.flatMap((fake) => fake.refusals)
      if (refused.length) throw new Error(`the fake refused calls the writer made:\n${refused.join("\n")}`)
    },
  }))
}
