import { createHash } from "node:crypto"
import { CliError } from "@wirecat/cli-base"
import * as v from "valibot"
import { canonicalReference, parseReference } from "../../domain/references.js"
import { canonicalMeetingReference } from "../../meetings/index.js"
import { decodeProjectAnnotations, projectAnnotationsFingerprint } from "./manifest.js"

const hash = v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/))
const ref = v.pipe(v.string(), v.minLength(1), v.maxLength(2048))
const targetSchema = v.strictObject({
  project: v.pipe(v.string(), v.regex(/^project:[1-9]\d*$/)),
  revision_sha256: hash,
  annotation_count: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
  external: v.pipe(v.array(v.strictObject({ ref, content_sha256: v.nullable(hash) })), v.maxLength(1000)),
})
export type ProjectAnnotationsTarget = v.InferOutput<typeof targetSchema>
export interface ProjectAnnotationsPlan {
  fingerprint: string
  manifest_fingerprint: string
  target_revision_sha256: string
  missing_bindings: string[]
  conflicts: { reference: string; reason: "missing" | "wrong_kind" | "changed" | "populated" | "duplicate" }[]
  ready: boolean
}

const kind = (ref: string) => {
  if (ref.startsWith("meeting:")) {
    if (canonicalMeetingReference(ref) !== ref) throw new Error("noncanonical")
    return `meeting:${ref.split("/").length}`
  }
  if (canonicalReference(ref) !== ref) throw new Error("noncanonical")
  const parsed = parseReference(ref)
  return "provider" in parsed ? `${parsed.type}:${parsed.provider}` : parsed.type
}
const invalid = (field: string): never => {
  throw new CliError("validation_error", `invalid project annotation plan.${field}`)
}

export const projectAnnotationBindingSources = (
  manifest: { project: { ref: string }; external: { ref: string }[] },
  bindings: Record<string, string>,
) => {
  if (!bindings || typeof bindings !== "object" || Array.isArray(bindings) || Object.keys(bindings).length > 1001)
    return invalid("bindings")
  if (Object.getPrototypeOf(bindings) !== Object.prototype && Object.getPrototypeOf(bindings) !== null)
    return invalid("bindings")
  const required = new Set([manifest.project.ref, ...manifest.external.map((item) => item.ref)])
  for (const [source, destination] of Object.entries(bindings))
    if (!required.has(source) || typeof destination !== "string" || destination.length > 2048)
      return invalid("bindings")
  for (const destination of Object.values(bindings)) {
    try {
      kind(destination)
    } catch {
      return invalid("bindings.reference")
    }
  }
  return required
}

export const planBoundProjectAnnotations = (
  manifest: { project: { ref: string }; external: { ref: string; content_sha256: string | null }[] },
  manifest_fingerprint: string,
  target: ProjectAnnotationsTarget,
  bindings: Record<string, string>,
): ProjectAnnotationsPlan => {
  const checked = v.safeParse(targetSchema, target)
  if (!checked.success) return invalid(checked.issues[0]?.path?.map((p) => String(p.key)).join(".") ?? "target")
  const required = projectAnnotationBindingSources(manifest, bindings)
  const destinations = new Map<string, string | null>()
  for (const item of checked.output.external) {
    try {
      kind(item.ref)
    } catch {
      return invalid("target.external.ref")
    }
    if (destinations.has(item.ref) || item.ref === target.project) return invalid("target.external.duplicate")
    destinations.set(item.ref, item.content_sha256)
  }
  const missing_bindings: string[] = [],
    conflicts: ProjectAnnotationsPlan["conflicts"] = []
  const used = new Set<string>()
  for (const source of required) {
    const destination = bindings[source]
    if (destination === undefined) {
      missing_bindings.push(source)
      continue
    }
    try {
      if (kind(source) !== kind(destination)) {
        conflicts.push({ reference: source, reason: "wrong_kind" })
        continue
      }
    } catch {
      return invalid("bindings.reference")
    }
    if (used.has(destination)) conflicts.push({ reference: source, reason: "duplicate" })
    used.add(destination)
    if (source === manifest.project.ref) {
      if (destination !== target.project) conflicts.push({ reference: source, reason: "missing" })
      continue
    }
    if (!destinations.has(destination)) conflicts.push({ reference: source, reason: "missing" })
    else if (destinations.get(destination) !== manifest.external.find((item) => item.ref === source)?.content_sha256)
      conflicts.push({ reference: source, reason: "changed" })
  }
  if (target.annotation_count > 0) conflicts.push({ reference: target.project, reason: "populated" })
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        manifest_fingerprint,
        target: {
          ...checked.output,
          external: checked.output.external.toSorted((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0)),
        },
        bindings: Object.fromEntries(Object.entries(bindings).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
      }),
    )
    .digest("hex")
  return {
    fingerprint,
    manifest_fingerprint,
    target_revision_sha256: target.revision_sha256,
    missing_bindings,
    conflicts,
    ready: missing_bindings.length === 0 && conflicts.length === 0,
  }
}

/** Pure planning over an adapter's complete target snapshot; a ready plan is not write authorization. */
export const planProjectAnnotations = (
  json: string,
  target: ProjectAnnotationsTarget,
  bindings: Record<string, string>,
): ProjectAnnotationsPlan =>
  planBoundProjectAnnotations(decodeProjectAnnotations(json), projectAnnotationsFingerprint(json), target, bindings)
