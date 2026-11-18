import { CliError } from "@wirecat/cli-base"
import * as v from "valibot"
import type { ServiceApiManifest } from "../../cli/service-api-manifest.js"
import type { CrmOperationCall, CrmRule } from "../../crm/manifest/manifest.js"
import { crmRuleSchema } from "../../crm/manifest/manifest.js"
import { CHANNEL_KINDS, type ChannelKind, CONTENT_KINDS, type ContentKind, TERM_KINDS } from "../../domain/content.js"
import { editDistance } from "../../search/correct.js"
import { CONTENT_FIELDS } from "./map.js"

/** How the source keeps a post's text, which the engine turns into Markdown and back. */
export const BODY_FORMATS = ["markdown", "html", "wp-blocks"] as const
export type BodyFormat = (typeof BODY_FORMATS)[number]

export interface ContentChangesCall extends CrmOperationCall {
  /** How `{since}` is written: ISO in UTC, or epoch seconds or ms as digits. */
  since: "iso" | "seconds" | "ms"
  /**
   * The answer is sorted by `field`, a time, ascending, and the source reads strictly after `{since}`: each next page
   * starts `step` ms before the last row's time, so a row changed mid-round never moves a page over another row.
   */
  keyset?: { field: string; step?: number }
}

/** One call a kind is read by; a kind read from several (tags and categories, posts and pages) lists one per call. */
export interface ContentManifestEntity {
  /** Every row, page by page by the operation's own `pagination`. Sorted by id, so a change never moves a page. */
  list: CrmOperationCall
  /** Rows changed since `{since}`; absent, every sync lists the kind in full. */
  changes?: ContentChangesCall
  /** Every id, to find deletions; absent, `list`. */
  ids?: CrmOperationCall
  /** One row by `{id}`; a 404 is a row deleted for good. */
  get?: CrmOperationCall
  map: Readonly<Record<string, CrmRule>>
  /** A post's text: where it is and in what format; `fallback` when the sign-in may not read the first. */
  body?: { path: string; format: BodyFormat; fallback?: { path: string; format: BodyFormat } }
  /**
   * The sign-in may be refused this call (a role without the right): a gap with this text, and the rest syncs. A
   * source that leaves rows out without an error names `requires`: a read whose value at `check` is true when the
   * sign-in sees every row; false or missing is the same gap.
   */
  optional?: { message: string; scope?: string; requires?: CrmOperationCall & { check: string } }
}

/** A post's writes, as calls and values over the update call. `"{id}"` and `"{at}"` are filled by the engine. */
export interface ContentManifestWrites {
  create: CrmOperationCall
  update: CrmOperationCall
  trash: CrmOperationCall
  /** Deleting for good, past the trash; absent, the source has no such write. */
  delete?: CrmOperationCall
  /** Where each of our fields goes in a write's body, a dotted path (`title.raw`); `terms` by the term's kind. */
  fields: {
    title?: string
    body?: string
    excerpt?: string
    slug?: string
    terms?: Partial<Record<(typeof TERM_KINDS)[number], string>>
  }
  /** Body values over `update` that publish now, schedule at `"{at}"` (ISO in UTC), and bring back to a draft. */
  publish: Readonly<Record<string, unknown>>
  schedule: Readonly<Record<string, unknown>>
  unpublish: Readonly<Record<string, unknown>>
}

/** A content account described as data. */
export interface ContentManifest {
  provider: string
  kinds: readonly ContentKind[]
  /** Re-read before the last cursor. Default 10 min. */
  overlapMs?: number
  /** The site the profile signed in to is the channel: its address, as the profile keeps it, is its id. */
  channel: { kind: ChannelKind; network: string }
  entities: { readonly [K in ContentKind]?: readonly ContentManifestEntity[] }
  writes?: ContentManifestWrites
}

const path = v.pipe(v.string(), v.regex(/^[^.\s]+(\.[^.\s]+)*$/, "a dotted path such as title.raw"))

const call = v.strictObject({
  operation: v.pipe(v.string(), v.minLength(1)),
  path: v.optional(v.record(v.string(), v.string())),
  query: v.optional(v.record(v.string(), v.union([v.string(), v.number(), v.boolean()]))),
  body: v.optional(v.unknown()),
  items: v.optional(path),
})

const format = v.picklist(BODY_FORMATS)

const entity = v.strictObject({
  list: call,
  changes: v.optional(
    v.strictObject({
      ...call.entries,
      since: v.picklist(["iso", "seconds", "ms"]),
      keyset: v.optional(
        v.strictObject({ field: path, step: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))) }),
      ),
    }),
  ),
  ids: v.optional(call),
  get: v.optional(call),
  map: v.record(v.string(), crmRuleSchema),
  body: v.optional(v.strictObject({ path, format, fallback: v.optional(v.strictObject({ path, format })) })),
  optional: v.optional(
    v.strictObject({
      message: v.pipe(v.string(), v.minLength(1)),
      scope: v.optional(v.string()),
      requires: v.optional(v.strictObject({ ...call.entries, check: path })),
    }),
  ),
})

