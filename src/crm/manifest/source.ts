import { CliError, isCliError } from "@wirecat/cli-base"
import type { Pagination } from "@wirecat/cli-base/codegen"
import type { ApiCommandInput } from "../../cli/bot/api.js"
import type { ServiceApiCall } from "../../cli/service-api-call.js"
import { nextPage, parameterValue, type ServiceApiManifest, withValue } from "../../cli/service-api-manifest.js"
import type { CrmField, CrmKind, CrmPipeline, CrmRecords, CrmUser } from "../../domain/crm.js"
import type { StageOutcome } from "../../domain/deals.js"
import type { CrmCallContext, CrmChanges, CrmIdPage, CrmLiveKind, CrmLiveQuery, CrmSource } from "../source.js"
import { type CrmRaw, id, isRaw, number, rawsOf, text } from "../values.js"
import { crmWindowOf, walk } from "../walk.js"
import {
  type CrmAfterHook,
  type CrmChangesCall,
  type CrmManifest,
  type CrmManifestFields,
  type CrmManifestHooks,
  type CrmManifestPipelines,
  type CrmOperationCall,
  parseCrmManifest,
} from "./manifest.js"
import { at, convert, evaluate, MISSING, mapFields, mapRecord, selectedOf } from "./map.js"

export interface CrmManifestSourceOptions {
  /** The generated API manifest the operations are named in: their paths, paging and sign-in. */
  api: ServiceApiManifest
  /** Sends one operation: `serviceApiCall` over the CLI's fetch and token, or a test's fake. */
  call: ServiceApiCall
  now?: () => number
  hooks?: CrmManifestHooks
}

const OVERLAP_MS = 10 * 60_000
/** The most rows a live list asks for in one request. */
const MOST_LIVE = 100
/** How far one read of every page goes: a service that never stops paging must not hold a sync forever. */
const MOST_PAGES = 500
/** Contacts or companies a deal names, read one by one, per page of a sync round. */
const LINKED_PAGE = 50

interface Slots {
  since?: string
  select?: readonly string[]
  id?: string
  query?: string
}

const DROP = Symbol("drop")

/** Fills `"{since}"`, `"{select}"`, `"{id}"` and `"{query}"`; an empty select drops the parameter it stands for. */
const fill = (value: unknown, slots: Slots): unknown => {
  if (value === "{since}") return slots.since ?? DROP
  if (value === "{select}") return slots.select?.length ? [...slots.select] : DROP
  if (value === "{id}") return slots.id ?? DROP
  if (value === "{query}") return slots.query ?? DROP
  if (Array.isArray(value)) return value.map((one) => fill(one, slots)).filter((one) => one !== DROP)
  if (isRaw(value))
    return Object.fromEntries(
      Object.entries(value).flatMap(([key, one]) => {
        const filled = fill(one, slots)
        return filled === DROP ? [] : [[key, filled]]
      }),
    )
  return value
}

const inputOf = (call: CrmOperationCall, slots: Slots): ApiCommandInput => {
  const path = fill(call.path ?? {}, slots) as Record<string, unknown>
  const query = fill(call.query ?? {}, slots) as Record<string, unknown>
  const body = call.body === undefined ? undefined : fill(call.body, slots)
  return {
    path: Object.fromEntries(Object.entries(path).map(([key, one]) => [key, String(one)])),
    query: Object.fromEntries(
      Object.entries(query).map(([key, one]) => [key, Array.isArray(one) ? one.join(",") : String(one)]),
    ),
    headers: {},
    fields: {},
    ...(body === undefined || body === DROP ? {} : { body: JSON.stringify(body) }),
  }
}

const SINCE: Record<CrmChangesCall["since"], (ms: number) => string> = {
  ms: (ms) => String(ms),
  seconds: (ms) => String(Math.floor(ms / 1000)),
  iso: (ms) => new Date(ms).toISOString(),
  datetime: (ms) => new Date(ms).toISOString().slice(0, 19).replace("T", " "),
}

const pageParameter = (pagination: Pagination) =>
  pagination.style === "cursor"
    ? pagination.cursor
    : pagination.style === "offset"
      ? pagination.offset
      : pagination.style === "page"
        ? pagination.page
        : undefined

