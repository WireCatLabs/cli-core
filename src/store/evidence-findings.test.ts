import { afterEach, expect, it } from "vitest"
import { parseEvidenceFindingsJson } from "../cli/meeting-findings-input.js"
import { contextEvidenceFingerprint } from "../context/evidence.js"
import type { FindingsInput } from "../meetings/index.js"
import { contextEvidenceFixture } from "../testing/context-evidence.js"

const handles: { close(): unknown }[] = []
afterEach(async () => {
  for (const h of handles.splice(0)) await h.close()
})
const agent = { bot: "evidence-test", model: "synthetic-extractor" }

const fixture = async () => {
  const f = await contextEvidenceFixture()
  handles.push(f)
  const records = f.store.contextRecords
  if (!records) throw new Error("Missing record reader")
  const message = "msg:example-calendar/AliceExample/planning/3"
  const cite = async (ref: string) => {
    const record = await records.read(ref)
    if (!record) throw new Error(`Missing ${ref}`)
    return { reference: ref, fingerprint: contextEvidenceFingerprint(record) }
  }
  const project = (await f.store.knowledge.projects())[0]
  if (!project) throw new Error("Missing project")
  const input = async (key = "run-1"): Promise<FindingsInput> => ({
    schemaVersion: 1,
    key,
    extractor: "synthetic",
    findings: [
      {
        id: "launch",
        kind: "fact",
        type: "decision",
        statement: "The harbour launch is the third one",
        project: project.ref,
        evidence: [await cite(message)],
      },
      {
        id: "checklist",
        kind: "task",
        type: "chore",
        title: "Review the launch checklist",
        reason: "The checklist document is the plan",
        commitment: "inferred",
        project: project.ref,
        evidence: [await cite(f.doc.ref), await cite(message)],
      },
    ],
  })
  return { ...f, message, project, input, cite }
}

it("stages one project's cited findings once per key and refuses a reused key with other input", async () => {
  const f = await fixture()
  const batch = await f.store.evidenceFindings.stage(await f.input(), agent)
  expect(batch).toMatchObject({ project: f.project.ref, status: "proposed", previous: [], receipt: null })
  expect((await f.store.evidenceFindings.stage(await f.input(), agent)).id).toBe(batch.id)
  const changed = await f.input()
  changed.extractor = "other"
  await expect(f.store.evidenceFindings.stage(changed, agent)).rejects.toThrow("already used")
  const other = await f.store.knowledge.addProject({ name: "Other Example" })
  const mixed = await f.input("run-2")
  mixed.findings[1] = { ...mixed.findings[1], project: other.ref } as FindingsInput["findings"][number]
  await expect(f.store.evidenceFindings.stage(mixed, agent)).rejects.toThrow("one project")
  await expect(f.store.evidenceFindings.stage(await f.input("run-3"), { bot: "owner" })).rejects.toThrow("agent author")
  expect(await f.store.evidenceFindings.list({ project: f.project.ref, status: "proposed" })).toMatchObject({
    items: [{ id: batch.id }],
    hasMore: false,
  })
  expect((await f.store.evidenceFindings.list({ project: other.ref })).items).toEqual([])
})

it("refuses evidence whose text changed or was never stored", async () => {
  const f = await fixture()
  const stale = await f.input()
  stale.findings[0]?.evidence.splice(0, 1, { reference: f.message, fingerprint: "0".repeat(64) })
  await expect(f.store.evidenceFindings.stage(stale, agent)).rejects.toMatchObject({
    details: { reason: "evidence-findings.stale" },
  })
  const missing = await f.input("run-2")
  missing.findings[0]?.evidence.splice(0, 1, { reference: "document:999999", fingerprint: "0".repeat(64) })
  await expect(f.store.evidenceFindings.stage(missing, agent)).rejects.toMatchObject({
    details: { reason: "evidence-findings.stale" },
  })
  const batch = await f.store.evidenceFindings.stage(await f.input("run-3"), agent)
  f.db
    .prepare("UPDATE messages SET text='Harbour launch moved' WHERE account_id=? AND external_id='3'")
    .run(f.accountId)
  await expect(
    f.store.evidenceFindings.review(batch.id, { fingerprint: batch.fingerprint, accept: ["launch"] }),
  ).rejects.toMatchObject({ details: { reason: "evidence-findings.stale" } })
  expect(await f.store.evidenceFindings.review(batch.id, { fingerprint: batch.fingerprint, accept: [] })).toMatchObject(
    { status: "reviewed", receipt: { accepted: [], items: [{ status: "rejected" }, { status: "rejected" }] } },
  )
})

