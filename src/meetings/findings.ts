import { createHash } from "node:crypto"
import { CliError } from "@wirecat/cli-base"
import { FACT_TYPES, WORK_TASK_TYPES } from "../domain/knowledge.js"
import type { AccountKey } from "../store/types.js"
import { canonicalMeetingReference, parseMeetingReference } from "./reference.js"

export const MEETING_FINDINGS_KIND = "meeting_findings"
export interface FindingEvidence {
  reference: string
  fingerprint: string
}
interface FindingBase {
  id: string
  project: string
  evidence: FindingEvidence[]
}
export interface MeetingFactFinding extends FindingBase {
  kind: "fact"
  type: (typeof FACT_TYPES)[number]
  statement: string
}
export interface MeetingTaskFinding extends FindingBase {
  kind: "task"
  type: (typeof WORK_TASK_TYPES)[number]
  title: string
  reason: string
  commitment: "explicit" | "inferred"
  dueAt?: string
  dueEvidence?: string[]
  assignee?: string
  assigneeEvidence?: string[]
}
export type MeetingFinding = MeetingFactFinding | MeetingTaskFinding
export interface MeetingFindingsInput {
  schemaVersion: 1
  key: string
  extractor: string
  findings: MeetingFinding[]
}
export interface FindingOutcome {
  id: string
  fingerprint: string
  status: "accepted" | "rejected"
  reference: string | null
  reused: boolean
}
export interface MeetingFindingsReceipt {
  previewFingerprint: string
  accepted: string[]
  items: FindingOutcome[]
}
export interface MeetingFindingsBatch {
  id: string
  account: AccountKey
  input: MeetingFindingsInput
  fingerprint: string
  status: "proposed" | "reviewed"
  author: { type: string; id: string; name: string | null }
  previous: FindingOutcome[]
  receipt: MeetingFindingsReceipt | null
}
export interface MeetingFindingsStore {
  stage(
    account: AccountKey,
    input: MeetingFindingsInput,
    agent: { bot: string; model?: string },
  ): Promise<MeetingFindingsBatch>
  get(account: AccountKey, id: string): Promise<MeetingFindingsBatch>
  list(
    account: AccountKey,
    options?: { limit?: number; offset?: number },
  ): Promise<{ items: MeetingFindingsBatch[]; hasMore: boolean }>
  review(
    account: AccountKey,
    id: string,
    input: { fingerprint: string; accept: string[] },
  ): Promise<MeetingFindingsBatch>
}
const invalid = (message: string): never => {
  throw new CliError("validation_error", message)
}
const text = (value: unknown, limit: number): string => {
  if (typeof value !== "string" || !value.trim() || value.includes("\0") || value.length > limit)
    return invalid(`finding text must contain 1–${limit} characters without NUL`)
  return value.trim()
}
export const findingHash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex")
const fields = (value: object, allowed: string[]) => {
  if (Object.keys(value).some((key) => !allowed.includes(key))) invalid("unknown meeting finding field")
}
export const validateMeetingFindings = (input: MeetingFindingsInput): MeetingFindingsInput => {
  if (!input || typeof input !== "object" || Buffer.byteLength(JSON.stringify(input), "utf8") > 65536)
    return invalid("meeting findings take at most 65536 UTF-8 bytes")
  fields(input, ["schemaVersion", "key", "extractor", "findings"])
  if (
    input.schemaVersion !== 1 ||
    !Array.isArray(input.findings) ||
    input.findings.length < 1 ||
    input.findings.length > 16
  )
    return invalid("schemaVersion 1 takes 1–16 meeting findings")
  const key = text(input.key, 64)
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/.test(key))
    return invalid("a findings key uses letters, digits, dot, colon, underscore or hyphen")
  const ids = new Set<string>()
  const findings = input.findings.map((finding): MeetingFinding => {
    if (!finding || typeof finding !== "object") return invalid("a finding is an object")
    const id = text(finding.id, 64)
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/.test(id) || ids.has(id))
      return invalid("finding IDs must be unique simple keys")
    ids.add(id)
    const project = text(finding.project, 64)
    if (!/^project:[1-9]\d*$/.test(project)) return invalid("a finding names a project reference")
    if (!Array.isArray(finding.evidence) || finding.evidence.length < 1 || finding.evidence.length > 8)
      return invalid("a finding requires 1–8 cited cues")
    const evidence = finding.evidence
      .map((item) => {
        if (!item || typeof item !== "object") return invalid("finding evidence is a reference and fingerprint")
        fields(item, ["reference", "fingerprint"])
        if (typeof item.reference !== "string" || typeof item.fingerprint !== "string")
          return invalid("evidence requires a reference and fingerprint")
        const reference = canonicalMeetingReference(item.reference)
        if (parseMeetingReference(reference).cuePosition === undefined || !/^[a-f0-9]{64}$/.test(item.fingerprint))
          return invalid("finding evidence requires exact cue references and fingerprints")
        return { reference, fingerprint: item.fingerprint }
      })
      .sort((a, b) => a.reference.localeCompare(b.reference))
    if (new Set(evidence.map((item) => item.reference)).size !== evidence.length)
      return invalid("duplicate evidence cue")
    const base = { id, project, evidence }
    if (finding.kind === "fact") {
      fields(finding, ["id", "project", "evidence", "kind", "type", "statement"])
      if (!FACT_TYPES.includes(finding.type)) return invalid("unknown fact finding type")
      return { ...base, kind: "fact", type: finding.type, statement: text(finding.statement, 2000) }
    }
    if (finding.kind !== "task") return invalid("a finding is a fact or task")
    fields(finding, [
      "id",
      "project",
      "evidence",
      "kind",
      "type",
      "title",
      "reason",
      "commitment",
      "dueAt",
      "dueEvidence",
      "assignee",
      "assigneeEvidence",
    ])
    if (!WORK_TASK_TYPES.includes(finding.type)) return invalid("a task finding type is bug, chore or feature")
    if (!["explicit", "inferred"].includes(finding.commitment))
      return invalid("task commitment must be explicit or inferred")
    const support = (value: unknown): string[] => {
      if (
        !Array.isArray(value) ||
        value.length < 1 ||
        value.length > 8 ||
        value.some((ref) => typeof ref !== "string" || !evidence.some((item) => item.reference === ref))
      )
        return invalid("date and assignee support must cite the finding's evidence")
      return [...new Set(value as string[])].sort()
    }
    if (
      (finding.dueAt === undefined) !== (finding.dueEvidence === undefined) ||
      (finding.assignee === undefined) !== (finding.assigneeEvidence === undefined)
    )
      return invalid("optional dates and assignees require their supporting evidence")
    if (
      finding.dueAt !== undefined &&
      (!/^\d{4}-\d{2}-\d{2}T/.test(finding.dueAt) || !Number.isFinite(Date.parse(finding.dueAt)))
    )
      return invalid("a due date is an ISO timestamp")
    if (finding.assignee !== undefined && !/^person:[1-9]\d*$/.test(finding.assignee))
      return invalid("an assignee must be a person reference")
    return {
      ...base,
      kind: "task",
      type: finding.type,
      title: text(finding.title, 300),
      reason: text(finding.reason, 2000),
      commitment: finding.commitment,
      ...(finding.dueAt === undefined
        ? {}
        : { dueAt: new Date(finding.dueAt).toISOString(), dueEvidence: support(finding.dueEvidence) }),
      ...(finding.assignee === undefined
        ? {}
        : { assignee: finding.assignee, assigneeEvidence: support(finding.assigneeEvidence) }),
    }
  })
  return { schemaVersion: 1, key, extractor: text(input.extractor, 200), findings }
}
export const meetingFindingFingerprint = ({ id: _id, ...finding }: MeetingFinding): string => findingHash(finding)
