import type { ManifestOperation, SchemaNode } from "@wirecat/cli-base/codegen/runtime"
import type { ServiceApiManifest } from "../../cli/service-api-manifest.js"
import { editDistance } from "../../search/correct.js"
import type { CrmManifest, CrmOperationCall, CrmRule } from "./manifest.js"
import { rulePaths } from "./map.js"

type Definitions = Readonly<Record<string, SchemaNode>>

export const resolve = (node: SchemaNode, definitions: Definitions, seen = new Set<string>()): SchemaNode => {
  if (node.type !== "ref" || seen.has(node.ref)) return node
  const found = definitions[node.ref]
  return found ? resolve(found, definitions, new Set([...seen, node.ref])) : { type: "unknown" }
}

/** The node one step down, `null` when the schema has no such field, `undefined` when the schema cannot say. */
export const step = (node: SchemaNode, key: string, definitions: Definitions): SchemaNode | null | undefined => {
  const at = resolve(node, definitions)
  switch (at.type) {
    case "object": {
      const found = at.properties[key] ?? at.additionalProperties
      if (found) return found
      // An object the spec leaves open ("any object") comes out of the adapter with no fields at all.
      return Object.keys(at.properties).length === 0 ? undefined : null
    }
    case "array":
      return /^\d+$/.test(key) ? at.items : null
    case "allOf":
    case "union": {
      const found = at.of.map((one) => step(one, key, definitions))
      if (found.includes(undefined)) return undefined
      const matched = found.filter((one): one is SchemaNode => one !== null)
      if (matched.length === 0) return null
      return matched.length === 1 ? (matched[0] as SchemaNode) : { type: "union", of: matched }
    }
    case "unknown":
      return undefined
    default:
      return null
  }
}

const keysOf = (node: SchemaNode, definitions: Definitions): string[] => {
  const at = resolve(node, definitions)
  if (at.type === "object") return Object.keys(at.properties)
  if (at.type === "allOf" || at.type === "union") return at.of.flatMap((one) => keysOf(one, definitions))
  return []
}

type Walked = { node: SchemaNode | undefined } | { missing: string; near?: string }

export const walk = (node: SchemaNode, path: string, definitions: Definitions): Walked => {
  let at: SchemaNode | undefined = node
  const segments = path === "." ? [] : path.split(".")
  for (const [place, key] of segments.entries()) {
    if (at === undefined) return { node: undefined }
    const next = step(at, key, definitions)
    if (next === null) {
      const near = keysOf(at, definitions)
        .map((one) => ({ one, edits: editDistance(key, one, 2) }))
        .filter(({ edits }) => edits <= 2)
        .sort((a, b) => a.edits - b.edits)[0]?.one
      return {
        missing: segments.slice(0, place + 1).join("."),
        ...(near ? { near: [...segments.slice(0, place), near].join(".") } : {}),
      }
    }
    at = next
  }
  return { node: at }
}

/** One item of the list a path ends on; a path that ends on one object is read as a list of it, as the map does. */
export const itemOf = (node: SchemaNode | undefined, definitions: Definitions) => {
  if (node === undefined) return undefined
  const at = resolve(node, definitions)
  return at.type === "array" ? at.items : at
}

const missingText = (found: { missing: string; near?: string }, operation: string) =>
  `${found.missing} is not in what ${operation} answers${found.near ? `; did you mean ${found.near}?` : ""}`

/**
 * Every path the manifest reads, checked against the schema each operation answers (`definitions` of the generated
 * API): a misspelt or moved field is named with the operation, and the field it likely meant, before a sync runs.
 * A part of a schema that says nothing (`unknown`, an open object) passes. Empty when all hold.
 */
export const crmManifestProblems = (
  manifest: CrmManifest,
  api: ServiceApiManifest,
  definitions: Definitions,
): string[] => {
  const operations = new Map(api.operations.map((one) => [one.id, one]))
  const problems: string[] = []
  const problem = (where: string, text: string) => problems.push(`source manifest: ${where}: ${text}`)

  /** The schema of one row the call answers: its response, down `items`, one item of the list. */
  const rowOf = (where: string, operation: ManifestOperation, call: CrmOperationCall) => {
    const schema = operation.response?.schema
    if (!schema) return undefined
    const root: SchemaNode = { type: "ref", ref: schema }
    const items = call.items ?? operation.pagination?.items
    if (items === undefined) return itemOf(root, definitions)
    const found = walk(root, items, definitions)
    if ("missing" in found) {
      problem(`${where}.items`, missingText(found, call.operation))
      return undefined
    }
    return itemOf(found.node, definitions)
  }

  const check = (
    where: string,
    call: CrmOperationCall,
    rules: Readonly<Record<string, CrmRule | undefined>>,
    inside?: string,
  ) => {
    const operation = operations.get(call.operation)
    if (!operation) return problem(where, `no operation ${call.operation} in the API`)
    let row = rowOf(where, operation, call)
    if (row === undefined) return
    if (inside !== undefined) {
      const list = walk(row, inside, definitions)
      if ("missing" in list) return problem(where, missingText(list, call.operation))
      row = itemOf(list.node, definitions)
      if (row === undefined) return
    }
    for (const [field, rule] of Object.entries(rules))
      for (const { path, inside: list } of rulePaths(rule)) {
        let from: SchemaNode | undefined = row
        if (list !== undefined) {
          const found = walk(row, list, definitions)
          from = "node" in found ? itemOf(found.node, definitions) : undefined
          if (from === undefined) continue
        }
        const found = walk(from, path, definitions)
        if ("missing" in found) problem(`${where}.${field}`, missingText(found, call.operation))
      }
  }

  for (const [kind, entity] of Object.entries(manifest.entities)) {
    if (!entity) continue
    const rules = {
      ...(entity.map as Record<string, CrmRule | undefined>),
      ...(entity.custom ? { "(custom)": entity.custom.from } : {}),
    }
    for (const call of [entity.list, entity.changes, entity.get, entity.search])
      if (call) check(`entities.${kind}.map`, call, rules)
  }
  for (const [kind, pipelines] of Object.entries(manifest.pipelines ?? {})) {
    if (!pipelines) continue
    const { outcome, each, pipeline } = pipelines.stages
    // A call that answers stages has one row per stage: the pipeline's map and the stage's read the same row.
    const flat = each === "."
    check(`pipelines.${kind}.map`, pipelines.call, flat ? pipelines.map : { ...pipelines.map, "(stages)": each })
    check(
      `pipelines.${kind}.stages.map`,
      pipelines.call,
      {
        ...pipelines.stages.map,
        ...(typeof outcome === "object" && "path" in outcome ? { outcome: outcome.path } : {}),
        ...(pipeline ? { "(pipeline)": pipeline } : {}),
      },
      flat ? undefined : each,
    )
  }
  for (const [kind, fields] of Object.entries(manifest.fields ?? {})) {
    if (!fields) continue
    const { options, ...map } = fields.map
    check(`fields.${kind}.map`, fields.call, map)
    if (options && typeof options === "object")
      check(`fields.${kind}.map.options`, fields.call, { id: options.id, label: options.label }, options.each)
  }
  if (manifest.users) check("users.map", manifest.users.call, manifest.users.map)
  return problems
}