/** `<the service's page token>@<when the round started>`: a round spread over runs ends with its first page's time. */
const pageOf = (page: string | undefined, now: number) => {
  const cut = page?.lastIndexOf("@") ?? -1
  const started = Number(page?.slice(cut + 1))
  if (page === undefined || cut < 0 || !Number.isSafeInteger(started)) return { token: undefined, started: now }
  return { token: page.slice(0, cut) || undefined, started }
}

const unseen = (error: unknown) =>
  isCliError(error) && (error.code === "not_found" || error.code === "permission_error")

/**
 * A `CrmSource` read from a manifest: every kind listed and read for changes by the operations it names, paged by each
 * operation's own `pagination`, each row mapped onto the shared schema. Deletions are found by a pass over every id.
 * What the manifest cannot say comes from `hooks`.
 */
export const crmSourceFromManifest = (input: unknown, options: CrmManifestSourceOptions): CrmSource => {
  const manifest: CrmManifest = parseCrmManifest(input, options.api)
  const now = options.now ?? Date.now
  const hooks = options.hooks ?? {}
  const overlap = manifest.overlapMs ?? OVERLAP_MS
  const operations = new Map(options.api.operations.map((one) => [one.id, one]))

  /** The engine paid for a call's first request; each further one is spent from the run's budget. */
  const metered = (context?: CrmCallContext): ServiceApiCall => {
    let paid = false
    return (operation, request) => {
      if (paid) context?.spend()
      paid = true
      return options.call(operation, request)
    }
  }

  /** One page: its rows, and the service's token for the next one, absent on the last. */
  const readPage = async (call: CrmOperationCall, slots: Slots, token: string | undefined, send: ServiceApiCall) => {
    const pagination = operations.get(call.operation)?.pagination
    const parameter = pagination && pageParameter(pagination)
    let request = inputOf(call, slots)
    if (token !== undefined && parameter)
      request = withValue(request, parameter, pagination.style === "cursor" ? token : Number(token))
    const answer = await send(call.operation, request)
    if (!pagination || !parameter) {
      const listed = call.items === undefined ? answer : at(answer, call.items)
      return { rows: rawsOf(listed), next: undefined }
    }
    const step = nextPage(pagination, request, answer)
    const rows = rawsOf(call.items === undefined ? step.items : at(answer, call.items))
    const value = step.next && "input" in step.next ? parameterValue(step.next.input, parameter) : undefined
    return { rows, next: value === undefined || value === null ? undefined : String(value) }
  }

  const readAll = async (call: CrmOperationCall, send: ServiceApiCall) => {
    const rows: CrmRaw[] = []
    let token: string | undefined
    for (let read = 0; read < MOST_PAGES; read += 1) {
      const page = await readPage(call, {}, token, send)
      for (const row of page.rows) rows.push(row)
      if (page.next === undefined) return rows
      token = page.next
    }
    throw new CliError("provider_error", `${call.operation} gave more than ${MOST_PAGES} pages`)
  }

  const entityOf = <K extends CrmKind>(kind: K) => {
    const found = manifest.entities[kind]
    if (!found) throw new CliError("configuration_error", `the source manifest has no ${kind}`)
    return found
  }

  const loaded = new Map<CrmKind, Promise<CrmField[]>>()
  /** A sign-in without the right to read field definitions still syncs its records, with no custom values. */
  const fieldsOf = (kind: CrmKind, send: ServiceApiCall, context?: CrmCallContext): Promise<CrmField[]> => {
    const spec = manifest.fields?.[kind]
    if (!spec) return Promise.resolve([])
    let found = loaded.get(kind)
    if (!found) {
      found = readAll(spec.call, send)
        .then((rows) => rows.flatMap((raw) => toField(spec, raw) ?? []))
        .catch((error: unknown) => {
          if (isCliError(error) && error.code === "permission_error") {
            gap(context, {
              kind,
              message: `the service refused the ${kind} field definitions: no custom values are read`,
            })
            return []
          }
          loaded.delete(kind)
          throw error
        })
      loaded.set(kind, found)
    }
    return found
  }

  /** Each gap once per call: a round of a hundred pages would otherwise store the same gap a hundred times. */
  const said = new WeakMap<CrmCallContext, Set<string>>()
  const gap = (context: CrmCallContext | undefined, one: Parameters<CrmCallContext["gap"]>[0]) => {
    if (!context) return
    const seen = said.get(context) ?? new Set<string>()
    said.set(context, seen)
    const key = `${one.kind} ${one.message}`
    if (seen.has(key)) return
    seen.add(key)
    context.gap(one)
  }

  /**
   * The names `{select}` asks for: every mapped one, then the account's own while they fit `max` (a request line past
   * about 8 KB is refused); the call says how many it left out.
   */
  const selectOf = (kind: CrmKind, defined: readonly CrmField[], context?: CrmCallContext) => {
    const entity = entityOf(kind)
    if (!entity.select) return []
    const own = [...new Set([...selectedOf(entity.map, entity.select.from), ...(entity.select.also ?? [])])]
    const custom = entity.custom?.from === entity.select.from ? defined.map(({ code }) => code) : []
    const { max } = entity.select
    if (max === undefined) return [...new Set([...own, ...custom])]
    const kept = [...own]
    let length = own.join(",").length
    for (const name of custom)
      if (!kept.includes(name) && length + name.length + 1 <= max) {
        kept.push(name)
        length += name.length + 1
      }
    const left = custom.filter((name) => !kept.includes(name)).length
    if (left)
      gap(context, {
        kind,
        message: `${left} of the account's own ${kind} fields do not fit one request and were not read`,
      })
    return kept
  }

  /** A refusal of a kind the manifest marks optional is a gap; the other kinds still sync. */
  const optionalRefused = (kind: CrmKind, error: unknown, context?: CrmCallContext) => {
    const optional = manifest.entities[kind]?.optional
    if (!optional || !unseen(error)) return false
    gap(context, { kind, message: optional.message, ...(optional.scope ? { scope: optional.scope } : {}) })
    return true
  }

  const mapped = async <K extends CrmKind>(
    kind: K,
    rows: readonly CrmRaw[],
    defined: readonly CrmField[],
    send: ServiceApiCall,
  ): Promise<CrmRecords[K][]> => {
    const entity = entityOf(kind)
    const after = hooks.after?.[kind] as CrmAfterHook<K> | undefined
    const enrich = hooks.enrich?.[kind]
    const records: CrmRecords[K][] = []
    for (const raw of enrich && rows.length ? await enrich([...rows], { call: send }) : rows) {
      const record = mapRecord(kind, entity, raw, defined)
      if (record !== null) records.push(after ? await after(record, raw, { call: send }) : record)
    }
    return records
  }

  /**
   * One page of a change read sorted by modified time: the next page starts at the last row's time, or further along
   * the same time when the whole page shares it. A service's own page token is an offset into a list that moves when
   * a row changes mid-round, and would skip the row behind it. Past `cap`, only a full list reads them all.
   */
  const keysetPage = async (
    changes: CrmChangesCall & { keyset: NonNullable<CrmChangesCall["keyset"]> },
    slots: Slots,
    since: number,
    token: string | undefined,
    send: ServiceApiCall,
  ) => {
    const [fromText, offsetText] = (token ?? "").split(".")
    const from = token === undefined ? since : Number(fromText)
    const offset = token === undefined ? 0 : Number(offsetText)
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(offset)) return { reset: true as const }
    const { rows, next } = await readPage(
      changes,
      { ...slots, since: SINCE[changes.since](from) },
      offset ? String(offset) : undefined,
      send,
    )
    if (next === undefined) return { rows, next: undefined }
    const last = convert("epoch", at(rows.at(-1), changes.keyset.field))
    const spot =
      typeof last === "number" && last > from ? { from: last, offset: 0 } : { from, offset: offset + rows.length }
    if (changes.keyset.cap !== undefined && spot.offset + rows.length > changes.keyset.cap)
      return { reset: true as const }
    return { rows, next: `${spot.from}.${spot.offset}` }
  }

  const readChanges = async <K extends CrmKind>(
    kind: K,
    cursor: string | null,
    page: string | undefined,
    context?: CrmCallContext,
  ): Promise<CrmChanges<CrmRecords[K]>> => {
    const entity = entityOf(kind)
    if (entity.linked && (kind === "person" || kind === "organization"))
      return (await readLinked(kind, page, context)) as CrmChanges<CrmRecords[K]>
    const since = cursor === null ? null : Date.parse(cursor)
    if (since !== null && Number.isNaN(since)) return { reset: true }
    const { token, started } = pageOf(page, now())
    const send = metered(context)
    const defined = entity.custom ? await fieldsOf(kind, send, context) : []
    const changes = since !== null ? entity.changes : undefined
    const slots: Slots = { select: selectOf(kind, defined, context) }
    const read =
      changes?.keyset && since !== null
        ? await keysetPage({ ...changes, keyset: changes.keyset }, slots, since - overlap, token, send)
        : await readPage(
            changes ?? entity.list,
            changes && since !== null ? { ...slots, since: SINCE[changes.since](since - overlap) } : slots,
            token,
            send,
          )
    if ("reset" in read) return { reset: true }
    const { rows, next } = read
    const items = await mapped(kind, rows, defined, send)
    return next === undefined
      ? { items, hasMore: false, cursor: new Date(started).toISOString() }
      : { items, hasMore: true, nextCursor: `${next}@${started}` }
  }

  const readOne = async <K extends CrmLiveKind>(
    kind: K,
    externalId: string,
    send: ServiceApiCall,
    context?: CrmCallContext,
  ): Promise<CrmRecords[K] | null> => {
    const entity = entityOf(kind)
    if (!entity.get) return null
    const defined = entity.custom ? await fieldsOf(kind, send, context) : []
    let answer: unknown
    try {
      answer = await send(
        entity.get.operation,
        inputOf(entity.get, { id: externalId, select: selectOf(kind, defined, context) }),
      )
    } catch (error) {
      if (unseen(error)) return null
      throw error
    }
    const raw = entity.get.items === undefined ? answer : at(answer, entity.get.items)
    return isRaw(raw) ? ((await mapped(kind, [raw], defined, send))[0] ?? null) : null
  }

  /** The contacts and companies the deals name, from one pass over the deals; deals the service refuses name none. */
  const linkedOf = async (send: ServiceApiCall, context?: CrmCallContext) => {
    const deal = entityOf("deal")
    const found = { person: new Set<string>(), organization: new Set<string>() }
    let rows: CrmRaw[]
    try {
      rows = await readAll(deal.list, send)
    } catch (error) {
      if (!optionalRefused("deal", error, context)) throw error
      rows = []
    }
    for (const raw of rows) {
      const record = mapRecord("deal", deal, raw, [])
      if (record?.organization) found.organization.add(record.organization)
      for (const one of record?.people ?? []) found.person.add(one.externalId)
    }
    return { person: [...found.person].sort(), organization: [...found.organization].sort() }
  }

  /** One pass per round: every page of the round reads the same list, so no id is skipped or read twice. */
  let round: { started: number; ids: ReturnType<typeof linkedOf> } | undefined
  const linkedRound = (started: number, send: ServiceApiCall, context?: CrmCallContext) => {
    if (round?.started !== started) {
      const ids = linkedOf(send, context)
      ids.catch(() => {
        if (round?.ids === ids) round = undefined
      })
      round = { started, ids }
    }
    return round.ids
  }

  const readLinked = async <K extends CrmLiveKind>(
    kind: K,
    page: string | undefined,
    context?: CrmCallContext,
  ): Promise<CrmChanges<CrmRecords[K]>> => {
    const { token, started } = pageOf(page, now())
    const from = token === undefined ? 0 : Number(token)
    if (!Number.isSafeInteger(from) || from < 0) return { reset: true }
    const send = metered(context)
    const ids = (await linkedRound(started, send, context))[kind]
    const items: CrmRecords[K][] = []
    for (const externalId of ids.slice(from, from + LINKED_PAGE)) {
      const one = await readOne(kind, externalId, send, context)
      if (one) items.push(one)
    }
    const next = from + LINKED_PAGE
    return next < ids.length
      ? { items, hasMore: true, nextCursor: `${next}@${started}` }
      : { items, hasMore: false, cursor: new Date(started).toISOString() }
  }

  const readIds = async (kind: CrmKind, page: string | undefined, context?: CrmCallContext): Promise<CrmIdPage> => {
    const entity = entityOf(kind)
    if (entity.linked && (kind === "person" || kind === "organization"))
      return { items: (await linkedOf(metered(context), context))[kind], hasMore: false }
    const { rows, next } = await readPage(entity.ids ?? entity.list, {}, page, metered(context))
    const items = rows.flatMap((raw) => {
      const found = evaluate(entity.map.externalId as NonNullable<typeof entity.map.externalId>, raw)
      const externalId = found === MISSING ? null : id(found)
      return externalId === null ? [] : [externalId]
    })
    return next === undefined ? { items, hasMore: false } : { items, hasMore: true, nextCursor: next }
  }

  const live = (["person", "organization"] as const).filter((kind) => manifest.entities[kind]?.search)

  /**
   * A live page of contacts or companies, newest first as the service sorts them: words read `search`, none `list`.
   * Only the words narrow it; a condition the manifest cannot send is refused rather than left out of the answer.
   */
  async function readLive<K extends CrmLiveKind>(kind: K, query: CrmLiveQuery, context?: CrmCallContext) {
    const entity = entityOf(kind)
    if (!entity.search)
      throw new CliError("validation_error", `${manifest.provider} reads no ${kind} live`, {
        reason: "query.unsupported-field",
      })
    if (query.conditions.length)
      throw new CliError(
        "validation_error",
        `${manifest.provider} narrows a live list only by words in the name, not by ${query.conditions.map(({ field }) => field).join(", ")}`,
        { reason: "query.unsupported-field" },
      )
    const words = query.text?.trim() || undefined
    const call = words ? entity.search : entity.list
    const send = metered(context)
    const defined = entity.custom ? await fieldsOf(kind, send, context) : []
    const slots: Slots = { select: selectOf(kind, defined, context), ...(words ? { query: words } : {}) }
    const pagination = operations.get(call.operation)?.pagination
    const largest = pagination?.style === "offset" ? MOST_LIVE : query.limit + 1
    const page = await walk(crmWindowOf(query), largest, async (offset, size) => {
      let request = inputOf(call, slots)
      if (pagination?.style === "offset") {
        request = withValue(request, pagination.offset, offset)
        if (pagination.limit) request = withValue(request, pagination.limit, size)
      }
      const answer = await send(call.operation, request)
      const items = call.items ?? (pagination && "items" in pagination ? pagination.items : undefined)
      const rows = rawsOf(items === undefined ? answer : at(answer, items))
      const all = pagination?.style === "offset" ? rows : rows.slice(offset, offset + size)
      // A short page is not the last: a service may cap a page below the size asked for; only an empty one ends it.
      // That costs one request past the last row, which losing the rows past a cap would not repay.
      return { rows: all, more: pagination?.style === "offset" ? rows.length > 0 : rows.length > offset + size }
    })
    return { ...page, items: await mapped(kind, page.items, defined, send) }
  }

  const base: CrmSource = {
    provider: manifest.provider,
    traits: { kinds: manifest.kinds, removedInChanges: false },

    async pipelines(kind, context) {
      const spec = manifest.pipelines?.[kind]
      if (!spec) return []
      const outcome = hooks.pipelines?.[kind]?.outcome
      try {
        const rows = await readAll(spec.call, metered(context))
        return groupsOf(spec, rows).flatMap(({ raw, stages }) => toPipeline(spec, raw, stages, outcome) ?? [])
      } catch (error) {
        if (optionalRefused(kind, error, context)) return []
        throw error
      }
    },

    async changes<K extends CrmKind>(
      kind: K,
      cursor: string | null,
      page?: string,
      context?: CrmCallContext,
    ): Promise<CrmChanges<CrmRecords[K]>> {
      try {
        return await readChanges(kind, cursor, page, context)
      } catch (error) {
        if (optionalRefused(kind, error, context)) return { items: [], hasMore: false, cursor: null }
        throw error
      }
    },

    async ids(kind, page, context): Promise<CrmIdPage> {
      try {
        return await readIds(kind, page, context)
      } catch (error) {
        // Refused part way through a pass, the ids read so far would mark every unread row deleted.
        if (page === undefined && optionalRefused(kind, error, context)) return { items: [], hasMore: false }
        throw error
      }
    },
    ...(live.length ? { list: readLive } : {}),

    async get<K extends CrmLiveKind>(kind: K, externalId: string, context?: CrmCallContext) {
      return readOne(kind, externalId, metered(context), context)
    },

    ...(manifest.fields
      ? { fields: (kind: CrmKind, context?: CrmCallContext) => fieldsOf(kind, metered(context), context) }
      : {}),

    ...(manifest.users
      ? {
          async users(context?: CrmCallContext): Promise<CrmUser[]> {
            const spec = manifest.users as NonNullable<CrmManifest["users"]>
            const rows = await readAll(spec.call, metered(context))
            const users = rows.flatMap((raw) => {
              const user = mapFields(
                spec.map,
                { externalId: "id", name: "text", email: "text", position: "text", active: "bool" },
                raw,
              )
              return typeof user.externalId === "string" ? [user as unknown as CrmUser] : []
            })
            return [...new Map(users.map((user) => [user.externalId, user])).values()]
          },
        }
      : {}),
  }
  return { ...base, ...hooks.extend?.(base, { call: options.call }) }
}

