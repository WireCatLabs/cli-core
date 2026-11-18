import { CliError, isCliError } from "@wirecat/cli-base"
import type { PageParameter, Pagination } from "@wirecat/cli-base/codegen"
import type { ApiCommandInput } from "../../cli/bot/api.js"
import type { ServiceApiCall } from "../../cli/service-api-call.js"
import { nextPage, parameterValue, type ServiceApiManifest, withValue } from "../../cli/service-api-manifest.js"
import { crmValues } from "../../crm/index.js"
import type { CrmOperationCall } from "../../crm/manifest/manifest.js"
import { at, evaluate, MISSING } from "../../crm/manifest/map.js"
import type { ContentKind, ContentRecords } from "../../domain/content.js"
import type { ContentCallContext, ContentChanges, ContentIdPage, ContentSource } from "../source.js"
import { type ContentChangesCall, type ContentManifestEntity, parseContentManifest } from "./manifest.js"
import { mapContentRecord, postBodyOf, utcEpoch } from "./map.js"

/**
 * Sends one read. A call that can also answer the response's headers lets paging stop where the source says the
 * last page is (WordPress's `X-WP-TotalPages`).
 */
export type ContentReadCall = ServiceApiCall & {
  withHeaders?: (operation: string, input: ApiCommandInput) => Promise<{ body: unknown; headers: Headers }>
}

export interface ContentManifestSourceOptions {
  api: ServiceApiManifest
  call: ContentReadCall
  /** The site the profile signed in to, as it keeps it: `blog.example.com/news`. The channel's id and address. */
  site: string
  /** The site's name; the address when absent. */
  name?: string
  now?: () => number
}

const OVERLAP_MS = 10 * 60_000
const KEYSET_STEP = 1000

export interface Slots {
  since?: string
  id?: string
  at?: string
}

const DROP = Symbol("drop")

export const fill = (value: unknown, slots: Slots): unknown => {
  if (value === "{since}") return slots.since ?? DROP
  if (value === "{id}") return slots.id ?? DROP
  if (value === "{at}") return slots.at ?? DROP
  if (Array.isArray(value)) return value.map((one) => fill(one, slots)).filter((one) => one !== DROP)
  if (crmValues.isRaw(value))
    return Object.fromEntries(
      Object.entries(value).flatMap(([key, one]) => {
        const filled = fill(one, slots)
        return filled === DROP ? [] : [[key, filled]]
      }),
    )
  return value
}

export const inputOf = (call: CrmOperationCall, slots: Slots, body?: unknown): ApiCommandInput => {
  const path = fill(call.path ?? {}, slots) as Record<string, unknown>
  const query = fill(call.query ?? {}, slots) as Record<string, unknown>
  const sent = body ?? (call.body === undefined ? undefined : fill(call.body, slots))
  return {
    path: Object.fromEntries(Object.entries(path).map(([key, one]) => [key, String(one)])),
    query: Object.fromEntries(
      Object.entries(query).map(([key, one]) => [key, Array.isArray(one) ? one.join(",") : String(one)]),
    ),
    headers: {},
    fields: {},
    ...(sent === undefined || sent === DROP ? {} : { body: JSON.stringify(sent) }),
  }
}

const SINCE: Record<ContentChangesCall["since"], (ms: number) => string> = {
  iso: (ms) => `${new Date(ms).toISOString().slice(0, 19)}Z`,
  seconds: (ms) => String(Math.floor(ms / 1000)),
  ms: (ms) => String(ms),
}

const pageParameter = (pagination: Pagination) =>
  pagination.style === "cursor"
    ? pagination.cursor
    : pagination.style === "offset"
      ? pagination.offset
      : pagination.style === "page"
        ? pagination.page
        : undefined

/** `<call>.<token>@<when the round started>`: a round spread over runs ends with its first page's time. */
const pageOf = (page: string | undefined, now: number) => {
  const cut = page?.lastIndexOf("@") ?? -1
  const started = Number(page?.slice(cut + 1))
  if (page === undefined || cut < 0 || !Number.isSafeInteger(started))
    return { call: 0, token: undefined, started: now }
  const head = page.slice(0, cut)
  const dot = head.indexOf(".")
  const call = Number(dot < 0 ? head : head.slice(0, dot))
  const token = dot < 0 ? undefined : head.slice(dot + 1) || undefined
  return Number.isSafeInteger(call) && call >= 0 ? { call, token, started } : { call: -1, token: undefined, started }
}

