import { CliError } from "@wirecat/cli-base"
import {
  type FactFinding,
  type Finding,
  type FindingsInput,
  type FindingsReceipt,
  findingFingerprint,
  validateFindings,
} from "./findings-rules.js"
import { canonicalMeetingReference, parseMeetingReference } from "./reference.js"

export type { FindingEvidence, FindingOutcome } from "./findings-rules.js"
export { findingHash } from "./findings-rules.js"

export const MEETING_FINDINGS_KIND = "meeting_findings"
export type MeetingFactFinding = FactFinding
export type MeetingTaskFinding = Extract<Finding, { kind: "task" }>
export type MeetingFinding = Finding
export type MeetingFindingsInput = FindingsInput
export type MeetingFindingsReceipt = FindingsReceipt

const cue = (raw: string) => {
  const reference = canonicalMeetingReference(raw)
  if (parseMeetingReference(reference).cuePosition === undefined)
    throw new CliError("validation_error", "finding evidence requires exact cue references and fingerprints")
  return reference
}

export const validateMeetingFindings = (input: MeetingFindingsInput): MeetingFindingsInput =>
  validateFindings(input, { plural: "meeting findings", singular: "meeting finding", cited: "cue", reference: cue })
export const meetingFindingFingerprint = findingFingerprint
