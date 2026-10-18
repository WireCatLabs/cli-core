import { CliError } from "@wirecat/cli-base"

export interface TagRedirectSnapshot {
  complete: true
  tags: readonly { id: string; kind: "tag" }[]
  redirects: readonly { sourceId: string; survivorId: string }[]
}

export interface TagRedirectResolution {
  requestedId: string
  canonicalId: string
  /** Includes the requested and canonical IDs, in traversal order. */
  path: string[]
  /** All retained IDs resolving to this canonical ID, in numeric order. */
  memberIds: string[]
}

export interface TagRedirectIndex {
  resolve(id: string): TagRedirectResolution
}

const invalid = (message: string): never => {
  throw new CliError("validation_error", message)
}
const record = (value: unknown, fields: string[], field: string): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid(`${field} must be an object`)
  for (const key of Object.keys(value)) if (!fields.includes(key)) invalid(`unknown ${field} field: ${key}`)
  return value as Record<string, unknown>
}
const tagId = (value: unknown, field: string): string => {
  if (
    typeof value !== "string" ||
    value.length > 16 ||
    !/^[1-9]\d*$/.test(value) ||
    !Number.isSafeInteger(Number(value))
  )
    return invalid(`${field} must be a positive canonical tag id`)
  return value
}

/** Validates the whole captured graph before exposing any resolution; it enables no store writes. */
export const createTagRedirectIndex = (snapshot: TagRedirectSnapshot): TagRedirectIndex => {
  const input = record(snapshot, ["complete", "tags", "redirects"], "snapshot")
  if (input.complete !== true) invalid("snapshot.complete must be true; partial tag graphs cannot resolve labels")
  for (const field of ["tags", "redirects"] as const)
    if (!Array.isArray(input[field]) || input[field].length > 4096)
      invalid(`snapshot.${field} must be an array of at most 4096 rows`)
  const ids = new Set<string>()
  for (const [index, value] of snapshot.tags.entries()) {
    const row = record(value, ["id", "kind"], `tags[${index}]`)
    const id = tagId(row.id, `tags[${index}].id`)
    if (row.kind !== "tag") invalid(`tags[${index}].kind must be tag; topics and projects cannot redirect`)
    if (ids.has(id)) invalid(`tags[${index}].id is duplicated`)
    ids.add(id)
  }
  const edges = new Map<string, string>()
  for (const [index, value] of snapshot.redirects.entries()) {
    const row = record(value, ["sourceId", "survivorId"], `redirects[${index}]`)
    const source = tagId(row.sourceId, `redirects[${index}].sourceId`)
    const survivor = tagId(row.survivorId, `redirects[${index}].survivorId`)
    if (!ids.has(source) || !ids.has(survivor)) invalid(`redirects[${index}] names an unavailable tag`)
    if (edges.has(source)) invalid(`redirects[${index}].sourceId has more than one redirect`)
    edges.set(source, survivor)
  }
  const paths = new Map<string, string[]>()
  const members = new Map<string, string[]>()
  const ordered = [...ids].sort((a, b) => Number(a) - Number(b))
  for (const id of ordered) {
    const path = [id]
    let current = id
    while (edges.has(current)) {
      const next = edges.get(current) as string
      if (path.includes(next)) invalid("redirects contain a cycle")
      if (path.length > 16) invalid("redirects exceed the maximum of 16 hops")
      path.push(next)
      current = next
    }
    paths.set(id, path)
    const group = members.get(current) ?? []
    group.push(id)
    members.set(current, group)
  }
  return {
    resolve: (value) => {
      const id = tagId(value, "id")
      const path = paths.get(id)
      if (!path) throw new CliError("not_found", "the captured graph holds no requested tag")
      const canonicalId = path.at(-1) as string
      return { requestedId: id, canonicalId, path: [...path], memberIds: [...(members.get(canonicalId) as string[])] }
    },
  }
}
