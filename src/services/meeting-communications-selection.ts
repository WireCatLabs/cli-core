import { CliError } from "@wirecat/cli-base"
import { communicationRequest, type MeetingCommunicationsRequest } from "../context/communication-selection.js"
import { type ContextEvidenceRequest, contextEvidenceRequest, contextSource } from "../context/evidence.js"
import { contextSourceKey } from "../context/evidence-response.js"
import { formatLocator, parseLocator } from "../domain/locator.js"
import { createContextEvidenceReader } from "./context-evidence.js"
import type { MeetingCommunications, MeetingCommunicationsPort } from "./meeting-communications-types.js"

export const captureCommunicationSelections = (port: MeetingCommunicationsPort | undefined) => {
  if (port === undefined) return undefined
  if (
    !port ||
    typeof port.reader?.read !== "function" ||
    !Array.isArray(port.selections) ||
    port.selections.length > 8 ||
    !port.selections.length
  )
    throw new CliError("configuration_error", "communications needs a bounded reader and 1–8 captured selections")
  const ids = new Set<string>(),
    keys = new Set<string>()
  const selections = port.selections.map((entry) => {
    if (
      !entry ||
      typeof entry.id !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(entry.id) ||
      ids.has(entry.id) ||
      Object.keys(entry).some((key) => !["id", "source"].includes(key))
    )
      throw new CliError(
        "configuration_error",
        "communications selections need unique bounded IDs and source identities",
      )
    const source = contextSource(entry.source),
      key = contextSourceKey(source)
    if (keys.has(key)) throw new CliError("configuration_error", "communications source identity must not be repeated")
    ids.add(entry.id)
    keys.add(key)
    return Object.freeze({ id: entry.id, source: Object.freeze(source) })
  })
  const reader = { read: port.reader.read.bind(port.reader) }
  return (original: MeetingCommunicationsRequest, after: number, maxReadBytes: number, signal?: AbortSignal) => {
    const input = communicationRequest(original, after)
    for (const requested of input.sources)
      if (!ids.has(requested.id))
        throw new CliError(
          "validation_error",
          `communications.sources contains an unauthorized selection: ${requested.id}`,
        )
    const selected = selections.filter((s) => input.sources.some((r) => r.id === s.id))
    const scoped = createContextEvidenceReader(
      reader,
      selected.map((s) => s.source),
    )
    const reads = selected.map((selection) => {
      const token = input.sources.find((s) => s.id === selection.id)?.cursor
      let cursor: ContextEvidenceRequest["cursor"]
      if (token !== undefined) {
        try {
          if (!/^[A-Za-z0-9_-]+$/.test(token)) throw new Error()
          const raw = Buffer.from(token, "base64url").toString("utf8")
          if (Buffer.from(raw).toString("base64url") !== token) throw new Error()
          cursor = JSON.parse(raw)
          if (!cursor) throw new Error()
        } catch {
          throw new CliError("validation_error", `communications.sources.${selection.id}.cursor is invalid`)
        }
      }
      const request = contextEvidenceRequest({
        source: selection.source,
        query: input.query,
        after: input.after,
        before: input.before,
        limit: 10,
        maxReadBytes: Math.min(maxReadBytes, 65536),
        cursor,
        signal,
      })
      const { words: _, ...bounded } = request
      return { id: selection.id, request: bounded, incomingCursor: token ?? null }
    })
    return { input, reads, reader: scoped }
  }
}
export type CommunicationPlan = ReturnType<NonNullable<ReturnType<typeof captureCommunicationSelections>>>

export const validatePreparationCommunications = (
  section: MeetingCommunications | undefined,
  request: MeetingCommunicationsRequest | undefined,
  after: number,
) => {
  const fail: () => never = () => {
    throw new CliError("invalid_response", "Preparation communications returned another selection or invalid evidence")
  }
  if (!request) {
    if (section !== undefined) fail()
    return
  }
  const expected = communicationRequest(request, after)
  if (
    !section ||
    section.query !== expected.query ||
    section.window?.after !== expected.after ||
    section.window?.before !== expected.before
  )
    fail()
  if (
    !Array.isArray(section.sources) ||
    section.sources.length !== expected.sources.length ||
    section.sources.some((s) => !s || typeof s.selectionId !== "string") ||
    new Set(section.sources.map((s) => s.selectionId)).size !== expected.sources.length
  )
    fail()
  for (const source of section.sources) {
    if (!expected.sources.some((s) => s.id === source.selectionId)) fail()
    try {
      contextSource(source.source)
    } catch {
      fail()
    }
  }
  if (!Array.isArray(section.items) || section.items.length > 20) fail()
  for (const item of section.items) {
    if (!item) fail()
    const source = section.sources.find((s) => s.selectionId === item.selectionId)?.source
    if (
      !source ||
      item.provider !== source.provider ||
      item.account !== source.account ||
      !Number.isSafeInteger(item.at) ||
      item.at < expected.after ||
      item.at >= expected.before ||
      !Number.isSafeInteger(item.updatedAt) ||
      item.updatedAt < 0 ||
      item.updatedAt > 8640000000000000 ||
      typeof item.text !== "string" ||
      Buffer.byteLength(item.text) > 1024
    )
      fail()
    try {
      if (source.kind === "document") {
        const id = Number(item.ref.slice(9))
        if (!Number.isSafeInteger(id) || id < 1 || item.ref !== `document:${id}`) fail()
      } else {
        const locator = parseLocator(item.ref)
        if (
          locator.provider !== source.provider ||
          locator.account !== source.account ||
          formatLocator(locator) !== item.ref
        )
          fail()
      }
    } catch {
      fail()
    }
  }
}