it("accepts the findings whose own evidence is unchanged when another finding's text changed", async () => {
  const f = await fixture()
  const batch = await f.store.evidenceFindings.stage(await f.input(), agent)
  f.db.prepare("UPDATE documents SET body='Launch list moved' WHERE id=?").run(Number(f.doc.id))
  await expect(
    f.store.evidenceFindings.review(batch.id, { fingerprint: batch.fingerprint, accept: ["checklist"] }),
  ).rejects.toMatchObject({ details: { reason: "evidence-findings.stale" } })
  const reviewed = await f.store.evidenceFindings.review(batch.id, {
    fingerprint: batch.fingerprint,
    accept: ["launch"],
  })
  expect(reviewed.receipt?.items.map((item) => [item.id, item.status])).toEqual([
    ["launch", "accepted"],
    ["checklist", "rejected"],
  ])
  const renamed = await f.store.evidenceFindings.stage(await f.input("run-2"), agent)
  f.db.prepare("UPDATE projects SET name='Renamed Example' WHERE id=?").run(Number(f.project.ref.slice(8)))
  await expect(
    f.store.evidenceFindings.review(renamed.id, { fingerprint: renamed.fingerprint, accept: ["launch"] }),
  ).rejects.toMatchObject({ details: { reason: "evidence-findings.stale" } })
})

it("lets the owner, or an agent with a reason, decide; later batches reuse the decisions", async () => {
  const f = await fixture()
  const batch = await f.store.evidenceFindings.stage(await f.input(), agent)
  await expect(
    f.store.evidenceFindings.review(batch.id, {
      fingerprint: batch.fingerprint,
      accept: ["launch"],
      by: { bot: "evidence-test", reason: " " },
    }),
  ).rejects.toThrow("reason")
  const reviewed = await f.store.evidenceFindings.review(batch.id, {
    fingerprint: batch.fingerprint,
    accept: ["launch"],
    by: { bot: "evidence-test", model: "m", reason: "the message states it plainly" },
  })
  expect(reviewed).toMatchObject({
    status: "reviewed",
    decidedBy: { type: "bot" },
    receipt: {
      accepted: ["launch"],
      decision: { by: "agent", bot: "evidence-test", model: "m", reason: "the message states it plainly" },
      items: [
        { id: "launch", status: "accepted", reused: false },
        { id: "checklist", status: "rejected", reference: null },
      ],
    },
  })
  const fact = reviewed.receipt?.items[0]?.reference
  expect(fact).toMatch(/^fact:/)
  expect(
    await f.store.evidenceFindings.review(batch.id, { fingerprint: batch.fingerprint, accept: ["launch"] }),
  ).toMatchObject({ id: batch.id })
  await expect(
    f.store.evidenceFindings.review(batch.id, { fingerprint: batch.fingerprint, accept: [] }),
  ).rejects.toThrow("different decision")

  const again = await f.store.evidenceFindings.stage(await f.input("run-2"), agent)
  expect(again.previous.map((item) => [item.id, item.status, item.reused])).toEqual([
    ["launch", "accepted", true],
    ["checklist", "rejected", true],
  ])
  await expect(
    f.store.evidenceFindings.review(again.id, { fingerprint: again.fingerprint, accept: ["checklist"] }),
  ).rejects.toThrow("already rejected")
  const owner = await f.store.evidenceFindings.review(again.id, { fingerprint: again.fingerprint, accept: [] })
  expect(owner).toMatchObject({ decidedBy: { type: "person" }, receipt: { decision: { by: "owner" } } })
  expect(owner.receipt?.items[0]).toMatchObject({ reference: fact, reused: true })
})

