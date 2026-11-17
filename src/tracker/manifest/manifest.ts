import { CliError } from "@wirecat/cli-base"
import { parseSelection, type Selection } from "@wirecat/cli-base/codegen"
import * as v from "valibot"
import type { ServiceApiCall } from "../../cli/service-api-call.js"
import type { ServiceApiManifest } from "../../cli/service-api-manifest.js"
import type { crmValues } from "../../crm/index.js"
import { type CrmRule, crmRuleSchema } from "../../crm/manifest/manifest.js"
import { rulePaths } from "../../crm/manifest/map.js"
import { TRACKER_KINDS, type TrackerKind, type TrackerRecords } from "../../domain/tracker.js"
import { editDistance } from "../../search/correct.js"
import type { TrackerSource } from "../source.js"
import { TRACKER_FIELDS } from "./map.js"

/**
 * One request: an operation of the generated API manifest by its id, with fixed variables. A string `"{since}"`
 * anywhere in `variables` is filled in by the engine. `selection` replaces a GraphQL operation's default one: a
 * tracker reads deeper than one level (`state { id }`, `labels { nodes { id } }`).
 */
export interface TrackerOperationCall {
  operation: string
  variables?: Readonly<Record<string, unknown>>
  selection?: string
  /** Where the answer's rows are when the operation has no `pagination`; absent, the answer itself is the list. */
  items?: string
}

export interface TrackerChangesCall extends TrackerOperationCall {
  /** How `{since}` is written: ISO, or epoch ms or seconds as digits. */
  since: "iso" | "ms" | "seconds"
}

export interface TrackerManifestEntity<K extends TrackerKind = TrackerKind> {
  /** Every row of the kind, archived ones too, page by page by the operation's own `pagination`. */
  list: TrackerOperationCall
  /** Rows changed since `{since}`, the last cursor less the overlap; absent, every sync lists in full. */
  changes?: TrackerChangesCall
  /** Every id, archived ones too, to find deletions; absent, `list`. Give one that selects only the id. */
  ids?: TrackerOperationCall
  map: { readonly [F in keyof TrackerRecords[K]]?: CrmRule }
  /** A kind the plan or the sign-in may not have: its refusal is a gap with this text, and the others still sync. */
  optional?: { message: string; scope?: string }
}

/** A tracker account described as data: what to call for each kind and where each of our fields is in the answer. */
export interface TrackerManifest {
  /** The registry name: `linear`. */
  provider: string
  /** In `TRACKER_KINDS` order: teams and states before the issues on them. */
  kinds: readonly TrackerKind[]
  /** Re-read before the last cursor: rows saved while the round ran, and a clock running ahead. Default 10 min. */
  overlapMs?: number
  entities: { readonly [K in TrackerKind]?: TrackerManifestEntity<K> }
  /** The sign-in's own user id: `viewer { id }`. */
  self?: { call: TrackerOperationCall; path: string }
}

/** Corrects one record after the map; `call` reads more from the service, spent from the run's budget. */
export type TrackerAfterHook<K extends TrackerKind> = (
  record: TrackerRecords[K],
  raw: crmValues.CrmRaw,
  service: { call: ServiceApiCall },
) => TrackerRecords[K] | Promise<TrackerRecords[K]>

/** Code a tracker needs beyond what the manifest says. */
export interface TrackerManifestHooks {
  after?: { readonly [K in TrackerKind]?: TrackerAfterHook<K> }
  /** Adds or replaces source methods; `base` is what the manifest built. */
  extend?: (base: TrackerSource) => Partial<TrackerSource>
}

const path = v.pipe(v.string(), v.regex(/^[^.\s]+(\.[^.\s]+)*$/, "a dotted path such as state.id"))

const call = v.strictObject({
  operation: v.pipe(v.string(), v.minLength(1)),
  variables: v.optional(v.record(v.string(), v.unknown())),
  selection: v.optional(v.pipe(v.string(), v.minLength(1))),
  items: v.optional(path),
})

const kind = v.picklist(TRACKER_KINDS)

const schema = v.strictObject({
  provider: v.pipe(v.string(), v.regex(/^[a-z][a-z0-9-]*$/, "a registry name such as linear")),
  kinds: v.pipe(v.array(kind), v.minLength(1)),
  overlapMs: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
  entities: v.record(
    kind,
    v.optional(
      v.strictObject({
        list: call,
        changes: v.optional(v.strictObject({ ...call.entries, since: v.picklist(["iso", "ms", "seconds"]) })),
        ids: v.optional(call),
        map: v.record(v.string(), crmRuleSchema),
        optional: v.optional(
          v.strictObject({ message: v.pipe(v.string(), v.minLength(1)), scope: v.optional(v.string()) }),
        ),
      }),
    ),
  ),
  self: v.optional(v.strictObject({ call, path })),
})

const invalid = (where: string, message: string) =>
  new CliError("configuration_error", `source manifest: ${where}: ${message}`, { reason: "manifest.invalid" })

const nearest = (wanted: string, known: readonly string[]) =>
  known
    .map((one) => ({ one, edits: editDistance(wanted, one, 2) }))
    .filter(({ edits }) => edits <= 2)
    .sort((a, b) => a.edits - b.edits)[0]?.one

