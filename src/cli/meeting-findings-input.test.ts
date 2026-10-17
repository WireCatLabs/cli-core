import { expect, it } from "vitest"
import { parseMeetingFindingsJson } from "./meeting-findings-input.js"

const input = {
  schema_version: 1,
  key: "batch",
  extractor: "synthetic",
  findings: [
    {
      id: "followup",
      kind: "task",
      type: "chore",
      project: "project:1",
      title: "Prepare draft",
      reason: "Discuss next call",
      commitment: "inferred",
      evidence: [{ reference: "meeting:1/2/3/0", fingerprint: "a".repeat(64) }],
      due_at: "2026-11-01T10:00:00Z",
      due_evidence: ["meeting:1/2/3/0"],
    },
  ],
}
it("maps public JSON names to the shared typed findings contract without changing evidence", () => {
  expect(parseMeetingFindingsJson(JSON.stringify(input)).findings[0]).toMatchObject({
    dueAt: "2026-11-01T10:00:00.000Z",
    dueEvidence: ["meeting:1/2/3/0"],
    evidence: input.findings[0]?.evidence,
  })
})
it("rejects actor injection, unsupported names, malformed JSON and oversized input", () => {
  expect(() => parseMeetingFindingsJson(JSON.stringify({ ...input, by: "owner" }))).toThrow("unknown")
  expect(() => parseMeetingFindingsJson(JSON.stringify({ ...input, schemaVersion: 1 }))).toThrow("snake_case")
  expect(() => parseMeetingFindingsJson("{")).toThrow("valid JSON")
  expect(() => parseMeetingFindingsJson(" ".repeat(65537))).toThrow("65536")
})
it.each(["2026-02-30T10:00:00Z", "2026-11-01T10:00:00"])("rejects an ambiguous or invalid due date: %s", (due_at) => {
  const findings = input.findings.map((finding) => ({ ...finding, due_at }))
  expect(() => parseMeetingFindingsJson(JSON.stringify({ ...input, findings }))).toThrow()
})
it("normalizes an explicitly offset due date", () => {
  const findings = input.findings.map((finding) => ({ ...finding, due_at: "2026-11-01T12:00:00+02:00" }))
  expect(parseMeetingFindingsJson(JSON.stringify({ ...input, findings })).findings[0]).toMatchObject({
    dueAt: "2026-11-01T10:00:00.000Z",
  })
})
it("rejects a non-string due date rather than coercing it", () => {
  const findings = input.findings.map((finding) => ({ ...finding, due_at: ["2026-11-01T10:00:00Z"] }))
  expect(() => parseMeetingFindingsJson(JSON.stringify({ ...input, findings }))).toThrow("timestamp")
})

it.each([{ assignee: ["person:1"] }, { assignee: 1 }, { assignee: {} }])(
  "rejects a non-string assignee rather than coercing it: $assignee",
  ({ assignee }) => {
    const findings = input.findings.map((finding) => ({
      ...finding,
      assignee,
      assignee_evidence: ["meeting:1/2/3/0"],
    }))
    expect(() => parseMeetingFindingsJson(JSON.stringify({ ...input, findings }))).toThrow("person reference")
  },
)
