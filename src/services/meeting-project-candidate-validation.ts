import { CliError } from "@wirecat/cli-base"
import { normalizeVocabularyName } from "../domain/vocabulary.js"
import type { MeetingProjectCandidateInput, MeetingProjectCandidateOptions } from "../meetings/index.js"
import { formatMeetingReference, parseMeetingReference } from "../meetings/index.js"
import type { VocabularyCatalog } from "../store/index.js"

function invalid(field: string, response = false): never {
  throw new CliError(response ? "invalid_response" : "validation_error", `invalid project candidate ${field}`)
}
const object = (value: unknown, fields: readonly string[], field: string) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(field)
  for (const key of Object.keys(value)) if (!fields.includes(key)) invalid(`${field}.${key}`)
}
const bounded = (value: unknown, max: number, field: string) => {
  if (typeof value !== "string" || value.length > max) invalid(field)
  return value
}
const utf8 = (value: string) => new TextEncoder().encode(value).byteLength
export const candidateLimits = (options: MeetingProjectCandidateOptions = {}) => {
  object(options, ["limit", "maxProjects", "maxVocabularyReadBytes", "bytes", "signal"], "options")
  const limits = {
    limit: options.limit ?? 10,
    maxProjects: options.maxProjects ?? 128,
    maxVocabularyReadBytes: options.maxVocabularyReadBytes ?? 65536,
    bytes: options.bytes ?? 16384,
  }
  for (const [key, value] of Object.entries(limits)) {
    const max = key === "limit" ? 10 : key === "maxProjects" ? 128 : 65536
    if (!Number.isSafeInteger(value) || value < (key === "bytes" ? 1024 : 1) || value > max) invalid(key)
  }
  if (options.signal !== undefined && !(options.signal instanceof AbortSignal)) invalid("signal")
  return limits
}

export const candidateInput = (input: MeetingProjectCandidateInput, accountId: number) => {
  object(input, ["reference", "title", "cues"], "input")
  const reference = bounded(input.reference, 200, "reference")
  const parent = parseMeetingReference(reference)
  if (
    parent.accountId !== accountId ||
    parent.transcriptId !== undefined ||
    formatMeetingReference(parent) !== reference
  )
    invalid("reference")
  if (input.title !== undefined) bounded(input.title, 8192, "title")
  if (input.cues !== undefined && (!Array.isArray(input.cues) || input.cues.length > 100)) invalid("cues")
  let bytes = utf8(input.title ?? "")
  const cues = new Map<string, NonNullable<MeetingProjectCandidateInput["cues"]>[number]>()
  for (const cue of input.cues ?? []) {
    object(cue, ["reference", "fingerprint", "text", "revision"], "cue")
    const ref = bounded(cue.reference, 200, "cue.reference")
    bounded(cue.text, 4096, "cue.text")
    if (!/^[a-f0-9]{64}$/.test(bounded(cue.fingerprint, 64, "cue.fingerprint"))) invalid("cue.fingerprint")
    if (cue.revision !== "current" && cue.revision !== "superseded") invalid("cue.revision")
    const parsed = parseMeetingReference(ref)
    if (
      parsed.accountId !== accountId ||
      parsed.meetingId !== parent.meetingId ||
      parsed.cuePosition === undefined ||
      formatMeetingReference(parsed) !== ref
    )
      invalid("cue.reference")
    bytes += utf8(cue.text)
    if (bytes > 65536) invalid("input bytes")
    const previous = cues.get(ref)
    if (
      previous &&
      (previous.text !== cue.text || previous.fingerprint !== cue.fingerprint || previous.revision !== cue.revision)
    )
      invalid("conflicting cue.reference")
    cues.set(ref, { reference: ref, fingerprint: cue.fingerprint, text: cue.text, revision: cue.revision })
  }
  if (bytes > 65536) invalid("input bytes")
  return { reference, ...(input.title === undefined ? {} : { title: input.title }), cues: [...cues.values()] }
}

export const candidateCatalog = (catalog: VocabularyCatalog, limits: ReturnType<typeof candidateLimits>) => {
  if (!catalog || !Array.isArray(catalog.entries) || catalog.entries.length > limits.maxProjects)
    invalid("catalog.entries", true)
  if (
    typeof catalog.fingerprint !== "string" ||
    !catalog.fingerprint ||
    catalog.fingerprint.length > 200 ||
    /[\p{Cc}\p{Cf}]/u.test(catalog.fingerprint) ||
    catalog.coverage?.complete !== true ||
    catalog.coverage.maxEntries !== limits.maxProjects ||
    catalog.coverage.maxReadBytes !== limits.maxVocabularyReadBytes
  )
    invalid("catalog.coverage", true)
  let aliases = 0,
    bytes = 0
  const ids = new Set<string>()
  const aliasIds = new Set<string>()
  const id = (value: string) => {
    if (typeof value !== "string" || !/^[1-9]\d{0,15}$/.test(value) || !Number.isSafeInteger(Number(value)))
      invalid("catalog.id", true)
  }
  const name = (value: string) => {
    try {
      normalizeVocabularyName(value)
    } catch {
      invalid("catalog.name", true)
    }
    bytes += utf8(value)
  }
  for (const entry of catalog.entries) {
    if (entry?.kind !== "project") invalid("catalog.kind", true)
    id(entry.id)
    if (ids.has(entry.id)) invalid("catalog.id", true)
    ids.add(entry.id)
    name(entry.name)
    if (entry.key !== null) name(entry.key)
    if (!Array.isArray(entry.aliases)) invalid("catalog.aliases", true)
    aliases += entry.aliases.length
    if (aliases > limits.maxProjects * 20) invalid("catalog.aliases", true)
    for (const alias of entry.aliases) {
      if (!alias) invalid("catalog.alias", true)
      id(alias.id)
      if (aliasIds.has(alias.id)) invalid("catalog.alias.id", true)
      aliasIds.add(alias.id)
      name(alias.name)
    }
    if (bytes > limits.maxVocabularyReadBytes) invalid("catalog.bytes", true)
  }
}
