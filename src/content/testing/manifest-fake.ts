import { CliError } from "@wirecat/cli-base"
import type { ManifestOperation, PageParameter } from "@wirecat/cli-base/codegen"
import type { ApiCommandInput } from "../../cli/bot/api.js"
import type { ServiceApiManifest } from "../../cli/service-api-manifest.js"
import type { CrmOperationCall, CrmRule } from "../../crm/manifest/manifest.js"
import { at } from "../../crm/manifest/map.js"
import type { ContentKind } from "../../domain/content.js"
import type { ContentManifest, ContentManifestEntity } from "../manifest/manifest.js"
import { parseContentManifest } from "../manifest/manifest.js"
import { utcEpoch } from "../manifest/map.js"
import { exampleContentRows, type FakeContentRows } from "./source.js"

type Row = Record<string, unknown>

export interface ContentManifestFakeOptions {
  /** The generated API manifest the source manifest names its operations in. */
  api: ServiceApiManifest
  /** Our records, written into the service's own shape by each entity's map; default `exampleContentRows()`. */
  rows?: FakeContentRows
  /** Each page holds at most this many rows, whatever limit the call asks: a small page makes every list page. */
  pageSize?: number
  /** The service's clock, for the change time a write stamps. */
  clock?: () => number
}

export interface ContentManifestFake {
  /** Reads as `serviceApiCall` sends them, with the answer's headers through `withHeaders`. */
  call: ((operation: string, input: ApiCommandInput) => Promise<unknown>) & {
    withHeaders: (operation: string, input: ApiCommandInput) => Promise<{ body: unknown; headers: Headers }>
  }
  /** Writes as `serviceApiWriter` sends them: the `write` a manifest writer takes. */
  write: (
    command: unknown,
    operation: string,
    input: ApiCommandInput,
    confirmed?: readonly string[],
  ) => Promise<{ operation_id: string; result: unknown }>
  /** The same service over HTTP, for a CLI's own commands: each request matched to its operation by method and path. */
  fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>
  /** Each kind's rows in the service's shape, by entity, as a test may change them. */
  rows: Partial<Record<ContentKind, Row[][]>>
  /** The ids of each kind's rows as the service holds them: what a contract's `held` names. */
  ids(kind: ContentKind): string[]
  /** The operations each write reached, in order. */
  writes: string[]
  /** Calls no route of the manifest makes: a source that sends one would fail on the real service. */
  refusals: string[]
  /** Moves a post's change time to now, as an edit elsewhere does. */
  touch(kind: ContentKind, id: string): void
  /** Moves a post to the trash, as the owner does in the service's own editor. */
  trash(id: string): void
  remove(kind: ContentKind, id: string): void
  loseNextAnswer(): void
}

const T0 = Date.parse("2026-11-01T10:00:00Z")
// A time with no offset: what `utcEpoch` reads as UTC, as WordPress's `*_gmt` fields are written.
const stamp = (ms: number) => new Date(ms).toISOString().slice(0, 19)
const digits = (id: string) => (/^\d+$/.test(id) ? Number(id) : Number(id.replace(/\D/g, "")) || id)

const pathOf = (rule: CrmRule | undefined): string | undefined => {
  if (rule === undefined || typeof rule === "function") return undefined
  if (typeof rule === "string") return rule
  if ("each" in rule || "value" in rule) return undefined
  if ("first" in rule) return rule.first[0]
  if ("join" in rule) return rule.join[0]
  if ("all" in rule) return rule.all[0]
  return rule.path
}

const put = (row: Row, path: string, value: unknown) => {
  const keys = path.split(".")
  const last = keys.pop() as string
  let inner = row
  for (const key of keys) {
    if (typeof inner[key] !== "object" || inner[key] === null || Array.isArray(inner[key])) inner[key] = {}
    inner = inner[key] as Row
  }
  inner[last] = value
}

