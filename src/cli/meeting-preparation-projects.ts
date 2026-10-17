import { meetingProjectEvidenceAnswer, prepareMeetingProjectEvidence } from "../meetings/index.js"
import type { MeetingPreparation } from "../services/meeting-preparation-types.js"

export const mapPreparationProjectEvidence = (
  section: NonNullable<MeetingPreparation["projectEvidence"]>,
  limits: MeetingPreparation["limits"],
) => {
  const prepared = prepareMeetingProjectEvidence(section.project, {
    query: section.query,
    limit: Math.min(limits.contextLimit, 20),
    maxReadBytes: limits.maxReadBytes,
  })
  return {
    ...section,
    pages: section.pages.map((page) => meetingProjectEvidenceAnswer(page, prepared).item),
    continuation: section.coverage.hasMore
      ? {
          command: "meetings projects evidence" as const,
          project: section.project,
          query: section.query,
          cursor: section.pages.at(-1)?.nextCursor ?? null,
          limit: Math.min(limits.contextLimit, 20),
          maxReadBytes: limits.maxReadBytes,
        }
      : null,
  }
}
