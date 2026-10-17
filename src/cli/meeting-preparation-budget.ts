import { CliError } from "@wirecat/cli-base"
import type { MeetingPreparationItem } from "../entities/meeting-preparation.js"
import { trimPreparationCommunication } from "./meeting-communications.js"

/** Bound the final representation, including any transport escaping, with one shared priority. */
export const boundMeetingPreparationItem = (item: MeetingPreparationItem): void => {
  for (const entry of [...item.meetings, ...item.related.items])
    entry.evidence.content_bytes = Buffer.byteLength(JSON.stringify(entry.evidence.items), "utf8")
  const size = () => Buffer.byteLength(JSON.stringify(item), "utf8")
  while (size() > item.limits.bytes && item.communications?.items.length) trimPreparationCommunication(item)
  if (size() > item.limits.bytes && item.communications) {
    const required = structuredClone(item)
    required.meetings = []
    required.related.items = []
    delete required.project_evidence
    delete required.notes
    delete required.knowledge
    if (Buffer.byteLength(JSON.stringify(required), "utf8") > item.limits.bytes)
      throw new CliError(
        "validation_error",
        "Preparation communication coverage exceeds bytes; increase the output budget",
      )
  }
  while (size() > item.limits.bytes && item.project_evidence?.pages.length) {
    const section = item.project_evidence
    section.pages.pop()
    section.coverage.has_more = true
    section.coverage.output_limited = item.coverage.output_limited = true
    const last = section.pages.at(-1)?.page
    section.continuation = {
      command: "meetings projects evidence",
      project: section.project,
      query: section.query,
      cursor: last?.mode === "cursor" ? (last.next_cursor ?? null) : null,
      limit: Math.min(item.limits.context_limit, 20),
      max_read_bytes: item.limits.max_read_bytes,
    }
  }
  if (size() > item.limits.bytes && item.project_evidence) {
    delete item.project_evidence
    item.coverage.output_limited = true
  }
  while (size() > item.limits.bytes && item.notes?.items.length) {
    item.notes.items.pop()
    item.notes.coverage.output_limited = item.coverage.output_limited = true
  }
  if (size() > item.limits.bytes && item.notes) {
    delete item.notes
    item.coverage.output_limited = true
  }
  while (size() > item.limits.bytes && item.knowledge?.items.length) {
    item.knowledge.items.pop()
    item.knowledge.coverage.output_limited = item.coverage.output_limited = true
  }
  if (size() > item.limits.bytes && item.knowledge) {
    delete item.knowledge
    item.coverage.output_limited = true
  }
  while (size() > item.limits.bytes && item.related.items.length) {
    item.related.items.pop()
    item.related.output_limited = item.coverage.output_limited = true
  }
  while (size() > item.limits.bytes && item.meetings.length) {
    item.meetings.pop()
    item.coverage.output_limited = true
  }
  if (size() > item.limits.bytes)
    throw new CliError("validation_error", "Preparation metadata exceeds bytes; increase the output budget")
}
