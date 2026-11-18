import {
  type GraphqlFake,
  type GraphqlFakeAnswer,
  type GraphqlFakeCall,
  graphqlFake,
  type SchemaNode,
  type Selection,
  sampleOf,
} from "@wirecat/cli-base/codegen"
import { serviceApiCall } from "../../cli/service-api-call.js"
import { manifestBaseUrl, type ServiceApiManifest } from "../../cli/service-api-manifest.js"
import { crmValues } from "../../crm/index.js"
import type { CrmRule } from "../../crm/manifest/manifest.js"
import { at, evaluate, MISSING, rulePaths } from "../../crm/manifest/map.js"
import { resolve, step } from "../../crm/manifest/paths.js"
import { FAKE_MANIFEST_TOKEN } from "../../crm/testing/index.js"
import { STATE_TYPES, type TrackerKind } from "../../domain/tracker.js"
import type { ContractCase } from "../../meetings/index.js"
import {
  parseTrackerManifest,
  rowSelection,
  selectionOf,
  type TrackerChangesCall,
  type TrackerManifest,
  type TrackerManifestHooks,
  type TrackerOperationCall,
} from "../manifest/manifest.js"
import { TRACKER_FIELDS } from "../manifest/map.js"
import { trackerSourceFromManifest } from "../manifest/source.js"
import type { TrackerSource } from "../source.js"
import { type TrackerSourceFixture, trackerSourceContract } from "./source-contract.js"

type Definitions = Readonly<Record<string, SchemaNode>>

export interface TrackerManifestFakeOptions {
  /** The generated API manifest the source manifest names its operations in. */
  api: ServiceApiManifest
  /** The generated schemas: rows are sampled from them, and every call and answer is checked against them. */
  definitions: Definitions
  /** In place of the API manifest's first server. */
  baseUrl?: string
}

export interface TrackerManifestFake extends GraphqlFake {
  /** The rows of each kind as the tracker holds them, every field any call of the kind selects; a test may change them. */
  rows: Partial<Record<TrackerKind, crmValues.CrmRaw[]>>
  /** Moves one row's change time to now, for the next read of changes to list it. */
  touch(kind: TrackerKind, id: string): void
  /** Archives one row now: listed only to a call that asks for archived rows, and read as changed. */
  archive(kind: TrackerKind, id: string): void
  /** Deletes one row outright. */
  remove(kind: TrackerKind, id: string): void
}

/** Three rows in pages of two: every kind pages at least once, whatever `first` the manifest asks for. */
const ROWS = 3
const PAGE = 2
const SEEDED = Date.parse("2026-11-01T10:00:00Z")
/** Linear's argument; a call to an operation that takes it and leaves it unset sees no archived row. */
const ARCHIVED = "includeArchived"
const CURSOR = /^fake-page-(\d+)$/

/** The kind an id field points at: an issue's assignee is a user, its labels are labels. */
const TARGETS: Readonly<Record<string, TrackerKind>> = {
  team: "team",
  teams: "team",
  state: "state",
  label: "label",
  labels: "label",
  project: "project",
  lead: "user",
  assignee: "user",
  creator: "user",
  author: "user",
  issue: "issue",
  parent: "issue",
}

const SINCE: Record<TrackerChangesCall["since"], (value: string) => number> = {
  iso: (value) => Date.parse(value),
  ms: (value) => (/^\d+$/.test(value) ? Number(value) : Number.NaN),
  seconds: (value) => (/^\d+$/.test(value) ? Number(value) * 1000 : Number.NaN),
}

type Value = string | number | boolean | null | { ms: number }

const idOf = (kind: TrackerKind, n: number) => `${kind}-${n + 1}`

const merge = (a: Selection, b: Selection): Selection =>
  Object.fromEntries(
    [...new Set([...Object.keys(a), ...Object.keys(b)])].map((key) => {
      const [x, y] = [a[key], b[key]]
      if (x === undefined || x === true) return [key, y ?? x ?? true]
      return [key, y === undefined || y === true ? x : merge(x, y)]
    }),
  )

/** Only the selected fields: what GraphQL answers. */
const project = (value: unknown, selection: Selection | true): unknown => {
  if (selection === true || value === null || value === undefined) return value ?? null
  if (Array.isArray(value)) return value.map((one) => project(one, selection))
  return Object.fromEntries(
    Object.entries(selection).map(([field, inner]) => [field, project((value as crmValues.CrmRaw)[field], inner)]),
  )
}