/**
 * The source says in a header how many pages there are (WordPress's `X-WP-TotalPages`), and answers 400 for one past
 * them. Read here until `nextPage` reads the header itself (the api group's paging change).
 */
const lastPage = (pagination: Pagination, request: ApiCommandInput, parameter: PageParameter, headers: Headers) => {
  const header = pagination.style === "page" ? (pagination as { pagesHeader?: string }).pagesHeader : undefined
  const pages = header === undefined ? Number.NaN : Number(headers.get(header))
  const current = Number(parameterValue(request, parameter) ?? 1)
  return Number.isSafeInteger(pages) && headers.has(header ?? "") && current >= pages
}

const gone = (error: unknown) => isCliError(error) && error.code === "not_found"
const refused = (error: unknown) =>
  isCliError(error) && (error.code === "permission_error" || error.code === "not_found")

/**
 * A `ContentSource` read from a manifest: each kind by the calls it names, paged by each operation's own
 * `pagination`, each row mapped onto the content domain, a post's text turned into Markdown.
 */
export const contentSourceFromManifest = (input: unknown, options: ContentManifestSourceOptions): ContentSource => {
  const manifest = parseContentManifest(input, options.api)
  const now = options.now ?? Date.now
  const overlap = manifest.overlapMs ?? OVERLAP_MS
  const operations = new Map(options.api.operations.map((one) => [one.id, one]))

  const metered = (context?: ContentCallContext): ContentReadCall => {
    let paid = false
    const pay = () => {
      if (paid) context?.spend()
      paid = true
    }
    const send: ContentReadCall = (operation, request) => {
      pay()
      return options.call(operation, request)
    }
    if (options.call.withHeaders) {
      const withHeaders = options.call.withHeaders
      send.withHeaders = (operation, request) => {
        pay()
        return withHeaders(operation, request)
      }
    }
    return send
  }

  const readPage = async (call: CrmOperationCall, slots: Slots, token: string | undefined, send: ContentReadCall) => {
    const pagination = operations.get(call.operation)?.pagination
    const parameter = pagination && pageParameter(pagination)
    let request = inputOf(call, slots)
    if (token !== undefined && parameter)
      request = withValue(request, parameter, pagination.style === "cursor" ? token : Number(token))
    const read = send.withHeaders
      ? await send.withHeaders(call.operation, request)
      : { body: await send(call.operation, request), headers: new Headers() }
    const answer = read.body
    if (!pagination || !parameter) {
      const listed = call.items === undefined ? answer : at(answer, call.items)
      return { rows: crmValues.rawsOf(listed), next: undefined }
    }
    // `items: ""` is the answer itself, a list, which nextPage reads only under a name. WordPress answers 400 for a
    // page past the last: the page count is in a header, once nextPage reads it.
    const whole = pagination.style === "page" && pagination.items === ""
    const step = nextPage(
      whole ? { ...pagination, items: "items" } : pagination,
      request,
      whole ? { items: answer } : answer,
    )
    const rows = crmValues.rawsOf(call.items === undefined ? step.items : at(answer, call.items))
    const value = step.next && "input" in step.next ? parameterValue(step.next.input, parameter) : undefined
    if (value === undefined || value === null || lastPage(pagination, request, parameter, read.headers))
      return { rows, next: undefined }
    return { rows, next: String(value) }
  }

  const callsOf = (kind: ContentKind): readonly ContentManifestEntity[] => {
    const found = manifest.entities[kind]
    if (!found) throw new CliError("configuration_error", `the source manifest has no ${kind}`)
    return found
  }

  const mapped = async <K extends ContentKind>(
    kind: K,
    entity: ContentManifestEntity,
    rows: readonly crmValues.CrmRaw[],
  ) => {
    const records: ContentRecords[K][] = []
    for (const raw of rows) {
      const record = mapContentRecord(kind, entity.map, raw)
      if (record === null) continue
      if (kind === "post") Object.assign(record, { channel: options.site }, await postBodyOf(entity, raw))
      records.push(record)
    }
    return records
  }

  const gapOf = (kind: ContentKind, entity: ContentManifestEntity, error: unknown, context?: ContentCallContext) => {
    if (!entity.optional || !refused(error)) return false
    context?.gap({
      kind,
      message: entity.optional.message,
      ...(entity.optional.scope ? { scope: entity.optional.scope } : {}),
    })
    return true
  }

  /** One page of a change read sorted by modified time: the next page starts just before the last row's time. */
  const keysetPage = async (
    changes: ContentChangesCall & { keyset: NonNullable<ContentChangesCall["keyset"]> },
    since: number,
    send: ContentReadCall,
  ) => {
    const { rows, next } = await readPage(changes, { since: SINCE[changes.since](since) }, undefined, send)
    if (next === undefined) return { rows, next: undefined }
    const last = utcEpoch(at(rows.at(-1), changes.keyset.field))
    const from = last === null ? null : last - (changes.keyset.step ?? KEYSET_STEP)
    // A whole page at one time: only a full list reads past it.
    if (from === null || from <= since) return { reset: true as const }
    return { rows, next: String(from) }
  }

  const readChanges = async <K extends ContentKind>(
    kind: K,
    cursor: string | null,
    page: string | undefined,
    context?: ContentCallContext,
  ): Promise<ContentChanges<ContentRecords[K]>> => {
    const since = cursor === null ? null : Date.parse(cursor)
    if (since !== null && Number.isNaN(since)) return { reset: true }
    const calls = callsOf(kind)
    const spot = pageOf(page, now())
    const entity = calls[spot.call]
    if (!entity) return { reset: true }
    const send = metered(context)
    const changes = since === null ? undefined : entity.changes
    let read: { rows: crmValues.CrmRaw[]; next: string | undefined } | { reset: true }
    try {
      read =
        changes?.keyset && since !== null
          ? await keysetPage(
              { ...changes, keyset: changes.keyset },
              spot.token === undefined ? since - overlap : Number(spot.token),
              send,
            )
          : await readPage(
              changes ?? entity.list,
              changes && since !== null ? { since: SINCE[changes.since](since - overlap) } : {},
              spot.token,
              send,
            )
    } catch (error) {
      if (!gapOf(kind, entity, error, context)) throw error
      read = { rows: [], next: undefined }
    }
    if ("reset" in read) return { reset: true }
    const items = await mapped(kind, entity, read.rows)
    if (read.next !== undefined)
      return { items, hasMore: true, nextCursor: `${spot.call}.${read.next}@${spot.started}` }
    if (spot.call + 1 < calls.length) return { items, hasMore: true, nextCursor: `${spot.call + 1}.@${spot.started}` }
    return { items, hasMore: false, cursor: new Date(spot.started).toISOString() }
  }

  const readIds = async (kind: ContentKind, page: string | undefined, context?: ContentCallContext) => {
    const calls = callsOf(kind)
    const spot = pageOf(page, 0)
    const entity = calls[spot.call]
    if (!entity) throw new CliError("validation_error", `not a page of ${kind} ids: ${page}`)
    let read: { rows: crmValues.CrmRaw[]; next: string | undefined }
    try {
      read = await readPage(entity.ids ?? entity.list, {}, spot.token, metered(context))
    } catch (error) {
      // Refused, the ids read so far would mark every unread row deleted: the gap holds the pass.
      if (!gapOf(kind, entity, error, context)) throw error
      read = { rows: [], next: undefined }
    }
    const items = read.rows.flatMap((raw) => {
      const found = evaluate(entity.map.externalId as NonNullable<(typeof entity.map)["externalId"]>, raw)
      const externalId = found === MISSING ? null : crmValues.id(found)
      return externalId === null ? [] : [externalId]
    })
    const next =
      read.next !== undefined
        ? `${spot.call}.${read.next}@0`
        : spot.call + 1 < calls.length
          ? `${spot.call + 1}.@0`
          : undefined
    return next === undefined ? { items, hasMore: false } : { items, hasMore: true, nextCursor: next }
  }

  const readOne = async <K extends ContentKind>(kind: K, externalId: string, context?: ContentCallContext) => {
    const send = metered(context)
    for (const entity of callsOf(kind)) {
      if (!entity.get) continue
      let answer: unknown
      try {
        answer = await send(entity.get.operation, inputOf(entity.get, { id: externalId }))
      } catch (error) {
        // A post and a page share one id space; a 404 from one call may be the other's row.
        if (gone(error)) continue
        throw error
      }
      const raw = entity.get.items === undefined ? answer : at(answer, entity.get.items)
      if (crmValues.isRaw(raw)) return (await mapped(kind, entity, [raw]))[0] ?? null
    }
    return null
  }

  return {
    provider: manifest.provider,
    traits: { kinds: manifest.kinds, metrics: false },
    async channels() {
      return [
        {
          externalId: options.site,
          kind: manifest.channel.kind,
          network: manifest.channel.network,
          name: options.name ?? options.site,
          url: `https://${options.site}`,
        },
      ]
    },
    changes: readChanges,
    ids: (kind, page, context): Promise<ContentIdPage> => readIds(kind, page, context),
    get: readOne,
  }
}
