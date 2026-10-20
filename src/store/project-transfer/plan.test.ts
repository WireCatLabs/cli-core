import { expect, it } from "vitest"
import { projectAnnotationsFixture } from "../../testing/project-annotations.js"
import { type ProjectAnnotationsTarget, planProjectAnnotations } from "./plan.js"

const json = () => JSON.stringify(projectAnnotationsFixture())
const target = (): ProjectAnnotationsTarget => ({
  project: "project:91",
  revision_sha256: "b".repeat(64),
  annotation_count: 0,
  external: [
    { ref: "bot:71", content_sha256: null },
    { ref: "document:80", content_sha256: "a".repeat(64) },
  ],
})
const bindings = () => ({ "project:11": "project:91", "bot:4": "bot:71", "document:8": "document:80" })

it("plans explicit bindings to different IDs without changing its inputs", () => {
  const t = target(),
    b = bindings(),
    before = JSON.stringify({ t, b })
  const plan = planProjectAnnotations(json(), t, b)
  expect(plan).toMatchObject({ ready: true, missing_bindings: [], conflicts: [] })
  expect(JSON.stringify({ t, b })).toBe(before)
  t.external.reverse()
  expect(planProjectAnnotations(json(), t, Object.fromEntries(Object.entries(b).reverse())).fingerprint).toBe(
    plan.fingerprint,
  )
  t.revision_sha256 = "c".repeat(64)
  expect(planProjectAnnotations(json(), t, b).fingerprint).not.toBe(plan.fingerprint)
})

it("lists missing bindings and refuses stale, wrong-kind and populated target snapshots", () => {
  expect(planProjectAnnotations(json(), target(), {}).missing_bindings).toEqual(["project:11", "bot:4", "document:8"])
  const t = target()
  t.annotation_count = 1
  t.external = []
  const result = planProjectAnnotations(json(), t, { ...bindings(), "bot:4": "person:7" })
  expect(result).toMatchObject({
    ready: false,
    conflicts: expect.arrayContaining([
      { reference: "bot:4", reason: "wrong_kind" },
      { reference: "document:8", reason: "missing" },
      { reference: "project:91", reason: "populated" },
    ]),
  })
  const stale = target()
  stale.external = stale.external.map((e) => ({
    ...e,
    content_sha256: e.ref.startsWith("document:") ? "d".repeat(64) : null,
  }))
  expect(planProjectAnnotations(json(), stale, bindings()).conflicts).toEqual([
    { reference: "document:8", reason: "changed" },
  ])
})

it("rejects malformed targets, unknown bindings and duplicate external identities", () => {
  expect(() => planProjectAnnotations(json(), Object.assign(target(), { text: "source body" }), bindings())).toThrow(
    "plan.text",
  )
  expect(() => planProjectAnnotations(json(), target(), { ...bindings(), "person:7": "person:8" })).toThrow(
    "plan.bindings",
  )
  const t = target()
  t.external.push({ ...(t.external[0] as ProjectAnnotationsTarget["external"][number]) })
  expect(() => planProjectAnnotations(json(), t, bindings())).toThrow("target.external.duplicate")
  expect(() => planProjectAnnotations(json(), target(), Object.create(bindings()))).toThrow("plan.bindings")
})

it("refuses collapsing different source actors into one destination actor", () => {
  const m = projectAnnotationsFixture()
  const first = m.facts[0]
  if (!first) throw new Error("missing fixture")
  m.facts.push({ ...first, ref: "fact:21", author: "bot:5" })
  m.external.push({ ref: "bot:5", content_sha256: null })
  const result = planProjectAnnotations(JSON.stringify(m), target(), { ...bindings(), "bot:5": "bot:71" })
  expect(result).toMatchObject({ ready: false, conflicts: [{ reference: "bot:5", reason: "duplicate" }] })
})
