import { CliError, isCliError } from "@wirecat/cli-base"
import type { Pagination } from "@wirecat/cli-base/codegen"
import type { ApiCommandInput } from "../../cli/bot/api.js"
import type { ServiceApiCall } from "../../cli/service-api-call.js"
import { nextPage, parameterValue, type ServiceApiManifest, withValue } from "../../cli/service-api-manifest.js"
import { crmValues } from "../../crm/index.js"
import { at, convert, evaluate, MISSING } from "../../crm/manifest/map.js"
import type { TrackerKind, TrackerRecords } from "../../domain/tracker.js"
import type { TrackerCallContext, TrackerChanges, TrackerIdPage, TrackerSource } from "../source.js"
import {
  parseTrackerManifest,
  type TrackerAfterHook,
  type TrackerChangesCall,
  type TrackerManifest,
  type TrackerManifestHooks,
  type TrackerOperationCall,
} from "./manifest.js"
import { mapTrackerRecord } from "./map.js"

export interface TrackerManifestSourceOptions {
  /** The generated API manifest the operations are named in: their bindings, paging and sign-in. */
  api: ServiceApiManifest
  /** Sends one operation: `serviceApiCall` over the CLI's fetch and token, or a test's fake. */
  call: ServiceApiCall
  now?: () => number
  hooks?: TrackerManifestHooks
}

const OVERLAP_MS = 10 * 60_000

const DROP = Symbol("drop")

/** What the engine puts in a call's variables: `"{since}"`, and a write's `"{id}"` and `"{values}"`. */
export interface TrackerSlots {
  since?: string
  id?: string
  values?: Readonly<Record<string, unknown>>
}

const SLOT = /^\{(since|id|values)\}$/

