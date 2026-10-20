import { createHash } from "node:crypto"
import { CliError } from "@wirecat/cli-base"
import * as v from "valibot"
import { PROJECT_ANNOTATIONS_MAX_BYTES, validateProjectAnnotationsGraph } from "./manifest.js"
import { type ProjectAnnotations, projectAnnotationsSchema } from "./schema.js"

const text = (max: number) =>
  v.pipe(
    v.string(),
    v.minLength(1),
    v.maxLength(max),
    v.check((s) => !!s.trim()),
  )
const timestamp = v.pipe(v.number(), v.safeInteger(), v.minValue(0))
export const projectAnnotationSnapshotSchema = v.strictObject({
  ...projectAnnotationsSchema.entries,
  version: v.literal(2),
  coverage: v.strictObject({
    ...projectAnnotationsSchema.entries.coverage.entries,
    meeting_memberships: v.literal("omitted"),
    notes: v.literal("omitted"),
  }),
  project: v.strictObject({
    ...projectAnnotationsSchema.entries.project.entries,
    description: v.nullable(text(20000)),
    status: v.nullable(text(200)),
    owner: v.nullable(text(2048)),
    updated_at: timestamp,
    account_scope: v.literal("owner"),
  }),
  aliases: v.pipe(
    v.array(
      v.strictObject({
        name: text(200),
        source: text(200),
        display: v.boolean(),
        created_at: timestamp,
        updated_at: timestamp,
      }),
    ),
    v.maxLength(1000),
  ),
})

export type ProjectAnnotationSnapshot = v.InferOutput<typeof projectAnnotationSnapshotSchema>

export const snapshotGraph = (value: ProjectAnnotationSnapshot): ProjectAnnotations => ({
  format: value.format,
  version: 1,
  project: {
    ref: value.project.ref,
    key: value.project.key,
    name: value.project.name,
    type: value.project.type,
    scope: value.project.scope,
    organization: value.project.organization,
    created_at: value.project.created_at,
  },
  coverage: value.coverage,
  aliases: value.aliases.map((alias) => alias.name),
  facts: value.facts,
  links: value.links,
  external: value.external,
})

export const decodeProjectAnnotationSnapshot = (json: string): ProjectAnnotationSnapshot => {
  const invalid = (field: string): never => {
    throw new CliError("validation_error", `invalid project annotation snapshot.${field}`)
  }
  if (typeof json !== "string" || Buffer.byteLength(json) > PROJECT_ANNOTATIONS_MAX_BYTES) return invalid("bytes")
  let value: unknown
  try {
    value = JSON.parse(json)
  } catch {
    return invalid("json")
  }
  const checked = v.safeParse(projectAnnotationSnapshotSchema, value)
  if (!checked.success) return invalid(checked.issues[0]?.path?.map((p) => String(p.key)).join(".") ?? "manifest")
  const snapshot = checked.output
  if (snapshot.aliases.length + snapshot.facts.length + snapshot.links.length + snapshot.external.length > 1000)
    return invalid("record budget")
  if (snapshot.project.updated_at < snapshot.project.created_at) return invalid("project.updated_at")
  for (const alias of snapshot.aliases) if (alias.updated_at < alias.created_at) return invalid("aliases.updated_at")
  for (const fact of snapshot.facts) if (!fact.statement.trim()) return invalid("facts.statement")
  validateProjectAnnotationsGraph(
    snapshotGraph(snapshot),
    snapshot.project.owner === null ? [] : [snapshot.project.owner],
  )
  return snapshot
}

export const projectAnnotationSnapshotFingerprint = (json: string): string => {
  const snapshot = decodeProjectAnnotationSnapshot(json)
  const order = (a: { ref: string }, b: { ref: string }) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0)
  return createHash("sha256")
    .update(
      JSON.stringify({
        ...snapshot,
        aliases: snapshot.aliases.toSorted((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
        facts: snapshot.facts.toSorted(order),
        links: snapshot.links.toSorted(order),
        external: snapshot.external.toSorted(order),
      }),
    )
    .digest("hex")
}
