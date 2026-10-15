import { CliError } from "@wirecat/cli-base"
import { formatMeetingReference } from "../meetings/index.js"
import { readMeetingEvidence } from "./meeting-evidence.js"
import type { MeetingPreparation, MeetingPreparationPorts } from "./meeting-preparation-types.js"
import { preparationCancelled, type preparationRequest } from "./meeting-preparation-validation.js"

/** Related context shares the packet budget; exact-series evidence keeps priority. */
export const appendRelatedPreparation = async (
  store: MeetingPreparationPorts["meetings"],
  result: MeetingPreparation,
  input: ReturnType<typeof preparationRequest>,
) => {
  if (!result.series || !result.items.length || result.coverage.outputLimited) return
  const size = () => Buffer.byteLength(JSON.stringify(result), "utf8")
  const related = result.related
  related.anchors = result.items.map((item) => item.reference)
  if (size() > input.bytes) {
    related.anchors = []
    related.outputLimited = result.coverage.outputLimited = true
    return
  }
  const page = await store.relatedHistory({
    accountId: result.accountId,
    seriesId: result.series.id,
    anchorIds: result.items.map((item) => item.meeting.id),
    after: input.historyAfter,
    before: input.after,
    limit: input.meetings,
    maxReadBytes: input.maxReadBytes,
    signal: input.signal,
  })
  preparationCancelled(input.signal)
  if (!Array.isArray(page.items) || page.items.length > input.meetings || typeof page.hasMore !== "boolean")
    throw new CliError("invalid_response", "Related history exceeded its bound")
  result.coverage.unqueried = ["person-nonmeeting-context", "project-nonmeeting-context", "project-alias-candidates"]
  related.hasMore = page.hasMore
  const selected = new Set(result.items.map((item) => item.meeting.id))
  for (const entry of page.items) {
    const meeting = entry.meeting
    if (
      !Number.isSafeInteger(meeting.id) ||
      meeting.id < 1 ||
      selected.has(meeting.id) ||
      meeting.startedAt === null ||
      meeting.startedAt < input.historyAfter ||
      meeting.startedAt >= input.after ||
      typeof entry.sharedPerson !== "boolean" ||
      typeof entry.sharedProject !== "boolean" ||
      !(entry.sharedPerson || entry.sharedProject)
    )
      throw new CliError("invalid_response", "Related history returned an invalid selection")
    selected.add(meeting.id)
    const reference = formatMeetingReference({ type: "meeting", accountId: result.accountId, meetingId: meeting.id })
    const remaining = input.bytes - size() - 512
    if (remaining < 2) {
      related.outputLimited = result.coverage.outputLimited = true
      break
    }
    try {
      const evidence = await readMeetingEvidence(store, result.accountId, reference, {
        cues: input.cues,
        bytes: remaining,
        maxReadBytes: input.maxReadBytes,
        maxTranscriptPages: 2,
        signal: input.signal,
      })
      preparationCancelled(input.signal)
      const current = await store.meetingMetadata({
        accountId: result.accountId,
        meetingId: meeting.id,
        maxReadBytes: input.maxReadBytes,
        signal: input.signal,
      })
      preparationCancelled(input.signal)
      if (current.updatedAt !== meeting.updatedAt || current.meetingSeriesId === result.series.id)
        throw new CliError("not_found", "Related history changed after selection")
      related.items.push({ ...entry, reference, evidence })
      if (size() > input.bytes) {
        related.items.pop()
        related.outputLimited = result.coverage.outputLimited = true
        break
      }
    } catch (error) {
      preparationCancelled(input.signal)
      if (!(error instanceof CliError) || error.code !== "not_found") throw error
      result.coverage.skippedUnavailable.push(reference)
    }
  }
}