const schema = v.strictObject({
  provider: v.pipe(v.string(), v.regex(/^[a-z][a-z0-9-]*$/, "a registry name such as wordpress")),
  kinds: v.pipe(v.array(v.picklist(CONTENT_KINDS)), v.minLength(1)),
  overlapMs: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
  channel: v.strictObject({ kind: v.picklist(CHANNEL_KINDS), network: v.pipe(v.string(), v.minLength(1)) }),
  entities: v.record(v.picklist(CONTENT_KINDS), v.optional(v.pipe(v.array(entity), v.minLength(1)))),
  writes: v.optional(
    v.strictObject({
      create: call,
      update: call,
      trash: call,
      delete: v.optional(call),
      fields: v.strictObject({
        title: v.optional(v.string()),
        body: v.optional(v.string()),
        excerpt: v.optional(v.string()),
        slug: v.optional(v.string()),
        terms: v.optional(v.record(v.picklist(TERM_KINDS), v.optional(v.string()))),
      }),
      publish: v.record(v.string(), v.unknown()),
      schedule: v.record(v.string(), v.unknown()),
      unpublish: v.record(v.string(), v.unknown()),
    }),
  ),
})

const invalid = (where: string, message: string) =>
  new CliError("configuration_error", `source manifest: ${where}: ${message}`, { reason: "manifest.invalid" })

const nearest = (wanted: string, known: readonly string[]) =>
  known
    .map((one) => ({ one, edits: editDistance(wanted, one, 2) }))
    .filter(({ edits }) => edits <= 2)
    .sort((a, b) => a.edits - b.edits)[0]?.one

const holds = (value: unknown, placeholder: string): boolean =>
  value === placeholder ||
  (Array.isArray(value) && value.some((one) => holds(one, placeholder))) ||
  (typeof value === "object" && value !== null && Object.values(value).some((one) => holds(one, placeholder)))

/**
 * The manifest checked against its shape and the generated API: each operation exists and reads or writes as its
 * place says, a change call places `{since}`, a get `{id}`, each map names only our fields. Every error names where.
 */
export const parseContentManifest = (input: unknown, api: ServiceApiManifest): ContentManifest => {
  const parsed = v.safeParse(schema, input)
  if (!parsed.success) {
    const [issue] = parsed.issues
    throw invalid(v.getDotPath(issue) ?? "(root)", issue.message)
  }
  const manifest = parsed.output as ContentManifest
  const operations = new Map(api.operations.map((one) => [one.id, one]))
  const known = [...operations.keys()]
  const checkCall = (where: string, one: CrmOperationCall, reads: boolean) => {
    const operation = operations.get(one.operation)
    if (!operation) {
      const near = nearest(one.operation, known)
      throw invalid(
        `${where}.operation`,
        `no operation ${one.operation} in the API${near ? `; did you mean ${near}?` : ""}`,
      )
    }
    if (reads !== (operation.effect === "read"))
      throw invalid(
        `${where}.operation`,
        `${one.operation} is a ${operation.effect}, and this place ${reads ? "reads" : "writes"}`,
      )
  }
  for (const kind of manifest.kinds) {
    const calls = manifest.entities[kind]
    if (!calls) throw invalid(`entities.${kind}`, `${kind} is in kinds but has no entity`)
    calls.forEach((one, at) => {
      const where = `entities.${kind}.${at}`
      checkCall(`${where}.list`, one.list, true)
      if (one.changes) {
        checkCall(`${where}.changes`, one.changes, true)
        if (!holds([one.changes.path, one.changes.query, one.changes.body], "{since}"))
          throw invalid(`${where}.changes`, 'no "{since}" in its path, query or body')
      }
      if (one.ids) checkCall(`${where}.ids`, one.ids, true)
      if (one.optional?.requires) checkCall(`${where}.optional.requires`, one.optional.requires, true)
      if (one.get) {
        checkCall(`${where}.get`, one.get, true)
        if (!holds([one.get.path, one.get.query], "{id}"))
          throw invalid(`${where}.get`, 'no "{id}" in its path or query')
      }
      if (one.map.externalId === undefined) throw invalid(`${where}.map.externalId`, "every kind maps its id")
      const fields = Object.keys(CONTENT_FIELDS[kind])
      for (const field of Object.keys(one.map))
        if (!fields.includes(field)) {
          const near = nearest(field, fields)
          throw invalid(`${where}.map.${field}`, `${kind} has no such field${near ? `; did you mean ${near}?` : ""}`)
        }
      if (one.body && kind !== "post") throw invalid(`${where}.body`, "only a post has a text")
    })
  }
  const writes = manifest.writes
  if (writes) {
    if (!manifest.entities.post?.some((one) => one.get))
      throw invalid("writes", "a write checks the post's version first, and no post entity has a get")
    for (const name of ["create", "update", "trash", "delete"] as const) {
      const one = writes[name]
      if (!one) continue
      checkCall(`writes.${name}`, one, false)
      if (name !== "create" && !holds([one.path, one.query], "{id}"))
        throw invalid(`writes.${name}`, 'no "{id}" in its path or query')
    }
    if (!holds(writes.schedule, "{at}")) throw invalid("writes.schedule", 'no "{at}" for the time it goes out')
  }
  return manifest
}
