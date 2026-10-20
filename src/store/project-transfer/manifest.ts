import { createHash } from "node:crypto"
import { CliError } from "@wirecat/cli-base"
import * as v from "valibot"
import { canonicalReference, parseReference } from "../../domain/references.js"
import { normalizeVocabularyName } from "../../domain/vocabulary.js"
import { canonicalMeetingReference } from "../../meetings/index.js"
import { type ProjectAnnotations, projectAnnotationsSchema } from "./schema.js"

export type { ProjectAnnotations } from "./schema.js"
export const PROJECT_ANNOTATIONS_MAX_BYTES = 4 * 1024 * 1024
const invalid = (field: string): never => {
  throw new CliError("validation_error", `invalid project annotations.${field}`)
}
const canonical = (ref: string): string => {
  try {
    return ref.startsWith("meeting:") ? canonicalMeetingReference(ref) : canonicalReference(ref)
  } catch {
    return invalid("reference")
  }
}

export const validateProjectAnnotationsGraph = (manifest: ProjectAnnotations, additionalActors: string[] = []) => {
  const owned = new Set([manifest.project.ref])
  const external = new Set<string>()
  const used = new Set<string>()
  const kind = (ref: string, kinds: string[]) => {
    if (canonical(ref) !== ref || !kinds.includes(parseReference(ref).type) || !/^[a-z]+:[1-9]\d*$/.test(ref))
      invalid("reference kind")
  }
  kind(manifest.project.ref, ["project"])
  for (const fact of manifest.facts) {
    kind(fact.ref, ["fact"])
    if (owned.has(fact.ref)) invalid("facts.duplicate")
    owned.add(fact.ref)
    kind(fact.author, ["person", "bot"])
    if (fact.confirmed_by !== null) kind(fact.confirmed_by, ["person", "bot"])
    if (fact.updated_at < fact.created_at) invalid("facts.updated_at")
    if (fact.type !== "decision" && (fact.supersedes !== null || ["superseded", "reversed"].includes(fact.status)))
      invalid("facts.lifecycle")
    if (fact.supersedes === fact.ref) invalid("facts.supersedes")
  }
  for (const item of manifest.external) {
    if (canonical(item.ref) !== item.ref || owned.has(item.ref) || external.has(item.ref)) invalid("external.ref")
    external.add(item.ref)
    const body = /^(msg|document|note|meeting):/.test(item.ref)
    if (body !== (item.content_sha256 !== null)) invalid("external.content_sha256")
  }
  const dependency = (ref: string | null) => {
    if (ref === null) return
    if (canonical(ref) !== ref || (!owned.has(ref) && !external.has(ref))) invalid("missing dependency")
    used.add(ref)
  }
  if (manifest.project.organization !== null) kind(manifest.project.organization, ["organization"])
  dependency(manifest.project.organization)
  for (const actor of additionalActors) {
    kind(actor, ["person", "bot"])
    dependency(actor)
  }
  const aliases = new Set([manifest.project.name, manifest.project.key].map(normalizeVocabularyName))
  for (const alias of manifest.aliases) {
    const name = normalizeVocabularyName(alias)
    if (aliases.has(name)) invalid("aliases.duplicate")
    aliases.add(name)
  }
  for (const fact of manifest.facts) {
    for (const ref of [fact.author, fact.confirmed_by, fact.subject, fact.supersedes]) dependency(ref)
    if (fact.supersedes !== null) {
      kind(fact.supersedes, ["fact"])
      if (!manifest.facts.some((previous) => previous.ref === fact.supersedes && previous.type === "decision"))
        invalid("facts.supersedes outside project")
    }
  }
  const previous = new Map(manifest.facts.map((fact) => [fact.ref, fact.supersedes]))
  for (const fact of manifest.facts) {
    const path = new Set<string>()
    let ref: string | null | undefined = fact.ref
    while (ref) {
      if (path.has(ref)) invalid("facts.supersedes cycle")
      path.add(ref)
      ref = previous.get(ref)
    }
  }
  const links = new Set<string>()
  for (const link of manifest.links) {
    if (!/^link:[1-9]\d*$/.test(link.ref) || links.has(link.ref)) invalid("links.ref")
    links.add(link.ref)
    if (!owned.has(link.from) && (link.to === null || !owned.has(link.to))) invalid("links.outside project")
    if (link.to === null && link.target_text === null) invalid("links.target_text")
    if (link.updated_at < link.created_at) invalid("links.updated_at")
    for (const ref of [link.from, link.to]) dependency(ref)
  }
  for (const ref of external) if (!used.has(ref)) invalid("external.unused")
}

/** Decode bounded JSON, never a row/column importer or an implicit whole-project backup. */
export const decodeProjectAnnotations = (json: string): ProjectAnnotations => {
  if (typeof json !== "string" || Buffer.byteLength(json) > PROJECT_ANNOTATIONS_MAX_BYTES) invalid("bytes")
  let input: unknown
  try {
    input = JSON.parse(json)
  } catch {
    return invalid("json")
  }
  const parsed = v.safeParse(projectAnnotationsSchema, input)
  if (!parsed.success) return invalid(parsed.issues[0]?.path?.map((part) => String(part.key)).join(".") ?? "manifest")
  const manifest = parsed.output
  if (manifest.aliases.length + manifest.facts.length + manifest.links.length + manifest.external.length > 1000)
    invalid("record budget")
  validateProjectAnnotationsGraph(manifest)
  return manifest
}

export const projectAnnotationsFingerprint = (json: string): string => {
  const manifest = decodeProjectAnnotations(json)
  const normalized = {
    ...manifest,
    aliases: manifest.aliases.toSorted(),
    facts: manifest.facts.toSorted((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0)),
    links: manifest.links.toSorted((a, b) => a.ref.localeCompare(b.ref)),
    external: manifest.external.toSorted((a, b) => a.ref.localeCompare(b.ref)),
  }
  // Strict decoding fixes object key order; record arrays have identity, unlike text and timestamps.
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex")
}
