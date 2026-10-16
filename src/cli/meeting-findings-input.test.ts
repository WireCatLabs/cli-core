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