/** Every dotted path with a fixed value in a call's variables; a placeholder is not fixed. */
const fixedOf = (value: unknown, trail: readonly string[] = []): [string, unknown][] =>
  crmValues.isRaw(value)
    ? Object.entries(value).flatMap(([key, inner]) => fixedOf(inner, [...trail, key]))
    : /^\{\w+\}$/.test(String(value))
      ? []
      : [[trail.join("."), value]]

const placeOf = (value: unknown, placeholder: string, trail: readonly string[] = []): string | undefined => {
  if (value === placeholder) return trail.join(".")
  if (!crmValues.isRaw(value)) return undefined
  for (const [key, inner] of Object.entries(value)) {
    const found = placeOf(inner, placeholder, [...trail, key])
    if (found !== undefined) return found
  }
  return undefined
}

const put = (row: crmValues.CrmRaw, path: string, value: unknown) => {
  const keys = path.split(".")
  const last = keys.pop() as string
  let here = row
  for (const key of keys) {
    if (!crmValues.isRaw(here[key])) here[key] = {}
    here = here[key] as crmValues.CrmRaw
  }
  here[last] = value
}

interface Route {
  kind: TrackerKind
  call: TrackerOperationCall
  since?: { place: string; format: TrackerChangesCall["since"] }
}

/**
 * A GraphQL tracker in memory, built from a source manifest and the generated API it names: cli-base's strict
 * `graphqlFake` with three rows of each kind behind it. Each row holds the values the map reads where it reads them,
 * links to rows of the kinds it points at, and is answered within each call's selection, Relay-paged two a page. A
 * change read keeps the rows changed at or after its since, oldest first. A cursor the fake never gave, an unreadable
 * since and a call no route of the manifest makes are refused and recorded.
 */