const merged = (row: Row, body: Row) => {
  for (const [key, value] of Object.entries(body)) {
    const inner = row[key]
    if (value && typeof value === "object" && !Array.isArray(value) && inner && typeof inner === "object")
      merged(inner as Row, value as Row)
    else row[key] = structuredClone(value)
  }
}

/** The service's value a rule maps onto ours: a `map` rule's key whose value is ours. */
const sourceValue = (rule: CrmRule | undefined, ours: unknown): unknown => {
  if (rule && typeof rule === "object" && "map" in rule && rule.map)
    return Object.entries(rule.map).find(([, value]) => value === ours)?.[0] ?? ours
  return ours
}

const constantOf = (entity: ContentManifestEntity, field: string): unknown => {
  const rule = entity.map[field]
  return rule && typeof rule === "object" && "value" in rule ? rule.value : undefined
}

const fixedOf = (value: unknown, trail: readonly string[] = []): [string, string][] => {
  if (value && typeof value === "object")
    return Object.entries(value).flatMap(([key, inner]) => fixedOf(inner, [...trail, key]))
  if (value === undefined || /^\{\w+\}$/.test(String(value))) return []
  return [[trail.join("."), String(value)]]
}

const placeOf = (call: CrmOperationCall, placeholder: string) => {
  for (const where of ["path", "query"] as const)
    for (const [key, value] of Object.entries(call[where] ?? {}))
      if (value === placeholder) return { in: where, name: key }
  return undefined
}

const html = (markdown: string) =>
  `<p>${markdown.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/\*([^*]+)\*/g, "<em>$1</em>")}</p>`

const statusOf = (error: CliError) =>
  error.code === "not_found"
    ? 404
    : error.code === "permission_error"
      ? 403
      : error.code === "validation_error"
        ? 400
        : 500

/**
 * A content service in memory, built from a source manifest and the generated API it names. Our records are written
 * into each entity's shape by its map (the status by its `map`, a post's text by its body format), read back by the
 * calls the manifest names, paged by each operation's own pagination (the page count in its header where it has one,
 * a page past the end refused), and written by the manifest's writes. Service-neutral: a content CLI's own config
 * drives it, as `crmManifestFake` does a CRM's.
 */
