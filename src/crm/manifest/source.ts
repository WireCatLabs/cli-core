import { CliError, isCliError } from "@wirecat/cli-base"
import type { Pagination } from "@wirecat/cli-base/codegen"
import type { ApiCommandInput } from "../../cli/bot/api.js"
import type { ServiceApiCall } from "../../cli/service-api-call.js"
import { nextPage, parameterValue, type ServiceApiManifest, withValue } from "../../cli/service-api-manifest.js"
import type { CrmField, CrmKind, CrmPipeline, CrmRecords, CrmUser } from "../../domain/crm.js"
import type { StageOutcome } from "../../domain/deals.js"
import type { CrmCallContext, CrmChanges, CrmIdPage, CrmLiveKind, CrmSource } from "../source.js"
import { type CrmRaw, id, isRaw, number, rawsOf, text } from "../values.js"
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
/** How far one read of every page goes: a service that never stops paging must not hold a sync forever. */
const MOST_PAGES = 500

interface Slots {
  since?: string
  select?: readonly string[]
  id?: string
}

const DROP = Symbol("drop")

/** Fills `"{since}"`, `"{select}"` and `"{id}"`; an empty select drops the parameter it stands for. */
const fill = (value: unknown, slots: Slots): unknown => {
  if (value === "{since}") return slots.since ?? DROP
  if (value === "{select}") return slots.select?.length ? [...slots.select] : DROP
  if (value === "{id}") return slots.id ?? DROP
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
            context?.gap({
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

  const selectOf = (kind: CrmKind, defined: readonly CrmField[]) => {
    const entity = entityOf(kind)
    if (!entity.select) return []
    const custom = entity.custom?.from === entity.select.from ? defined.map(({ code }) => code) : []
    return [...new Set([...selectedOf(entity.map, entity.select.from), ...custom, ...(entity.select.also ?? [])])]
  }

  const mapped = async <K extends CrmKind>(
    kind: K,
    rows: readonly CrmRaw[],
    defined: readonly CrmField[],
    send: ServiceApiCall,
  ): Promise<CrmRecords[K][]> => {
    const entity = entityOf(kind)
    const after = hooks.after?.[kind] as CrmAfterHook<K> | undefined
    const records: CrmRecords[K][] = []
    for (const raw of rows) {
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

  const base: CrmSource = {
    provider: manifest.provider,
    traits: { kinds: manifest.kinds, removedInChanges: false },

    async pipelines(kind, context) {
      const spec = manifest.pipelines?.[kind]
      if (!spec) return []
      const rows = await readAll(spec.call, metered(context))
      return rows.flatMap((raw) => toPipeline(spec, raw) ?? [])
    },

    async changes<K extends CrmKind>(
      kind: K,
      cursor: string | null,
      page?: string,
      context?: CrmCallContext,
    ): Promise<CrmChanges<CrmRecords[K]>> {
      const entity = entityOf(kind)
      const since = cursor === null ? null : Date.parse(cursor)
      if (since !== null && Number.isNaN(since)) return { reset: true }
      const { token, started } = pageOf(page, now())
      const send = metered(context)
      const defined = entity.custom ? await fieldsOf(kind, send, context) : []
      const changes = since !== null ? entity.changes : undefined
      const slots: Slots = { select: selectOf(kind, defined) }
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
    },

    async ids(kind, page, context): Promise<CrmIdPage> {
      const entity = entityOf(kind)
      const { rows, next } = await readPage(entity.ids ?? entity.list, {}, page, metered(context))
      const items = rows.flatMap((raw) => {
        const found = evaluate(entity.map.externalId as NonNullable<typeof entity.map.externalId>, raw)
        const externalId = found === MISSING ? null : id(found)
        return externalId === null ? [] : [externalId]
      })
      return next === undefined ? { items, hasMore: false } : { items, hasMore: true, nextCursor: next }
    },

    async get<K extends CrmLiveKind>(kind: K, externalId: string, context?: CrmCallContext) {
      const entity = entityOf(kind)
      if (!entity.get) return null
      const send = metered(context)
      const defined = entity.custom ? await fieldsOf(kind, send, context) : []
      let answer: unknown
      try {
        answer = await send(
          entity.get.operation,
          inputOf(entity.get, { id: externalId, select: selectOf(kind, defined) }),
        )
      } catch (error) {
        if (unseen(error)) return null
        throw error
      }
      const raw = entity.get.items === undefined ? answer : at(answer, entity.get.items)
      return isRaw(raw) ? ((await mapped(kind, [raw], defined, send))[0] ?? null) : null
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
  return { ...base, ...hooks.extend?.(base) }
}

const outcomeOf = (spec: CrmManifestPipelines["stages"]["outcome"], stage: CrmRaw, pipeline: CrmRaw): StageOutcome => {
  if (typeof spec === "function") return spec(stage, pipeline)
  if ("value" in spec) return spec.value
  const found = text(at(stage, spec.path)) ?? ""
  if (spec.won?.includes(found)) return "won"
  return spec.lost?.includes(found) ? "lost" : "open"
}

const toPipeline = (spec: CrmManifestPipelines, raw: CrmRaw): CrmPipeline | null => {
  const { externalId, name } = mapFields(spec.map, { externalId: "id", name: "text" }, raw)
  if (typeof externalId !== "string") return null
  return {
    externalId,
    name: typeof name === "string" ? name : externalId,
    stages: rawsOf(at(raw, spec.stages.each)).flatMap((stage, place) => {
      const found = mapFields(spec.stages.map, { externalId: "id", name: "text", position: "text" }, stage)
      if (typeof found.externalId !== "string") return []
      return [
        {
          externalId: found.externalId,
          name: typeof found.name === "string" ? found.name : found.externalId,
          position: number(found.position) ?? place,
          outcome: outcomeOf(spec.stages.outcome, stage, raw),
        },
      ]
    }),
  }
}

const toField = (spec: CrmManifestFields, raw: CrmRaw): CrmField | null => {
  if (spec.keep && !spec.keep(raw)) return null
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