export const trackerManifestFake = (
  input: TrackerManifest,
  options: TrackerManifestFakeOptions,
): TrackerManifestFake => {
  const { api, definitions } = options
  const manifest = parseTrackerManifest(input, api)
  const operations = new Map(api.operations.map((one) => [one.id, one]))
  const own: string[] = []

  const operationOf = (call: TrackerOperationCall) => {
    const found = operations.get(call.operation)
    if (found?.binding.kind !== "graphql")
      throw new Error(`${call.operation}: the tracker fake answers GraphQL operations only`)
    return found
  }
  const itemsOf = (call: TrackerOperationCall) => call.items ?? operationOf(call).pagination?.items
  const responseOf = (call: TrackerOperationCall): SchemaNode => {
    const schema = operationOf(call).response?.schema
    return schema === undefined ? { type: "unknown" } : { type: "ref", ref: schema }
  }
  const nodeAt = (node: SchemaNode | undefined, path: string | undefined) =>
    (path?.split(".") ?? []).reduce<SchemaNode | undefined>((inner, key) => {
      const found = inner && step(inner, key, definitions)
      const resolved = found ? resolve(found, definitions) : undefined
      return resolved?.type === "array" ? resolved.items : (found ?? undefined)
    }, node)

  /** A value of the type with only the selected fields. */
  const sampled = (node: SchemaNode, selection: Selection | true): unknown => {
    if (selection === true) return sampleOf(node, definitions)
    const found = resolve(node, definitions)
    if (found.type === "array") return [sampled(found.items, selection)]
    return Object.fromEntries(
      Object.entries(selection).map(([name, inner]) => [
        name,
        sampled(step(found, name, definitions) ?? { type: "unknown" }, inner),
      ]),
    )
  }

  /** A value as the schema at its place takes it: a time as ISO text or epoch ms; `undefined` when it cannot. */
  const typed = (node: SchemaNode | undefined, value: Value): unknown => {
    const found = node && resolve(node, definitions)
    if (value === null) return found === undefined || node?.nullable || found.nullable ? null : undefined
    // A text the schema keeps as an enum (Linear's project status type) is one of its values.
    if (typeof value === "string" && found?.type === "string" && found.enum && !found.enum.includes(value))
      return found.enum[0]
    if (typeof value !== "object") return value
    return found?.type === "integer" || found?.type === "number" ? value.ms : new Date(value.ms).toISOString()
  }

  const write = (row: crmValues.CrmRaw, item: SchemaNode | undefined, path: string, value: Value) => {
    const written = typed(nodeAt(item, path), value)
    if (written !== undefined) put(row, path, written)
  }

  const pointed = (field: string) => {
    const target = TARGETS[field]
    return target && manifest.kinds.includes(target) ? idOf(target, 0) : `${field}-1`
  }

  const sampleValue = (kind: TrackerKind, field: string, n: number): Value => {
    const type = TRACKER_FIELDS[kind][field]
    if (field === "externalId") return idOf(kind, n)
    // A state of a type outside STATE_TYPES is dropped by the map, and its issues with it.
    if (kind === "state" && field === "type") return STATE_TYPES[n % STATE_TYPES.length] as string
    switch (type) {
      case "epoch":
        return field === "createdAt" || field === "updatedAt" ? { ms: SEEDED + n * 60_000 } : null
      case "id":
        return pointed(field)
      case "number":
        return n + 1
      case "bool":
        return true
      case "day":
        return `2026-11-0${n + 1}`
      default:
        return `${field} ${n + 1}`
    }
  }

  const timePath = (kind: TrackerKind, field: "updatedAt" | "archivedAt") => {
    const rule: CrmRule | undefined = manifest.entities[kind]?.map[field]
    return typeof rule === "string" ? rule : typeof rule === "object" && "path" in rule ? rule.path : undefined
  }

  const items = new Map<TrackerKind, SchemaNode | undefined>()
  const rows: Partial<Record<TrackerKind, crmValues.CrmRaw[]>> = {}
  for (const kind of manifest.kinds) {
    const entity = manifest.entities[kind] as NonNullable<TrackerManifest["entities"][TrackerKind]>
    const calls = [entity.list, entity.changes, entity.ids].filter((one) => one !== undefined)
    const selection = calls
      .map((call) => rowSelection(selectionOf(call, api) ?? {}, itemsOf(call)) ?? {})
      .reduce((all, one) => merge(all, one), {})
    const item = nodeAt(responseOf(entity.list), itemsOf(entity.list))
    items.set(kind, item)
    if (entity.changes && timePath(kind, "updatedAt") === undefined)
      throw new Error(`${kind}: map updatedAt to a path, so the fake can read a change time`)
    rows[kind] = Array.from({ length: ROWS }, (_, n) => {
      const made = item ? sampled(item, selection) : {}
      const row = crmValues.isRaw(made) ? made : {}
      for (const [field, rule] of Object.entries(entity.map as Record<string, CrmRule | undefined>)) {
        if (typeof rule === "function" || (typeof rule === "object" && "value" in rule && !("each" in rule))) continue
        const [first, inside] = rulePaths(rule)
        if (!first) continue
        if (inside?.inside !== undefined) {
          const one: crmValues.CrmRaw = {}
          put(one, inside.path, pointed(field))
          put(row, first.path, [one])
        } else if (typeof rule === "object" && "map" in rule) put(row, first.path, Object.keys(rule.map)[0] ?? null)
        else write(row, item, first.path, sampleValue(kind, field, n))
      }
      return row
    })
  }

  const routes: Route[] = manifest.kinds.flatMap((kind) => {
    const entity = manifest.entities[kind] as NonNullable<TrackerManifest["entities"][TrackerKind]>
    return [
      { kind, call: entity.list },
      ...(entity.ids ? [{ kind, call: entity.ids }] : []),
      ...(entity.changes
        ? [
            {
              kind,
              call: entity.changes,
              since: { place: placeOf(entity.changes.variables, "{since}") as string, format: entity.changes.since },
            },
          ]
        : []),
    ]
  })

  /** A page's size and place are the engine's to set, whatever the template says. */
  const paging = (operation: string, key: string) => {
    const pagination = operations.get(operation)?.pagination
    return pagination?.style === "cursor" && [pagination.cursor.name, pagination.limit?.name].includes(key)
  }
  const fixed = (route: Route) =>
    fixedOf(route.call.variables ?? {}).filter(([key]) => !paging(route.call.operation, key))
  const matches = (route: Route, call: GraphqlFakeCall) =>
    route.call.operation === call.operation &&
    fixed(route).every(([key, value]) => JSON.stringify(at(call.variables, key)) === JSON.stringify(value)) &&
    (!route.since || at(call.variables, route.since.place) !== undefined)
  /** A change read wins over a list when its since was sent; else the route that fixes the most values. */
  const routeOf = (call: GraphqlFakeCall) =>
    routes
      .filter((route) => matches(route, call))
      .sort((a, b) => Number(!!b.since) - Number(!!a.since) || fixed(b).length - fixed(a).length)[0]

  const find = (kind: TrackerKind, id: string) => {
    const found = rows[kind]?.find((row) => externalIdOf(manifest, kind, row) === id)
    if (!found) throw new Error(`the fake holds no ${kind} ${id}`)
    return found
  }
  const timeOf = (kind: TrackerKind, row: crmValues.CrmRaw, field: "updatedAt" | "archivedAt") => {
    const path = timePath(kind, field)
    const value = path === undefined ? null : at(row, path)
    return typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : null
  }
  const stamp = (kind: TrackerKind, row: crmValues.CrmRaw, field: "updatedAt" | "archivedAt") => {
    const path = timePath(kind, field)
    if (path === undefined) throw new Error(`${kind}: map ${field} to a path, so the fake can write it`)
    write(row, items.get(kind), path, { ms: Date.now() })
  }

  const refuse = (message: string): GraphqlFakeAnswer => {
    own.push(message)
    return { status: 400, errors: [{ message, extensions: { code: "FAKE_REFUSED" } }] }
  }

  const answer = (call: GraphqlFakeCall): GraphqlFakeAnswer => {
    const route = routeOf(call)
    if (!route) return refuse(`${call.operation}: no call of the source manifest sends these variables`)
    const { kind } = route
    const operation = operationOf(route.call)
    const hidesArchived = operation.binding.kind === "graphql" && ARCHIVED in operation.binding.variables
    let listed = (rows[kind] ?? []).filter(
      (row) =>
        !hidesArchived || call.variables[ARCHIVED] === true || !Number.isFinite(timeOf(kind, row, "archivedAt") ?? NaN),
    )
    if (route.since) {
      const sent = String(at(call.variables, route.since.place))
      const from = SINCE[route.since.format](sent)
      if (!Number.isFinite(from)) return refuse(`${call.operation}: since ${sent} is unreadable`)
      listed = listed
        .filter((row) => (timeOf(kind, row, "updatedAt") ?? Number.NEGATIVE_INFINITY) >= from)
        .sort((a, b) => (timeOf(kind, a, "updatedAt") ?? 0) - (timeOf(kind, b, "updatedAt") ?? 0))
    }
    const selection = call.selection ?? {}
    const where = itemsOf(route.call)
    const inner = rowSelection(selection, where) ?? true
    const pagination = operation.pagination
    if (where === undefined) return { data: listed.map((row) => project(row, inner)) }
    const made = sampled(responseOf(route.call), selection)
    const body = crmValues.isRaw(made) ? made : {}
    if (pagination && pagination.style !== "cursor")
      throw new Error(`${call.operation}: the tracker fake pages by a cursor only, not by ${pagination.style}`)
    if (!pagination) {
      put(
        body,
        where,
        listed.map((row) => project(row, inner)),
      )
      return { data: project(body, selection) }
    }
    const sent = call.variables[pagination.cursor.name]
    const offset = sent === undefined || sent === null ? 0 : Number(CURSOR.exec(String(sent))?.[1] ?? Number.NaN)
    if (!Number.isSafeInteger(offset))
      return refuse(`${call.operation}: ${String(sent)} is not a cursor this fake gave`)
    const limit = pagination.limit ? Number(call.variables[pagination.limit.name]) : Number.NaN
    const size = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, PAGE) : PAGE
    const more = offset + size < listed.length
    put(
      body,
      where,
      listed.slice(offset, offset + size).map((row) => project(row, inner)),
    )
    put(body, pagination.next, more ? `fake-page-${offset + size}` : null)
    if (pagination.hasMore) put(body, pagination.hasMore, more)
    return { data: project(body, selection) }
  }

  const scheme = Object.values(api.securitySchemes ?? {})[0] as
    | { type?: string; in?: string; name?: string }
    | undefined
  const fake = graphqlFake({
    operations: api.operations,
    definitions,
    url: options.baseUrl ?? manifestBaseUrl(api),
    ...(scheme
      ? {
          auth:
            scheme.type === "apiKey" && scheme.in === "header" && scheme.name
              ? { header: scheme.name, value: FAKE_MANIFEST_TOKEN }
              : { header: "Authorization", value: `Bearer ${FAKE_MANIFEST_TOKEN}` },
        }
      : {}),
    answers: Object.fromEntries(routes.map((route) => [route.call.operation, answer])),
  })

  return {
    // An answer of the fake's own that breaks the schema throws inside fetch, which the source reports as a network
    // error; the refusal names it.
    fetch: (input, init) =>
      fake.fetch(input, init).catch((error: unknown) => {
        own.push(error instanceof Error ? error.message : String(error))
        throw error
      }),
    calls: fake.calls,
    get refusals() {
      return [...fake.refusals, ...own]
    },
    rows,
    touch: (kind, id) => stamp(kind, find(kind, id), "updatedAt"),
    archive(kind, id) {
      const row = find(kind, id)
      stamp(kind, row, "archivedAt")
      stamp(kind, row, "updatedAt")
    },
    remove(kind, id) {
      const row = find(kind, id)
      rows[kind]?.splice(rows[kind].indexOf(row), 1)
    },
  }
}