type OutcomeHook = (stage: CrmRaw, pipeline: CrmRaw, found: StageOutcome) => StageOutcome

const outcomeOf = (spec: CrmManifestPipelines["stages"]["outcome"], stage: CrmRaw, pipeline: CrmRaw): StageOutcome => {
  if (typeof spec === "function") return spec(stage, pipeline)
  if ("value" in spec) return spec.value
  const value = at(stage, spec.path)
  const found = typeof value === "boolean" ? String(value) : (text(value) ?? "")
  if (spec.won?.includes(found)) return "won"
  return spec.lost?.includes(found) ? "lost" : "open"
}

/**
 * Each pipeline's row and its stages. A call that answers stages (`each` `.`) is grouped by `stages.pipeline`, or is
 * one pipeline; its first stage is the row the pipeline's own map reads.
 */
const groupsOf = (spec: CrmManifestPipelines, rows: readonly CrmRaw[]) => {
  if (spec.stages.each !== ".") return rows.map((raw) => ({ raw, stages: rawsOf(at(raw, spec.stages.each)) }))
  const by = spec.stages.pipeline
  const groups = new Map<string, CrmRaw[]>()
  for (const row of rows) {
    const key = by === undefined ? "" : (id(at(row, by)) ?? "")
    groups.set(key, [...(groups.get(key) ?? []), row])
  }
  return [...groups.values()].map((stages) => ({ raw: stages[0] as CrmRaw, stages }))
}