const hasSince = (value: unknown): boolean =>
  value === "{since}" ||
  (Array.isArray(value) && value.some(hasSince)) ||
  (typeof value === "object" && value !== null && Object.values(value).some(hasSince))

/** The selection a call sends, as a tree: its own, else the operation's default; none for an operation over HTTP. */
export const selectionOf = (one: TrackerOperationCall, api: ServiceApiManifest): Selection | undefined => {
  const binding = api.operations.find((operation) => operation.id === one.operation)?.binding
  if (binding?.kind !== "graphql") return undefined
  return parseSelection(one.selection ?? binding.selection)
}

/** Whether `path`, read in a row, is selected: each step a field the selection names, and a leaf where it ends. */
const selects = (tree: Selection, steps: readonly string[]): boolean => {
  const [first, ...rest] = steps
  if (first === undefined) return true
  if (/^\d+$/.test(first)) return selects(tree, rest)
  const found = tree[first]
  if (found === undefined) return false
  return found === true ? rest.every((step) => /^\d+$/.test(step)) : selects(found, rest)
}

/** The selection of one row: under the operation's `items` (a connection's `nodes`) or the call's own. */
const rowSelection = (tree: Selection, items: string | undefined): Selection | undefined => {
  let inside: Selection | true | undefined = tree
  for (const step of items?.split(".") ?? []) inside = inside === true ? undefined : inside?.[step]
  return inside === true ? undefined : inside
}

/**
 * The manifest checked against its shape and the generated API: each operation exists and reads, a list pages or
 * says where its rows are, a change call places `{since}`, and over GraphQL every path the map reads is selected, so
 * a field is never left out of a request by mistake and read as "the tracker cleared it". Every error names where.
 */
export const parseTrackerManifest = (input: unknown, api: ServiceApiManifest): TrackerManifest => {
  const parsed = v.safeParse(schema, input)
  if (!parsed.success) {
    const [issue] = parsed.issues
    throw invalid(v.getDotPath(issue) ?? "(root)", issue.message)
  }
  const manifest = parsed.output as TrackerManifest
  const order = manifest.kinds.map((one) => TRACKER_KINDS.indexOf(one))
  if (order.some((at, index) => index > 0 && at <= (order[index - 1] as number)))
    throw invalid("kinds", `list them once each, in this order: ${TRACKER_KINDS.join(", ")}`)
  const operations = new Map(api.operations.map((one) => [one.id, one]))
  const known = [...operations.keys()]
  const checkCall = (where: string, one: TrackerOperationCall, map?: Readonly<Record<string, CrmRule | undefined>>) => {
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
    if (operation.pagination && operation.pagination.style === "link")
      throw invalid(`${where}.operation`, `${one.operation} pages by a link, which a source does not read yet`)
    let tree: Selection | undefined
    try {
      tree = selectionOf(one, api)
    } catch (error) {
      throw invalid(`${where}.selection`, error instanceof Error ? error.message : String(error))
    }
    if (one.selection !== undefined && tree === undefined)
      throw invalid(`${where}.selection`, `${one.operation} is not a GraphQL operation, so it takes no selection`)
    if (!tree || !map) return
    const row = rowSelection(tree, one.items ?? operation.pagination?.items)
    if (!row) throw invalid(`${where}.selection`, "selects no rows where the operation's items are")
    for (const [field, rule] of Object.entries(map))
      for (const { path: read, inside } of rulePaths(rule)) {
        const steps = [...(inside?.split(".") ?? []), ...read.split(".")]
        if (!selects(row, steps))
          throw invalid(`${where}.selection`, `map.${field} reads ${steps.join(".")}, which the selection leaves out`)
      }
  }
  for (const kind of manifest.kinds) {
    const one = manifest.entities[kind]
    if (!one) throw invalid(`entities.${kind}`, `${kind} is in kinds but has no entity`)
    if (one.map.externalId === undefined) throw invalid(`entities.${kind}.map.externalId`, "every kind maps its id")
    const fields = Object.keys(TRACKER_FIELDS[kind])
    for (const field of Object.keys(one.map))
      if (!fields.includes(field)) {
        const near = nearest(field, fields)
        throw invalid(
          `entities.${kind}.map.${field}`,
          `${kind} has no such field${near ? `; did you mean ${near}?` : ""}`,
        )
      }
    checkCall(`entities.${kind}.list`, one.list, one.map)
    if (one.changes) {
      checkCall(`entities.${kind}.changes`, one.changes, one.map)
      if (!hasSince(one.changes.variables)) throw invalid(`entities.${kind}.changes`, 'no "{since}" in its variables')
    }
    if (one.ids) checkCall(`entities.${kind}.ids`, one.ids, { externalId: one.map.externalId })
  }
  for (const [kind, one] of Object.entries(manifest.entities))
    if (one && !manifest.kinds.includes(kind as TrackerKind))
      throw invalid(`entities.${kind}`, `${kind} has an entity but is not in kinds`)
  if (manifest.self) checkCall("self.call", manifest.self.call, { self: manifest.self.path })
  return manifest
}
