import { CliError } from "@wirecat/cli-base"
import { excerpt } from "./excerpt.js"
import type { CommunicationPlan } from "./meeting-communications-selection.js"
import type { MeetingCommunicationExcerpt, MeetingCommunications } from "./meeting-communications-types.js"
import type { MeetingPreparation } from "./meeting-preparation-types.js"
import { preparationCancelled } from "./meeting-preparation-validation.js"

export const readPreparationCommunications = async (plan: CommunicationPlan, signal?: AbortSignal) => {
  const section: MeetingCommunications = {
    readUsage: plan.reader.usage(),
    query: plan.input.query,
    window: { after: plan.input.after, before: plan.input.before },
    selection: "explicit-host-grants/literal-words",
    sources: [],
    items: [],
  }
  const lanes: MeetingCommunicationExcerpt[][] = []
  for (const read of plan.reads) {
    preparationCancelled(signal)
    const coverage: MeetingCommunications["sources"][number] = {
      selectionId: read.id,
      source: read.request.source,
      state: "searched",
      index: "unknown",
      hasMore: false,
      hasUndated: false,
      completeness: "unknown",
      consistency: "snapshot-per-page",
      nextCursor: null,
      restartRequired: false,
      outputLimited: false,
      readBytes: null,
      issue: null,
    }
    const items: MeetingCommunicationExcerpt[] = []
    try {
      const page = await plan.reader.read(read.request)
      preparationCancelled(signal)
      coverage.index = page.coverage.index
      coverage.hasMore = page.coverage.hasMore
      coverage.hasUndated = page.coverage.hasUndated
      coverage.readBytes = page.readBytes
      coverage.nextCursor = page.next ? Buffer.from(JSON.stringify(page.next)).toString("base64url") : null
      if (!page.coverage.available) {
        coverage.state = "unavailable"
        coverage.issue = "not_found"
      } else if (page.oversized) {
        coverage.state = "read-limited"
        coverage.issue = "validation_error"
      } else if (page.coverage.index !== "ready") coverage.issue = "configuration_error"
      const refs = new Set<string>()
      for (const item of page.items) {
        if (refs.has(item.ref)) continue
        refs.add(item.ref)
        const text = excerpt(item.text, plan.input.query, 300, { literal: true })
        // excerpt() puts every text on one line, so only a shorter result means words were cut.
        const whole = item.text.replace(/\s+/g, " ").trim()
        items.push({ ...item, text, selectionId: read.id, textTruncated: text !== whole })
      }
    } catch (error) {
      preparationCancelled(signal)
      if (!(error instanceof CliError)) throw error
      if (error.code === "not_found") {
        coverage.state = "unavailable"
        coverage.issue = "not_found"
      } else if (error.code === "validation_error" && error.details?.reason === "context.read-budget") {
        coverage.state = "read-limited"
        coverage.issue = "validation_error"
        coverage.restartRequired = true
        coverage.nextCursor = read.incomingCursor
      } else throw error
    }
    section.sources.push(coverage)
    lanes.push(items)
  }
  const candidates: MeetingCommunicationExcerpt[] = []
  for (let rank = 0; rank < 10; rank++)
    for (const lane of lanes) {
      const item = lane[rank]
      if (item) candidates.push(item)
    }
  section.readUsage = plan.reader.usage()
  return { section, candidates }
}

export const appendPreparationCommunications = (
  result: MeetingPreparation,
  read: Awaited<ReturnType<typeof readPreparationCommunications>> | undefined,
) => {
  if (!read || !result.communications) return
  for (const candidate of read.candidates) {
    result.communications.items.push(candidate)
    if (result.communications.items.length > 20 || Buffer.byteLength(JSON.stringify(result)) > result.limits.bytes) {
      result.communications.items.pop()
      const source = result.communications.sources.find((s) => s.selectionId === candidate.selectionId)
      if (!source) throw new CliError("invalid_response", "Missing communication selection")
      source.outputLimited = source.restartRequired = result.coverage.outputLimited = true
      source.nextCursor = null
    } else if (candidate.textTruncated) result.coverage.outputLimited = true
  }
  result.coverage.unqueried = result.coverage.unqueried.map((s) =>
    s === "person-nonmeeting-context"
      ? "other-person-nonmeeting-context"
      : s === "project-nonmeeting-context"
        ? "other-project-nonmeeting-context"
        : s,
  )
  if (result.notes) result.notes.coverage.otherSources = "see-communications"
  if (result.knowledge) result.knowledge.coverage.otherSources = "see-communications"
}
