import { CliError } from "@wirecat/cli-base"
import { type MeetingFindingsInput, validateMeetingFindings } from "../meetings/index.js"

const keys: Record<string, string> = {
  schema_version: "schemaVersion",
  due_at: "dueAt",
  due_evidence: "dueEvidence",
  assignee_evidence: "assigneeEvidence",
}
export const parseMeetingFindingsJson = (text: string): MeetingFindingsInput => {
  if (Buffer.byteLength(text, "utf8") > 65536)
    throw new CliError("validation_error", "meeting findings take at most 65536 UTF-8 bytes")
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new CliError("validation_error", "meeting findings input must be valid JSON")
  }
  const decode = (value: unknown, depth = 0): unknown => {
    if (depth > 16) throw new CliError("validation_error", "meeting findings JSON is nested too deeply")
    if (Array.isArray(value)) return value.map((item) => decode(item, depth + 1))
    if (value === null || typeof value !== "object") return value
    const output: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) {
      if (/[A-Z]/.test(key)) throw new CliError("validation_error", "meeting findings JSON fields use snake_case")
      const name = keys[key] ?? key
      if (Object.hasOwn(output, name)) throw new CliError("validation_error", "duplicate meeting findings field")
      Object.defineProperty(output, name, { value: decode(item, depth + 1), enumerable: true })
    }
    return output
  }
  return validateMeetingFindings(decode(raw) as MeetingFindingsInput)
}