const externalIdOf = (manifest: TrackerManifest, kind: TrackerKind, row: crmValues.CrmRaw) => {
  const rule = manifest.entities[kind]?.map.externalId
  const found = rule === undefined ? MISSING : evaluate(rule, row)
  return found === MISSING ? null : crmValues.id(found)
}

export interface TrackerManifestFixtureOptions extends TrackerManifestFakeOptions {
  hooks?: TrackerManifestHooks
}

/**
 * A `trackerSourceContract` fixture for a source built from a manifest, over `trackerManifestFake`: the source, the
 * rows it holds, a dead cursor, the faults the manifest allows, and the fake itself, whose `refusals` a test asserts
 * empty.
 */
export const trackerManifestFixture = (
  manifest: TrackerManifest,
  options: TrackerManifestFixtureOptions,
): TrackerSourceFixture & { fake: TrackerManifestFake } => {
  const fake = trackerManifestFake(manifest, options)
  const parsed = parseTrackerManifest(manifest, options.api)
  const call = serviceApiCall({
    manifest: options.api,
    service: parsed.provider,
    fetch: fake.fetch,
    token: () => FAKE_MANIFEST_TOKEN,
    ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
  })
  const sourceAt = (now: () => number = Date.now): TrackerSource =>
    trackerSourceFromManifest(manifest, {
      api: options.api,
      call,
      now,
      ...(options.hooks ? { hooks: options.hooks } : {}),
    })
  const held = Object.fromEntries(
    parsed.kinds.map((kind) => [kind, (fake.rows[kind] ?? []).map((row) => externalIdOf(parsed, kind, row) as string)]),
  ) as Partial<Record<TrackerKind, string[]>>
  // An issue first: the kind a tracker's changes matter most for. Its last row is the one archived or removed, which
  // no other row points at.
  const changed = (["issue", ...[...parsed.kinds].reverse()] as const).find(
    (kind) => parsed.kinds.includes(kind) && parsed.entities[kind]?.changes,
  )
  const archivable = changed && parsed.entities[changed]?.map.archivedAt !== undefined
  const first = (kind: TrackerKind) => held[kind]?.[0] as string
  const last = (kind: TrackerKind) => held[kind]?.at(-1) as string
  return {
    source: sourceAt(),
    fake,
    held,
    deadCursor: { kind: parsed.kinds[0] as TrackerKind, cursor: "not a time" },
    faults: {
      remove: () => {
        const kind = changed ?? (parsed.kinds.at(-1) as TrackerKind)
        fake.remove(kind, last(kind))
        return { kind, id: last(kind) }
      },
      ...(changed
        ? {
            skewed: (ms: number) => sourceAt(() => Date.now() + ms),
            change: () => {
              fake.touch(changed, first(changed))
              return { kind: changed, id: first(changed) }
            },
          }
        : {}),
      ...(changed && archivable
        ? {
            archive: () => {
              fake.archive(changed, last(changed))
              return { kind: changed, id: last(changed) }
            },
          }
        : {}),
    },
  }
}

/**
 * `trackerSourceContract` over `trackerManifestFixture`, each case failing too when the fake refused a call: what a
 * generated test runs, `for (const { name, run } of trackerManifestContract(SOURCE, { api, definitions })) it(name, run)`.
 */
export const trackerManifestContract = (
  manifest: TrackerManifest,
  options: TrackerManifestFixtureOptions,
): ContractCase[] => {
  const fakes: TrackerManifestFake[] = []
  return trackerSourceContract(() => {
    const fixture = trackerManifestFixture(manifest, options)
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
