import { expect, it } from "vitest"
import { decodeProjectAnnotations, PROJECT_ANNOTATIONS_MAX_BYTES, projectAnnotationsFingerprint } from "./manifest.js"
import type { ProjectAnnotations } from "./schema.js"

const fixture = (): ProjectAnnotations => ({
  format: "wirecat.project-annotations",
  version: 1,
  project: {
    ref: "project:11",
    key: "RES",
    name: "Research",
    type: "work",
    scope: "work",
    organization: null,
    created_at: 1000,
  },
  coverage: {
    aliases: "complete",
    facts: "complete",
    links: "complete",
    memories: "omitted",
    tasks: "omitted",
    labels: "omitted",
    findings: "omitted",
  },
  aliases: ["Investigations", "Study"],
  facts: [
    {
      ref: "fact:20",
      type: "statement",
      statement: "The sender reported delivery; delivery was not independently checked.",
      status: "proposed",
      subject: null,
      occurred_at: 900,
      supersedes: null,
      author: "bot:4",
      model: null,
      confirmed_by: null,
      scope: "work",
      source: "agent",
      created_at: 1000,
      updated_at: 1001,
    },
  ],
  links: [
    {
      ref: "link:30",
      from: "fact:20",
      to: "document:8",
      kind: "evidence",
      role: null,
      evidence: null,
      confirmed: false,
      provenance: null,
      created_at: 1000,
    },
  ],
  external: [
    { ref: "bot:4", content_sha256: null },
    { ref: "document:8", content_sha256: "a".repeat(64) },
  ],
})
const at = <T>(items: T[], index: number): T => {
  const item = items[index]
  if (item === undefined) throw new Error("missing fixture record")
  return item
}
const decode = (value: unknown) => decodeProjectAnnotations(JSON.stringify(value))

it("preserves proposed authorship and external evidence without source bodies", () => {
  expect(decode(fixture())).toEqual(fixture())
  const changed = fixture()
  at(changed.links, 0).to = "meeting:2/3/4/0"
  at(changed.external, 1).ref = "meeting:2/3/4/0"
  expect(decode(changed).external[1]?.ref).toBe("meeting:2/3/4/0")
})

it("hashes equivalent JSON property and record ordering equally, but includes lifecycle and coverage", () => {
  const first = fixture(),
    second = fixture()
  second.aliases.reverse()
  second.external.reverse()
  const reversed = Object.fromEntries(Object.entries(second).reverse())
  const fingerprint = projectAnnotationsFingerprint(JSON.stringify(first))
  expect(projectAnnotationsFingerprint(JSON.stringify(reversed))).toBe(fingerprint)
  at(second.facts, 0).status = "accepted"
  at(second.facts, 0).confirmed_by = "bot:4"
  expect(projectAnnotationsFingerprint(JSON.stringify(second))).not.toBe(fingerprint)
})

it.each([
  ["version", (m: ProjectAnnotations) => Object.assign(m, { version: 2 })],
  ["unknown source body", (m: ProjectAnnotations) => Object.assign(at(m.external, 1), { text: "private corpus" })],
  [
    "missing fingerprint",
    (m: ProjectAnnotations) => {
      at(m.external, 1).content_sha256 = null
    },
  ],
  [
    "noncanonical reference",
    (m: ProjectAnnotations) => {
      at(m.external, 1).ref = " document:8 "
    },
  ],
  [
    "missing binding dependency",
    (m: ProjectAnnotations) => {
      m.external.pop()
    },
  ],
  [
    "unrelated graph",
    (m: ProjectAnnotations) => {
      at(m.links, 0).from = "bot:4"
    },
  ],
  [
    "alias collision",
    (m: ProjectAnnotations) => {
      m.aliases.push("RESEARCH")
    },
  ],
  [
    "duplicate identity",
    (m: ProjectAnnotations) => {
      m.facts.push(at(m.facts, 0))
    },
  ],
  [
    "unused source",
    (m: ProjectAnnotations) => {
      m.external.push({ ref: "person:6", content_sha256: null })
    },
  ],
  ["invented coverage", (m: ProjectAnnotations) => Object.assign(m.coverage, { tasks: "complete" })],
  [
    "invalid lifecycle",
    (m: ProjectAnnotations) => {
      at(m.facts, 0).status = "reversed"
    },
  ],
  [
    "time reversal",
    (m: ProjectAnnotations) => {
      at(m.facts, 0).updated_at = 0
    },
  ],
  [
    "unbounded records",
    (m: ProjectAnnotations) => {
      m.aliases = Array(1001).fill("alias")
    },
  ],
] as const)("refuses %s before a host may restore anything", (_name, change) => {
  const m = fixture()
  change(m)
  expect(() => decode(m)).toThrowError(expect.objectContaining({ code: "validation_error" }))
})

it("refuses malformed JSON and byte overflow before decoding", () => {
  expect(() => decodeProjectAnnotations("{")).toThrow("annotations.json")
  expect(() => decodeProjectAnnotations(" ".repeat(PROJECT_ANNOTATIONS_MAX_BYTES + 1))).toThrow("annotations.bytes")
})

it("refuses a decision replacement cycle and references to a different project's decision", () => {
  const m = fixture()
  const first = at(m.facts, 0)
  first.type = "decision"
  first.supersedes = "fact:21"
  m.external.push({ ref: "fact:21", content_sha256: null })
  expect(() => decode(m)).toThrow("supersedes outside project")
  m.external.pop()
  m.facts.push({ ...first, ref: "fact:21", supersedes: first.ref })
  expect(() => decode(m)).toThrow("supersedes cycle")
  first.supersedes = null
  expect(decode(m).facts).toHaveLength(2)
})

it("refuses a combined record budget overrun even when each array fits", () => {
  const m = fixture()
  m.aliases = Array.from({ length: 998 }, (_, n) => `alias ${n}`)
  expect(() => decode(m)).toThrow("record budget")
})