const toPipeline = (
  spec: CrmManifestPipelines,
  raw: CrmRaw,
  stages: readonly CrmRaw[],
  hook?: OutcomeHook,
): CrmPipeline | null => {
  const { externalId, name } = mapFields(spec.map, { externalId: "id", name: "text" }, raw)
  if (typeof externalId !== "string") return null
  return {
    externalId,
    name: typeof name === "string" ? name : externalId,
    stages: stages.flatMap((stage, place) => {
      const found = mapFields(spec.stages.map, { externalId: "id", name: "text", position: "text" }, stage)
      if (typeof found.externalId !== "string") return []
      return [
        {
          externalId: found.externalId,
          name: typeof found.name === "string" ? found.name : found.externalId,
          position: number(found.position) ?? place,
          outcome: hook
            ? hook(stage, raw, outcomeOf(spec.stages.outcome, stage, raw))
            : outcomeOf(spec.stages.outcome, stage, raw),
        },
      ]
    }),
  }
}

const toField = (spec: CrmManifestFields, raw: CrmRaw): CrmField | null => {
  if (spec.keep && !(typeof spec.keep === "function" ? spec.keep(raw) : at(raw, spec.keep.path) === spec.keep.is))
    return null
  const { options: optionsRule, ...rules } = spec.map
  const found = mapFields(
    rules,
    { code: "text", label: "text", type: "text", multiple: "bool", filterable: "bool" },
    raw,
  )
  if (typeof found.code !== "string") return null
  const options =
    typeof optionsRule === "function"
      ? optionsRule(raw)
      : optionsRule === undefined
        ? undefined
        : rawsOf(at(raw, optionsRule.each)).flatMap((one) => {
            const option = convert("text", at(one, optionsRule.id))
            return typeof option === "string" ? [{ id: option, label: text(at(one, optionsRule.label)) ?? option }] : []
          })
  return {
    code: found.code,
    label: typeof found.label === "string" ? found.label : null,
    type: typeof found.type === "string" ? found.type : "string",
    multiple: found.multiple === true,
    filterable: found.filterable !== false,
    ...(options?.length ? { options: [...new Map(options.map((one) => [one.id, one])).values()] } : {}),
  }
}
