import { CliError } from "@wirecat/cli-base"
import * as v from "valibot"
import { editDistance } from "../../../search/correct.js"
import type { ServiceApiManifest } from "../../service-api-manifest.js"

/**
 * One read the source sends: an operation of the generated API and what to put in it. A value `"{id}"`, `"{since}"`
 * or `"{cursor}"` anywhere in `path`, `query` or `body` is filled in by the source; one left without a value is left
 * out. `items`: where the answer's rows are when the operation has no `pagination`.
 */
export interface DocumentCall {
  operation: string
  path?: Readonly<Record<string, string>>
  query?: Readonly<Record<string, string | number | boolean>>
  body?: unknown
  items?: string
}

/**
 * Dot paths into one row of the answer. `parent` names one parent, `parents` a list of them; `folder` says which rows
 * are folders (`path` equal to `is`). `mime` is a path, or with `folder` a fixed type for files and for folders.
 */
export interface DocumentFileMap {
  id: string
  name: string
  parent?: string
  parents?: string
  url?: string
  modifiedAt?: string
  createdAt?: string
  version?: string
  trashed?: string
  mime?: string
  folder?: { path: string; is: string | number | boolean; mime?: { folder: string; file: string } }
}

/**
 * A documents source read from a config (a `files` CLI): the calls it sends and where its answers hold a file. A
 * method the manifest does not describe comes from a hook; `reads` names the calls a hook sends, so every request a
 * sync makes is in the config.
 */
export interface DocumentManifest {
  provider: string
  /** The account: the values at `id` joined by `:` (`workspace:user`). */
  identity: DocumentCall & { id: string | readonly string[] }
  /** One file by its id: needs `"{id}"`. */
  get?: DocumentCall & { map: DocumentFileMap }
  /** A folder's children, by the operation's `pagination`: needs `"{id}"`. Mapped by `get.map` unless it has one. */
  children?: DocumentCall & { map?: DocumentFileMap }
  /** What changed since a time, newest first or in any order: needs `"{since}"`. */
  changes?: DocumentCall & { since: "iso" | "ms" | "seconds"; time: string; overlapMs?: number; map?: DocumentFileMap }
  /** A document's text as Markdown, at `markdown` in the answer: needs `"{id}"`. */
  content?: DocumentCall & { markdown: string }
  /**
   * A saved document read again though it did not change: one whose `providerMetadata` has no value at `missing`
   * (a field the source learned to read later, such as authors).
   */
  reread?: { missing: string }
  /** Calls named for the hooks, sent with `read(name, slots)`. */
  reads?: Readonly<Record<string, DocumentCall>>
}

const dotPath = v.pipe(v.string(), v.regex(/^[^.\s]+(\.[^.\s]+)*$/, "a dot path into the answer, such as data.id"))
const scalar = v.union([v.string(), v.number(), v.boolean()])
const callEntries = {
  operation: v.pipe(v.string(), v.minLength(1)),
  path: v.optional(v.record(v.string(), v.string())),
  query: v.optional(v.record(v.string(), scalar)),
  body: v.optional(v.unknown()),
  items: v.optional(dotPath),
}
const fileMap = v.strictObject({
  id: dotPath,
  name: dotPath,
  parent: v.optional(dotPath),
  parents: v.optional(dotPath),
  url: v.optional(dotPath),
  modifiedAt: v.optional(dotPath),
  createdAt: v.optional(dotPath),
  version: v.optional(dotPath),
  trashed: v.optional(dotPath),
  mime: v.optional(dotPath),
  folder: v.optional(
    v.strictObject({
      path: dotPath,
      is: scalar,
      mime: v.optional(v.strictObject({ folder: v.string(), file: v.string() })),
    }),
  ),
})

const schema = v.strictObject({
  provider: v.pipe(v.string(), v.regex(/^[a-z][a-z0-9-]*$/, "lower-case letters, digits and dashes")),
  identity: v.strictObject({ ...callEntries, id: v.union([dotPath, v.pipe(v.array(dotPath), v.minLength(1))]) }),
  get: v.optional(v.strictObject({ ...callEntries, map: fileMap })),
  children: v.optional(v.strictObject({ ...callEntries, map: v.optional(fileMap) })),
  changes: v.optional(
    v.strictObject({
      ...callEntries,
      since: v.picklist(["iso", "ms", "seconds"]),
      time: dotPath,
      overlapMs: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
      map: v.optional(fileMap),
    }),
  ),
  content: v.optional(v.strictObject({ ...callEntries, markdown: dotPath })),
  reread: v.optional(v.strictObject({ missing: dotPath })),
  reads: v.optional(
    v.record(v.pipe(v.string(), v.regex(/^[a-z][A-Za-z0-9]*$/, "a camelCase name")), v.strictObject(callEntries)),
  ),
})

const BUILT_IN = ["identity", "get", "children", "changes", "content"]

const invalid = (where: string, message: string) =>
  new CliError("configuration_error", `source manifest: ${where}: ${message}`, { reason: "manifest.invalid" })

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
 * The manifest checked against its shape and the generated API: each operation exists and only reads, and each call
 * places the value it needs. Every error names where it is.
 */
export const parseDocumentManifest = (input: unknown, api: ServiceApiManifest): DocumentManifest => {
  const parsed = v.safeParse(schema, input)
  if (!parsed.success) {
    const [issue] = parsed.issues
    throw invalid(v.getDotPath(issue) ?? "(root)", issue.message)
  }
  const manifest = parsed.output as DocumentManifest
  const operations = new Map(api.operations.map((one) => [one.id, one]))
  const known = [...operations.keys()]
  const check = (where: string, call: DocumentCall | undefined, placeholder?: string) => {
    if (!call) return
    const operation = operations.get(call.operation)
    if (!operation) {
      const near = nearest(call.operation, known)
      throw invalid(
        `${where}.operation`,
        `no operation ${call.operation} in the API${near ? `; did you mean ${near}?` : ""}`,
      )
    }
    if (operation.effect !== "read")
      throw invalid(`${where}.operation`, `${call.operation} is a ${operation.effect}, and a source only reads`)
    if (placeholder && !hasPlaceholder([call.path, call.query, call.body], placeholder))
      throw invalid(where, `no "${placeholder}" in its path, query or body`)
  }
  check("identity", manifest.identity)
  check("get", manifest.get, "{id}")
  check("children", manifest.children, "{id}")
  check("changes", manifest.changes, "{since}")
  check("content", manifest.content, "{id}")
  for (const [name, call] of Object.entries(manifest.reads ?? {})) {
    // A hook sends a named call and a manifest call by the same name; one would hide the other.
    if (BUILT_IN.includes(name)) throw invalid(`reads.${name}`, `${name} is the manifest's own call; name it otherwise`)
    check(`reads.${name}`, call)
  }
  if (manifest.children && !manifest.get?.map && !manifest.children.map)
    throw invalid("children", "no map: give children a map, or get one")
  if (manifest.changes && !manifest.get?.map && !manifest.changes.map)
    throw invalid("changes", "no map: give changes a map, or get one")
  return manifest
}