export const contentManifestFake = (input: unknown, options: ContentManifestFakeOptions): ContentManifestFake => {
  const manifest: ContentManifest = parseContentManifest(input, options.api)
  const operations = new Map(options.api.operations.map((one) => [one.id, one]))
  const size = options.pageSize ?? 2
  let tick = 0
  const clock = options.clock ?? (() => T0 + 60_000 + tick++ * 1000)
  const given = options.rows ?? exampleContentRows()
  const writes: string[] = []
  const refusals: string[] = []
  let lose = false
  let made = 1000

  const entities = (kind: ContentKind) => manifest.entities[kind] ?? []
  // A record goes to the entity whose constant (a term's kind, a post's type) is its own; else the first.
  const entityIndex = (kind: ContentKind, record: Row) => {
    const field = kind === "term" ? "kind" : kind === "post" ? "type" : undefined
    const found = field ? entities(kind).findIndex((one) => constantOf(one, field) === record[field]) : -1
    return Math.max(found, 0)
  }
  const termPaths = manifest.writes?.fields.terms ?? {}
  const termKinds = new Map((given.term ?? []).map((one) => [one.externalId, one.kind]))

  const rawOf = (kind: ContentKind, entity: ContentManifestEntity, record: Row): Row => {
    const row: Row = {}
    const time = (value: unknown) => (typeof value === "number" ? stamp(value) : value)
    for (const [field, rule] of Object.entries(entity.map)) {
      const path = pathOf(rule)
      const value = record[field]
      if (path === undefined || value === undefined || value === null) continue
      if (field === "terms" && rule && typeof rule === "object" && "all" in rule) {
        for (const one of rule.all) put(row, one, [])
        for (const term of value as string[]) {
          const into = termPaths[termKinds.get(term) ?? "tag"] ?? rule.all[0]
          if (into) (at(row, into) as unknown[] | undefined)?.push(digits(term))
        }
        continue
      }
      // The source keeps one date where ours keeps two: the one this status has goes there.
      if (field === "publishedAt" && record.status === "scheduled") continue
      if (field === "version" && path === pathOf(entity.map.updatedAt)) continue
      const written =
        field === "externalId" || field === "parent"
          ? digits(String(value))
          : field === "authors" || field === "terms"
            ? (value as string[]).map(digits)
            : field.endsWith("At") || field === "scheduledFor"
              ? time(value)
              : sourceValue(rule, value)
      put(row, path, written)
    }
    if (kind === "post" && entity.body && typeof record.body === "string")
      put(row, entity.body.path, entity.body.format === "markdown" ? record.body : html(record.body))
    return row
  }

  const rows: Partial<Record<ContentKind, Row[][]>> = {}
  for (const kind of manifest.kinds) {
    rows[kind] = entities(kind).map(() => [])
    for (const record of (given[kind] ?? []) as unknown as Row[]) {
      const index = entityIndex(kind, record)
      const entity = entities(kind)[index]
      if (entity) rows[kind]?.[index]?.push(rawOf(kind, entity, record))
    }
  }

  const idOf = (entity: ContentManifestEntity, row: Row) => String(at(row, pathOf(entity.map.externalId) ?? "id"))
  const changedOf = (entity: ContentManifestEntity, row: Row) => {
    const path = entity.changes?.keyset?.field ?? pathOf(entity.map.updatedAt)
    const value = path === undefined ? undefined : at(row, path)
    return utcEpoch(value) ?? 0
  }
  const stampRow = (entity: ContentManifestEntity, row: Row) => {
    const path = entity.changes?.keyset?.field ?? pathOf(entity.map.updatedAt)
    if (path) put(row, path, stamp(clock()))
  }

  // Each call the manifest makes, by role; a request is the call whose fixed values it carries.
  type Route = {
    kind: ContentKind
    index: number
    role: "list" | "changes" | "get" | "requires"
    call: CrmOperationCall
  }
  const routes: Route[] = manifest.kinds.flatMap((kind) =>
    entities(kind).flatMap((entity, index) => [
      ...(entity.changes ? [{ kind, index, role: "changes" as const, call: entity.changes }] : []),
      ...(entity.get ? [{ kind, index, role: "get" as const, call: entity.get }] : []),
      { kind, index, role: "list" as const, call: entity.list },
      ...(entity.ids ? [{ kind, index, role: "list" as const, call: entity.ids }] : []),
      ...(entity.optional?.requires
        ? [{ kind, index, role: "requires" as const, call: entity.optional.requires }]
        : []),
    ]),
  )
  const carries = (route: Route, request: ApiCommandInput) => {
    const fixed = fixedOf({ path: route.call.path ?? {}, query: route.call.query ?? {} })
    const own = { path: request.path, query: request.query } as Row
    if (!fixed.every(([path, value]) => String(at(own, path)) === value)) return false
    for (const placeholder of ["{since}", "{id}"]) {
      const place = placeOf(route.call, placeholder)
      if (place && request[place.in][place.name] === undefined) return false
    }
    return true
  }

  const page = (operation: ManifestOperation, list: readonly Row[], request: ApiCommandInput) => {
    const pagination = operation.pagination
    if (!pagination) return { body: list, headers: new Headers() }
    const pageValue = (parameter: PageParameter) => {
      if (parameter.in !== "query")
        throw new CliError("configuration_error", `the content fake pages by a query parameter, not ${parameter.in}`)
      return request.query[parameter.name]
    }
    let from = 0
    let pages: number | undefined
    if (pagination.style === "page") {
      const start = pagination.start ?? 1
      const number = Number(pageValue(pagination.page) ?? start)
      pages = Math.max(1, Math.ceil(list.length / size))
      if (pagination.pagesHeader !== undefined && number - start + 1 > pages)
        throw new CliError("validation_error", "the page number is past the last page")
      from = (number - start) * size
    } else if (pagination.style === "offset") from = Number(pageValue(pagination.offset) ?? 0)
    else if (pagination.style === "cursor") from = Number(pageValue(pagination.cursor) ?? 0)
    else throw new CliError("configuration_error", `the content fake does not page by ${pagination.style}`)
    const items = list.slice(from, from + size)
    const headers = new Headers(
      pagination.style === "page" && pagination.pagesHeader ? { [pagination.pagesHeader]: String(pages) } : {},
    )
    if (pagination.items === "") return { body: items, headers }
    const body: Row = {}
    put(body, pagination.items ?? "items", items)
    if ("total" in pagination && pagination.total) put(body, pagination.total, list.length)
    if (pagination.style === "cursor") {
      const more = from + size < list.length
      put(body, pagination.next, more ? String(from + size) : "")
      if (pagination.hasMore) put(body, pagination.hasMore, more)
    }
    return { body, headers }
  }

  const read = async (operation: string, request: ApiCommandInput): Promise<{ body: unknown; headers: Headers }> => {
    const found = operations.get(operation)
    const route = routes.find((one) => one.call.operation === operation && carries(one, request))
    if (!found || !route) {
      refusals.push(operation)
      throw new CliError("configuration_error", `the content fake answers no ${operation} call like this`)
    }
    const entity = entities(route.kind)[route.index] as ContentManifestEntity
    const held = rows[route.kind]?.[route.index] ?? []
    if (route.role === "requires") {
      const body: Row = {}
      put(body, (route.call as CrmOperationCall & { check: string }).check, true)
      return { body, headers: new Headers() }
    }
    if (route.role === "get") {
      const place = placeOf(route.call, "{id}")
      const id = place ? request[place.in][place.name] : undefined
      const row = held.find((one) => idOf(entity, one) === String(id))
      if (!row) throw new CliError("not_found", `no ${route.kind} ${id}`)
      return { body: structuredClone(row), headers: new Headers() }
    }
    let list = [...held].sort((a, b) => Number(digits(idOf(entity, a))) - Number(digits(idOf(entity, b))))
    if (route.role === "changes" && entity.changes) {
      const place = placeOf(entity.changes, "{since}") as NonNullable<ReturnType<typeof placeOf>>
      const raw = String(request[place.in][place.name])
      const since =
        entity.changes.since === "iso" ? Date.parse(raw) : Number(raw) * (entity.changes.since === "seconds" ? 1000 : 1)
      if (Number.isNaN(since)) throw new CliError("validation_error", `${raw} is not a time`)
      list = held
        .filter((row) => changedOf(entity, row) > since)
        .sort((a, b) => changedOf(entity, a) - changedOf(entity, b))
    }
    return page(found, structuredClone(list), request)
  }

  const write = (operation: string, request: ApiCommandInput): unknown => {
    const ours = manifest.writes
    const [entity] = entities("post")
    const held = rows.post?.[0]
    if (!ours || !entity || !held) throw new CliError("configuration_error", "the source manifest writes no posts")
    const matches = (call: CrmOperationCall | undefined) =>
      call?.operation === operation &&
      fixedOf(call.query ?? {}).every(([key, value]) => String(request.query[key]) === value)
    const body = request.body ? (JSON.parse(request.body) as Row) : {}
    writes.push(operation)
    const find = () => {
      const place = placeOf(ours.update, "{id}") ?? { in: "path" as const, name: "id" }
      const id = request[place.in][place.name]
      const row = held.find((one) => idOf(entity, one) === String(id))
      if (!row) throw new CliError("not_found", `no post ${id}`)
      return row
    }
    let answer: unknown
    if (matches(ours.create)) {
      made += 1
      const row: Row = {}
      put(row, pathOf(entity.map.externalId) ?? "id", made)
      merged(row, body)
      stampRow(entity, row)
      held.push(row)
      answer = structuredClone(row)
    } else if (matches(ours.delete)) {
      const row = find()
      held.splice(held.indexOf(row), 1)
      answer = { deleted: true, previous: structuredClone(row) }
    } else if (matches(ours.trash)) {
      const row = find()
      const status = pathOf(entity.map.status)
      if (status) put(row, status, sourceValue(entity.map.status, "trashed"))
      stampRow(entity, row)
      answer = structuredClone(row)
    } else if (matches(ours.update)) {
      const row = find()
      merged(row, body)
      stampRow(entity, row)
      answer = structuredClone(row)
    } else {
      refusals.push(operation)
      throw new CliError("configuration_error", `the content fake takes no ${operation} write like this`)
    }
    if (lose) {
      lose = false
      throw new CliError("outcome_unknown", "the connection dropped after the service got the write")
    }
    return answer
  }

  const http = [...operations.values()].flatMap((operation) =>
    operation.binding.kind === "http"
      ? [
          {
            operation,
            method: operation.binding.method,
            names: [...operation.binding.path.matchAll(/\{(\w+)\}/g)].map((one) => one[1] as string),
            pattern: new RegExp(`${operation.binding.path.replace(/\{\w+\}/g, "([^/]+)")}$`),
          },
        ]
      : [],
  )
  const fetch = async (target: string | URL | Request, init?: RequestInit) => {
    const url = new URL(target instanceof Request ? target.url : target)
    const method = (init?.method ?? (target instanceof Request ? target.method : "GET")).toUpperCase()
    const found = http.find((one) => one.method === method && one.pattern.test(url.pathname))
    if (!found) {
      refusals.push(`${method} ${url.pathname}`)
      return Response.json({ message: "no such route" }, { status: 404 })
    }
    const values = url.pathname.match(found.pattern)?.slice(1) ?? []
    const request: ApiCommandInput = {
      path: Object.fromEntries(found.names.map((name, index) => [name, decodeURIComponent(values[index] ?? "")])),
      query: Object.fromEntries(url.searchParams),
      headers: {},
      fields: {},
      ...(typeof init?.body === "string" ? { body: init.body } : {}),
    }
    try {
      if (found.operation.effect === "read") {
        const answer = await read(found.operation.id, request)
        return Response.json(answer.body, { headers: answer.headers })
      }
      return Response.json(write(found.operation.id, request))
    } catch (error) {
      if (!(error instanceof CliError) || error.code === "outcome_unknown") throw error
      return Response.json({ message: error.message }, { status: statusOf(error) })
    }
  }

  const call = Object.assign(
    async (operation: string, request: ApiCommandInput) => (await read(operation, request)).body,
    {
      withHeaders: read,
    },
  )
  const locate = (kind: ContentKind, id: string) => {
    for (const [index, held] of (rows[kind] ?? []).entries()) {
      const entity = entities(kind)[index] as ContentManifestEntity
      const row = held.find((one) => idOf(entity, one) === id)
      if (row) return { entity, held, row }
    }
    return undefined
  }
  return {
    call,
    write: async (_command, operation, request) => ({
      operation_id: `op-${writes.length + 1}`,
      result: write(operation, request),
    }),
    fetch,
    rows,
    ids: (kind) =>
      (rows[kind] ?? []).flatMap((held, index) =>
        held.map((row) => idOf(entities(kind)[index] as ContentManifestEntity, row)),
      ),
    writes,
    refusals,
    touch(kind, id) {
      const found = locate(kind, id)
      if (found) stampRow(found.entity, found.row)
    },
    trash(id) {
      const found = locate("post", id)
      const status = found && pathOf(found.entity.map.status)
      if (!found || !status) return
      put(found.row, status, sourceValue(found.entity.map.status, "trashed"))
      stampRow(found.entity, found.row)
    },
    remove(kind, id) {
      const found = locate(kind, id)
      if (found) found.held.splice(found.held.indexOf(found.row), 1)
    },
    loseNextAnswer() {
      lose = true
    },
  }
}
