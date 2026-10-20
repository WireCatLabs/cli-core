import { expect, it } from "vitest"
import { projectAnnotationsFixture } from "../../testing/project-annotations.js"
import { type ProjectAnnotationsTarget, planProjectAnnotations } from "./plan.js"
import type { ProjectAnnotationSnapshot } from "./snapshot-model.js"
import { planProjectAnnotationSnapshot } from "./snapshot-plan.js"

const fixture = (): ProjectAnnotationSnapshot => {
  const v1 = projectAnnotationsFixture()
  return {
    ...v1,
    version: 2,
    project: {
      ...v1.project,
      description: "An invented study",
      status: "active",
      owner: "person:7",
      updated_at: 1001,
      account_scope: "owner",
    },
    aliases: v1.aliases.map((name) => ({ name, source: "owner", display: false, created_at: 1000, updated_at: 1001 })),
    coverage: { ...v1.coverage, notes: "omitted", meeting_memberships: "omitted" },
    external: [...v1.external, { ref: "person:7", content_sha256: null }],
  }
}
const target = (): ProjectAnnotationsTarget => ({
  project: "project:91",
  revision_sha256: "b".repeat(64),
  annotation_count: 0,
  external: [
    { ref: "bot:71", content_sha256: null },
    { ref: "document:80", content_sha256: "a".repeat(64) },
    { ref: "person:72", content_sha256: null },
  ],
})
const bindings = () => ({
  "project:11": "project:91",
  "bot:4": "bot:71",
  "document:8": "document:80",
  "person:7": "person:72",
})

it("plans version2 with an independently bound project owner and no input mutations", () => {
  const m = fixture(),
    t = target(),
    b = bindings(),
    before = JSON.stringify({ m, t, b })
  const plan = planProjectAnnotationSnapshot(JSON.stringify(m), t, b)
  expect(plan).toMatchObject({ ready: true, conflicts: [], missing_bindings: [] })
  expect(JSON.stringify({ m, t, b })).toBe(before)
  expect(m.facts[0]?.status).toBe("proposed")
  expect(() => planProjectAnnotations(JSON.stringify(m), t, b)).toThrow("version")
  const { "person:7": _owner, ...withoutOwner } = b
  expect(planProjectAnnotationSnapshot(JSON.stringify(m), t, withoutOwner).missing_bindings).toEqual(["person:7"])
})

it.each([
  [
    "alias date",
    (m: ProjectAnnotationSnapshot) => {
      const alias = m.aliases[0]
      if (alias) alias.updated_at++
    },
  ],
  [
    "alias source",
    (m: ProjectAnnotationSnapshot) => {
      const alias = m.aliases[0]
      if (alias) alias.source = "import"
    },
  ],
  [
    "project description",
    (m: ProjectAnnotationSnapshot) => {
      m.project.description = "A revised description"
    },
  ],
])("binds %s to the preview fingerprint", (_name, change) => {
  const m = fixture(),
    initial = planProjectAnnotationSnapshot(JSON.stringify(m), target(), bindings())
  change(m)
  const revised = planProjectAnnotationSnapshot(JSON.stringify(m), target(), bindings())
  expect(revised.ready).toBe(true)
  expect(revised.manifest_fingerprint).not.toBe(initial.manifest_fingerprint)
  expect(revised.fingerprint).not.toBe(initial.fingerprint)
})

it("refuses stale sources and existing annotations and binds target revision", () => {
  const m = fixture(),
    t = target(),
    initial = planProjectAnnotationSnapshot(JSON.stringify(m), t, bindings())
  t.annotation_count = 1
  const document = t.external.find((e) => e.ref === "document:80")
  if (!document) throw new Error("Missing invented document")
  document.content_sha256 = "c".repeat(64)
  expect(planProjectAnnotationSnapshot(JSON.stringify(m), t, bindings())).toMatchObject({
    ready: false,
    conflicts: [
      { reference: "document:8", reason: "changed" },
      { reference: "project:91", reason: "populated" },
    ],
  })
  const fresh = target()
  fresh.revision_sha256 = "d".repeat(64)
  expect(planProjectAnnotationSnapshot(JSON.stringify(m), fresh, bindings()).fingerprint).not.toBe(initial.fingerprint)
})

it("preserves order independence and refuses mapping a project owner to a bot", () => {
  const m = fixture(),
    t = target(),
    initial = planProjectAnnotationSnapshot(JSON.stringify(m), t, bindings())
  m.aliases.reverse()
  m.external.reverse()
  t.external.reverse()
  expect(planProjectAnnotationSnapshot(JSON.stringify(m), t, bindings()).fingerprint).toBe(initial.fingerprint)
  expect(planProjectAnnotationSnapshot(JSON.stringify(m), t, { ...bindings(), "person:7": "bot:71" })).toMatchObject({
    ready: false,
    conflicts: [{ reference: "person:7", reason: "wrong_kind" }],
  })
})