it("is reviewed only through its own store, never as a generic proposal", async () => {
  const f = await fixture()
  const batch = await f.store.evidenceFindings.stage(await f.input(), agent)
  await expect(f.store.proposedActions.approve(batch.id)).rejects.toMatchObject({
    details: { reason: "evidence-findings.dedicated-review" },
  })
  await expect(f.store.proposedActions.reject(batch.id)).rejects.toThrow("dedicated")
  await expect(f.store.proposedActions.propose({ kind: "evidence_findings", by: agent })).rejects.toThrow("dedicated")
})

it("reads a batch closed with nothing accepted as rejected, and one with a finding accepted as approved", async () => {
  const f = await fixture()
  const none = await f.store.evidenceFindings.stage(await f.input(), agent)
  await f.store.evidenceFindings.review(none.id, { fingerprint: none.fingerprint, accept: [] })
  const other = await f.input("run-2")
  for (const finding of other.findings)
    if (finding.kind === "fact") finding.statement = "The harbour launch is the fourth one"
    else finding.title = "Print the launch checklist"
  const some = await f.store.evidenceFindings.stage(other, agent)
  await f.store.evidenceFindings.review(some.id, { fingerprint: some.fingerprint, accept: ["launch"] })

  expect(await f.store.proposedActions.get(none.id)).toMatchObject({ status: "rejected", result: { accepted: [] } })
  expect(await f.store.proposedActions.get(some.id)).toMatchObject({ status: "approved" })
  expect((await f.store.proposedActions.list({ status: "rejected" })).map((one) => one.id)).toEqual([none.id])
  expect((await f.store.proposedActions.list({ status: "approved" })).map((one) => one.id)).toEqual([some.id])
  expect(await f.store.evidenceFindings.get(none.id)).toMatchObject({ status: "reviewed" })
})

it("reads every reference a batch cites back once, with a short excerpt", async () => {
  const f = await fixture()
  const batch = await f.store.evidenceFindings.stage(await f.input(), agent)
  const sources = await f.store.evidenceFindings.sources(batch.id)
  expect(sources.map((one) => one.ref)).toEqual([f.message, f.doc.ref])
  expect(sources[0]).toMatchObject({ kind: "message", missing: false, excerpt: expect.any(String) })
  expect(sources[1]).toMatchObject({ kind: "document", missing: false })
  for (const one of sources) expect(one.excerpt?.length ?? 0).toBeLessThanOrEqual(280)

  f.db.prepare("DELETE FROM messages WHERE account_id=? AND external_id='3'").run(f.accountId)
  expect((await f.store.evidenceFindings.sources(batch.id))[0]).toMatchObject({
    ref: f.message,
    kind: "message",
    excerpt: null,
    missing: true,
  })
})

it("reads a staged batch from snake_case JSON with msg: and document: evidence", () => {
  const fingerprint = "a".repeat(64)
  const input = parseEvidenceFindingsJson(
    JSON.stringify({
      schema_version: 1,
      key: "run-1",
      extractor: "synthetic",
      findings: [
        {
          id: "plan",
          kind: "task",
          type: "chore",
          title: "Read the plan",
          reason: "It is the plan",
          commitment: "explicit",
          project: "project:1",
          evidence: [{ reference: "document:4", fingerprint }],
          due_at: "2026-11-01T00:00:00Z",
          due_evidence: ["document:4"],
        },
      ],
    }),
  )
  expect(input.findings[0]).toMatchObject({ dueEvidence: ["document:4"], evidence: [{ reference: "document:4" }] })
  expect(() =>
    parseEvidenceFindingsJson(
      JSON.stringify({ ...JSON.parse(JSON.stringify(input)), schemaVersion: undefined, schema_version: 1 }),
    ),
  ).toThrow("snake_case")
  expect(() =>
    parseEvidenceFindingsJson(
      JSON.stringify({
        schema_version: 1,
        key: "k",
        extractor: "x",
        findings: [
          {
            id: "a",
            kind: "fact",
            type: "fact",
            statement: "s",
            project: "project:1",
            evidence: [{ reference: "meeting:1/2/3", fingerprint }],
          },
        ],
      }),
    ),
  ).toThrow("msg: or document:")
})
