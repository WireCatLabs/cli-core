import type { MeetingProjectDiscoveryReader } from "./project-discovery.js"
import { meetingProjectEvidenceAnswer } from "./project-evidence-answer.js"
import { type MeetingProjectEvidenceRequest, prepareMeetingProjectEvidence } from "./project-evidence-query.js"

/** Transport-independent read; the injected reader fixes the authorized account and resource lifetime. */
export const readMeetingProjectEvidence = async (
  read: MeetingProjectDiscoveryReader,
  project: string,
  request: MeetingProjectEvidenceRequest = {},
  now = Date.now(),
) => {
  const prepared = prepareMeetingProjectEvidence(project, request, now)
  const page = await read(prepared.project, prepared.options)
  prepared.options.signal?.throwIfAborted()
  return meetingProjectEvidenceAnswer(page, prepared)
}
