import { CliError } from "@wirecat/cli-base"
import { type MailFindingsInput, validateMailFindings } from "../mail/findings.js"
import { type FindingsInput, type MeetingFindingsInput, validateMeetingFindings } from "../meetings/index.js"
import { validateEvidenceFindings } from "../store/evidence-findings.js"

const keys: Record<string, string> = {
  schema_version: "schemaVersion",
  due_at: "dueAt",
  due_evidence: "dueEvidence",
  assignee_evidence: "assigneeEvidence",
  memory_kind: "memoryKind",
  issue_date: "issueDate",
  due_date: "dueDate",
  unit_price: "unitPrice",
  supplier_name: "supplierName",
  order_date: "orderDate",
  fulfilled_date: "fulfilledDate",
}
const parseFindingsJson = <T>(text: string, label: string, validate: (input: T) => T): T => {
  if (Buffer.byteLength(text, "utf8") > 65536)
    throw new CliError("validation_error", `${label} take at most 65536 UTF-8 bytes`)
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new CliError("validation_error", `${label} input must be valid JSON`)
  }
  // A payment keeps its snake_case fields: it is stored and printed as written.
  const decode = (value: unknown, depth = 0, verbatim = false): unknown => {
    if (depth > 16) throw new CliError("validation_error", `${label} JSON is nested too deeply`)
    if (Array.isArray(value)) return value.map((item) => decode(item, depth + 1))
    if (value === null || typeof value !== "object") return value
    const output: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) {
      if (/[A-Z]/.test(key)) throw new CliError("validation_error", `${label} JSON fields use snake_case`)
      const name = verbatim ? key : (keys[key] ?? key)
      if (Object.hasOwn(output, name)) throw new CliError("validation_error", `duplicate ${label} field`)
      Object.defineProperty(output, name, { value: decode(item, depth + 1, key === "payment"), enumerable: true })
    }
    return output
  }
  return validate(decode(raw) as T)
}
export const parseMeetingFindingsJson = (text: string): MeetingFindingsInput =>
  parseFindingsJson(text, "meeting findings", validateMeetingFindings)
export const parseEvidenceFindingsJson = (text: string): FindingsInput =>
  parseFindingsJson(text, "evidence findings", validateEvidenceFindings)
/** A mail findings batch as `mail findings add` reads it: snake_case JSON, checked for shape before the store. */
export const parseMailFindingsJson = (text: string): MailFindingsInput =>
  parseFindingsJson(text, "mail findings", validateMailFindings)