// A slot's value goes in as it is, never filled again: an owner's title may say "{since}".
const fill = (value: unknown, slots: TrackerSlots): unknown => {
  const slot = typeof value === "string" ? SLOT.exec(value)?.[1] : undefined
  if (slot !== undefined) return slots[slot as keyof TrackerSlots] ?? DROP
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

/** The variables travel as the body: each GraphQL argument is a body parameter of the operation. */
export const trackerInputOf = (call: TrackerOperationCall, slots: TrackerSlots = {}): ApiCommandInput => ({
  path: {},
  query: {},
  headers: {},
  fields: {},
  ...(call.variables ? { body: JSON.stringify(fill(call.variables, slots)) } : {}),
  ...(call.selection ? { selection: call.selection } : {}),
})

const SINCE: Record<TrackerChangesCall["since"], (ms: number) => string> = {
  iso: (ms) => new Date(ms).toISOString(),
  ms: (ms) => String(ms),
  seconds: (ms) => String(Math.floor(ms / 1000)),
}

const cursorParameter = (pagination: Pagination) =>
  pagination.style === "cursor"
    ? pagination.cursor
    : pagination.style === "offset"
      ? pagination.offset
      : pagination.style === "page"
        ? pagination.page
        : undefined

/** `<the tracker's page token>@<when the round started>`: a round spread over runs ends with its first page's time. */
const pageOf = (page: string | undefined, now: number) => {
  const cut = page?.lastIndexOf("@") ?? -1
  const started = Number(page?.slice(cut + 1))
  if (page === undefined || cut < 0 || !Number.isSafeInteger(started)) return { token: undefined, started: now }
  return { token: page.slice(0, cut) || undefined, started }
}

/**
 * A `TrackerSource` read from a manifest: each kind listed and read for changes by the operations it names, paged by
 * each operation's own `pagination`, each row mapped onto the tracker domain. Deletions are found by a pass over
 * every id. What the manifest cannot say comes from `hooks`.
 */
export const trackerSourceFromManifest = (input: unknown, options: TrackerManifestSourceOptions): TrackerSource => {
  const manifest: TrackerManifest = parseTrackerManifest(input, options.api)
  const now = options.now ?? Date.now
  const hooks = options.hooks ?? {}
  const overlap = manifest.overlapMs ?? OVERLAP_MS
  const operations = new Map(options.api.operations.map((one) => [one.id, one]))

  /** The engine paid for a call's first request; each further one is spent from the run's budget. */
  const metered = (context?: TrackerCallContext): ServiceApiCall => {
    let paid = false
    return (operation, request) => {
      if (paid) context?.spend()
      paid = true
      return options.call(operation, request)
    }
  }

  const readPage = async (
    call: TrackerOperationCall,
    since: string | undefined,
    token: string | undefined,
    send: ServiceApiCall,
  ) => {
    const pagination = operations.get(call.operation)?.pagination
    const parameter = pagination && cursorParameter(pagination)
    let request: ApiCommandInput = trackerInputOf(call, since === undefined ? {} : { since })
    if (token !== undefined && parameter)
      request = { ...withValue(request, parameter, pagination.style === "cursor" ? token : Number(token)) }
    const answer = await send(call.operation, request)
    if (!pagination || !parameter) {
      const listed = call.items === undefined ? answer : at(answer, call.items)
      return { rows: crmValues.rawsOf(listed), next: undefined }
    }
    const step = nextPage(pagination, request, answer)
    const rows = crmValues.rawsOf(call.items === undefined ? step.items : at(answer, call.items))
    const value = step.next && "input" in step.next ? parameterValue(step.next.input, parameter) : undefined
    return { rows, next: value === undefined || value === null ? undefined : String(value) }
  }

  const entityOf = (kind: TrackerKind) => {
    const found = manifest.entities[kind]
    if (!found) throw new CliError("configuration_error", `the source manifest has no ${kind}`)
    return found
  }

  /** A refusal of a kind the manifest marks optional is a gap; the other kinds still sync. */
  const optionalRefused = (kind: TrackerKind, error: unknown, context?: TrackerCallContext) => {
    const optional = manifest.entities[kind]?.optional
    if (!optional || !isCliError(error) || error.code !== "permission_error") return false
    context?.gap({ kind, message: optional.message, ...(optional.scope ? { scope: optional.scope } : {}) })
    return true
  }

  const mapped = async <K extends TrackerKind>(kind: K, rows: readonly crmValues.CrmRaw[], send: ServiceApiCall) => {
    const entity = entityOf(kind)
    const after = hooks.after?.[kind] as TrackerAfterHook<K> | undefined
    const records: TrackerRecords[K][] = []
    for (const raw of rows) {
      const record = mapTrackerRecord(kind, entity.map, raw)
      if (record !== null) records.push(after ? await after(record, raw, { call: send }) : record)
    }
    return records
  }

  const readChanges = async <K extends TrackerKind>(
    kind: K,
    cursor: string | null,
    page: string | undefined,
    context?: TrackerCallContext,
  ): Promise<TrackerChanges<TrackerRecords[K]>> => {
    const entity = entityOf(kind)
    const since = cursor === null ? null : Date.parse(cursor)
    if (since !== null && Number.isNaN(since)) return { reset: true }
    const { token, started } = pageOf(page, now())
    const send = metered(context)
    const changes = since !== null ? entity.changes : undefined
    const { rows, next } = await readPage(
      changes ?? entity.list,
      changes && since !== null ? SINCE[changes.since](since - overlap) : undefined,
      token,
      send,
    )
    const items = await mapped(kind, rows, send)
    return next === undefined
      ? { items, hasMore: false, cursor: new Date(started).toISOString() }
      : { items, hasMore: true, nextCursor: `${next}@${started}` }
  }

  const readIds = async (kind: TrackerKind, page: string | undefined, context?: TrackerCallContext) => {
    const entity = entityOf(kind)
    const { rows, next } = await readPage(entity.ids ?? entity.list, undefined, page, metered(context))
    const rule = entity.map.externalId as NonNullable<typeof entity.map.externalId>
    const { deleted } = entity.map
    const items = rows.flatMap((raw) => {
      // Linear's trash moves no updatedAt, so only this pass sees a trashed row: leaving it out marks it deleted.
      if (deleted !== undefined && convert("bool", evaluate(deleted, raw)) === true) return []
      const found = evaluate(rule, raw)
      const externalId = found === MISSING ? null : crmValues.id(found)
      return externalId === null ? [] : [externalId]
    })
    return next === undefined ? { items, hasMore: false } : { items, hasMore: true, nextCursor: next }
  }

  const base: TrackerSource = {
    provider: manifest.provider,
    traits: { kinds: manifest.kinds },
    async changes<K extends TrackerKind>(kind: K, cursor: string | null, page?: string, context?: TrackerCallContext) {
      try {
        return await readChanges(kind, cursor, page, context)
      } catch (error) {
        if (optionalRefused(kind, error, context)) return { items: [], hasMore: false, cursor: null }
        throw error
      }
    },
    async ids(kind, page, context): Promise<TrackerIdPage> {
      try {
        return await readIds(kind, page, context)
      } catch (error) {
        // Refused part way through a pass, the ids read so far would mark every unread row deleted.
        if (page === undefined && optionalRefused(kind, error, context)) return { items: [], hasMore: false }
        throw error
      }
    },
    ...(manifest.self
      ? {
          async self(context?: TrackerCallContext) {
            const self = manifest.self as NonNullable<TrackerManifest["self"]>
            const found = crmValues.id(
              at(await metered(context)(self.call.operation, trackerInputOf(self.call)), self.path),
            )
            if (found === null) throw new CliError("invalid_response", `${manifest.provider} named no signed-in user`)
            return found
          },
        }
      : {}),
  }
  return { ...base, ...hooks.extend?.(base) }
}
