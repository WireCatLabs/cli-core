import { afterEach, expect, it } from "vitest"
import { parseEvidenceFindingsJson } from "../cli/findings-input.js"
import { contextEvidenceFingerprint } from "../context/evidence.js"
import type { FindingsInput } from "../meetings/index.js"
import { contextEvidenceFixture } from "../testing/context-evidence.js"
import { validateEvidenceFindings } from "./evidence-findings.js"

const handles: { close(): unknown }[] = []
afterEach(async () => {
  for (const h of handles.splice(0)) await h.close()
})
const agent = { bot: "evidence-test", model: "synthetic-extractor" }

const fixture = async () => {
  const f = await contextEvidenceFixture(undefined, { agentDecisions: true, ruleProposalsOwnerOnly: true })
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
  expect(batch).toMatchObject({
    project: f.project.ref,
    subject: f.project.ref,
    status: "proposed",
    previous: [],
    receipt: null,
  })
  expect((await f.store.evidenceFindings.stage(await f.input(), agent)).id).toBe(batch.id)
  const changed = await f.input()
  changed.extractor = "other"
  await expect(f.store.evidenceFindings.stage(changed, agent)).rejects.toThrow("already used")
  const other = await f.store.knowledge.addProject({ name: "Other Example" })
  const mixed = await f.input("run-2")
  mixed.findings[1] = { ...mixed.findings[1], project: other.ref } as FindingsInput["findings"][number]
  await expect(f.store.evidenceFindings.stage(mixed, agent)).rejects.toThrow("one project at most")
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
    f.store.evidenceFindings.review(batch.id, { fingerprint: batch.fingerprint, accept: ["launch"], by: "owner" }),
  ).rejects.toMatchObject({ details: { reason: "evidence-findings.stale" } })
  expect(
    await f.store.evidenceFindings.review(batch.id, { fingerprint: batch.fingerprint, accept: [], by: "owner" }),
  ).toMatchObject({
    status: "reviewed",
    receipt: { accepted: [], items: [{ status: "rejected" }, { status: "rejected" }] },
  })
})

it("accepts the findings whose own evidence is unchanged when another finding's text or the project changed", async () => {
  const f = await fixture()
  const batch = await f.store.evidenceFindings.stage(await f.input(), agent)
  f.db.prepare("UPDATE documents SET body='Launch list moved' WHERE id=?").run(Number(f.doc.id))
  await expect(
    f.store.evidenceFindings.review(batch.id, { fingerprint: batch.fingerprint, accept: ["checklist"], by: "owner" }),
  ).rejects.toMatchObject({ details: { reason: "evidence-findings.stale" } })
  const partly = await f.store.evidenceFindings.review(batch.id, {
    fingerprint: batch.fingerprint,
    accept: ["launch"],
    by: "owner",
  })
  const reviewed = await f.store.evidenceFindings.review(batch.id, {
    fingerprint: partly.fingerprint,
    accept: [],
    by: "owner",
  })
  expect(reviewed.receipt?.items.map((item) => [item.id, item.status])).toEqual([
    ["launch", "accepted"],
    ["checklist", "rejected"],
  ])
  const renamed = await f.store.evidenceFindings.stage(await f.input("run-2"), agent)
  f.db.prepare("UPDATE projects SET name='Renamed Example' WHERE id=?").run(Number(f.project.ref.slice(8)))
  expect(
    await f.store.evidenceFindings.review(renamed.id, {
      fingerprint: renamed.fingerprint,
      accept: ["launch", "checklist"],
      by: "owner",
    }),
  ).toMatchObject({ status: "reviewed" })
})

it("lets the owner, or an agent with a reason, decide; later batches reuse the decisions", async () => {
  const f = await fixture()
  const batch = await f.store.evidenceFindings.stage(await f.input(), agent)
  await expect(
    f.store.evidenceFindings.review(batch.id, {
      fingerprint: batch.fingerprint,
      accept: ["launch"],
      by: { bot: "evidence-reviewer", reason: " " },
    }),
  ).rejects.toThrow("reason")
  const reviewer = { bot: "evidence-reviewer", model: "m", reason: "the message states it plainly" }
  const partly = await f.store.evidenceFindings.review(batch.id, {
    fingerprint: batch.fingerprint,
    accept: ["launch"],
    by: reviewer,
  })
  expect(partly).toMatchObject({ status: "proposed", decided: [{ id: "launch", status: "accepted" }] })
  const reviewed = await f.store.evidenceFindings.review(batch.id, {
    fingerprint: partly.fingerprint,
    accept: [],
    by: reviewer,
  })
  expect(reviewed).toMatchObject({
    status: "reviewed",
    decidedBy: { type: "bot" },
    receipt: {
      accepted: ["launch"],
      decision: { by: "agent", bot: "evidence-reviewer", model: "m", reason: "the message states it plainly" },
      items: [
        { id: "launch", status: "accepted", reused: false },
        { id: "checklist", status: "rejected", reference: null },
      ],
    },
  })
  const fact = reviewed.receipt?.items[0]?.reference
  expect(fact).toMatch(/^fact:/)
  expect(
    await f.store.evidenceFindings.review(batch.id, {
      fingerprint: reviewed.fingerprint,
      accept: ["launch"],
      by: "owner",
    }),
  ).toMatchObject({ id: batch.id })
  await expect(
    f.store.evidenceFindings.review(batch.id, { fingerprint: reviewed.fingerprint, accept: [], by: "owner" }),
  ).rejects.toThrow("different decision")

  const again = await f.store.evidenceFindings.stage(await f.input("run-2"), agent)
  expect(again.previous.map((item) => [item.id, item.status, item.reused])).toEqual([
    ["launch", "accepted", true],
    ["checklist", "rejected", true],
  ])
  await expect(
    f.store.evidenceFindings.review(again.id, { fingerprint: again.fingerprint, accept: ["checklist"], by: "owner" }),
  ).rejects.toThrow("already rejected")
  const owner = await f.store.evidenceFindings.review(again.id, {
    fingerprint: again.fingerprint,
    accept: [],
    by: "owner",
  })
  expect(owner).toMatchObject({ decidedBy: { type: "person" }, receipt: { decision: { by: "owner" } } })
  expect(owner.receipt?.items[0]).toMatchObject({ reference: fact, reused: true })
})

it("is reviewed only through its own store, never as a generic proposal", async () => {
  const f = await fixture()
  const batch = await f.store.evidenceFindings.stage(await f.input(), agent)
  await expect(f.store.proposedActions.approve(batch.id, "owner")).rejects.toMatchObject({
    details: { reason: "evidence-findings.dedicated-review" },
  })
  await expect(f.store.proposedActions.reject(batch.id, "owner")).rejects.toThrow("dedicated")
  await expect(f.store.proposedActions.propose({ kind: "evidence_findings", by: agent })).rejects.toThrow("dedicated")
})

it("reads a batch closed with nothing accepted as rejected, and one with a finding accepted as approved", async () => {
  const f = await fixture()
  const none = await f.store.evidenceFindings.stage(await f.input(), agent)
  await f.store.evidenceFindings.review(none.id, { fingerprint: none.fingerprint, accept: [], by: "owner" })
  const other = await f.input("run-2")
  for (const finding of other.findings)
    if (finding.kind === "fact") finding.statement = "The harbour launch is the fourth one"
    else if (finding.kind === "task") finding.title = "Print the launch checklist"
  const some = await f.store.evidenceFindings.stage(other, agent)
  const partly = await f.store.evidenceFindings.review(some.id, {
    fingerprint: some.fingerprint,
    accept: ["launch"],
    by: "owner",
  })
  await f.store.evidenceFindings.review(some.id, { fingerprint: partly.fingerprint, accept: [], by: "owner" })

  expect(await f.store.proposedActions.get(none.id)).toMatchObject({ status: "rejected", result: { accepted: [] } })
  expect(await f.store.proposedActions.get(some.id)).toMatchObject({ status: "approved" })
  expect((await f.store.proposedActions.list({ status: "rejected" })).items.map((one) => one.id)).toEqual([none.id])
  expect((await f.store.proposedActions.list({ status: "approved" })).items.map((one) => one.id)).toEqual([some.id])
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

it("stages findings about a person or about nobody, citing a note, and the owner's pick reads accepted at once", async () => {
  const f = await fixture()
  const lena = await f.store.people.add({ name: "Lena Example" })
  const note = await f.store.notes.addNote({ text: "Call with Lena: she moves to Valencia in March" })
  const about = (key: string, subject?: string): FindingsInput => ({
    schemaVersion: 1,
    key,
    extractor: "synthetic",
    findings: [
      {
        id: "move",
        kind: "fact",
        type: "fact",
        statement: `Lena moves to Valencia in March (${key})`,
        ...(subject === undefined ? {} : { subject }),
        evidence: [],
      },
    ],
  })
  const person = about("person-1", `person:${lena.uid}`)
  person.findings[0]?.evidence.push(await f.cite(note.ref))
  const batch = await f.store.evidenceFindings.stage(person, agent)
  expect(batch).toMatchObject({ project: null, subject: `person:${lena.uid}`, status: "proposed" })
  expect(await f.store.evidenceFindings.sources(batch.id)).toMatchObject([{ ref: note.ref, kind: "note" }])

  const reviewed = await f.store.evidenceFindings.review(batch.id, {
    fingerprint: batch.fingerprint,
    accept: ["move"],
    by: "owner",
  })
  const fact = reviewed.receipt?.items[0]?.reference as string
  expect(await f.store.facts.get(fact)).toMatchObject({
    status: "accepted",
    subject: `person:${lena.uid}`,
    project: null,
  })

  const nobody = about("nobody-1")
  nobody.findings[0]?.evidence.push(await f.cite(note.ref))
  expect(await f.store.evidenceFindings.stage(nobody, agent)).toMatchObject({ project: null, subject: null })

  const task = await f.input("task-1")
  const { project: _project, ...homeless } = task.findings[1] as FindingsInput["findings"][number]
  await expect(
    f.store.evidenceFindings.stage({ ...task, findings: [homeless as FindingsInput["findings"][number]] }, agent),
  ).rejects.toThrow("names the project the task goes in")
})

it("lists a batch about a person under the project its findings name", async () => {
  const f = await fixture()
  const lena = await f.store.people.add({ name: "Lena Example" })
  const input = await f.input("person-project")
  for (const finding of input.findings) if (finding.kind === "fact") finding.subject = `person:${lena.uid}`
  input.findings = input.findings.filter((finding) => finding.kind === "fact")
  const batch = await f.store.evidenceFindings.stage(input, agent)
  expect(batch).toMatchObject({ project: f.project.ref, subject: `person:${lena.uid}` })
  expect((await f.store.evidenceFindings.list({ project: f.project.ref })).items.map(({ id }) => id)).toContain(
    batch.id,
  )
})

it("keeps a batch approvable after a sibling batch of the same project is decided, until its own source changes", async () => {
  const f = await fixture()
  const first = await f.store.evidenceFindings.stage(await f.input(), agent)
  const other = await f.input("run-2")
  for (const finding of other.findings)
    if (finding.kind === "fact") finding.statement = "The harbour launch is the fourth one"
    else if (finding.kind === "task") finding.title = "Print the launch checklist"
  const second = await f.store.evidenceFindings.stage(other, agent)
  await f.store.evidenceFindings.review(first.id, {
    fingerprint: first.fingerprint,
    accept: ["launch", "checklist"],
    by: "owner",
  })
  // The fixture's clock stands still; a real decision moves the project's updated_at with the task it creates.
  f.db.prepare("UPDATE projects SET updated_at = updated_at + 1000").run()

  const third = await f.input("run-3")
  for (const finding of third.findings)
    if (finding.kind === "fact") finding.statement = "The harbour launch is the fifth one"
    else if (finding.kind === "task") finding.title = "Sign the launch checklist"
  const stale = await f.store.evidenceFindings.stage(third, agent)

  expect(
    await f.store.evidenceFindings.review(second.id, {
      fingerprint: second.fingerprint,
      accept: ["launch", "checklist"],
      by: "owner",
    }),
  ).toMatchObject({ status: "reviewed", receipt: { accepted: ["checklist", "launch"] } })

  f.db
    .prepare("UPDATE messages SET text='Harbour launch moved' WHERE account_id=? AND external_id='3'")
    .run(f.accountId)
  await expect(
    f.store.evidenceFindings.review(stale.id, { fingerprint: stale.fingerprint, accept: ["launch"], by: "owner" }),
  ).rejects.toMatchObject({ details: { reason: "evidence-findings.stale" } })
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
  ).toThrow("msg:, document: or note:")
})

it("checks a quoted finding's words against the cited text, and keeps the quote on the accepted fact's evidence", async () => {
  const f = await fixture()
  const note = await f.store.notes.addNote({ text: "Call notes: delivery moves to the 28th of May" })
  const quoted = (key: string): FindingsInput => ({
    schemaVersion: 1,
    key,
    extractor: "synthetic",
    findings: [{ id: "delivery", kind: "fact", type: "fact", statement: "Delivery is on 28 May", evidence: [] }],
  })
  const invented = quoted("quote-1")
  invented.findings[0]?.evidence.push({ ...(await f.cite(note.ref)), quote: "delivery moves to the 30th" })
  await expect(f.store.evidenceFindings.stage(invented, agent)).rejects.toMatchObject({
    details: { reason: "finding.quote-not-found" },
  })

  const kept = quoted("quote-2")
  kept.findings[0]?.evidence.push({ ...(await f.cite(note.ref)), quote: "delivery  moves\nto the 28th" })
  const batch = await f.store.evidenceFindings.stage(kept, agent)
  const reviewed = await f.store.evidenceFindings.review(batch.id, {
    fingerprint: batch.fingerprint,
    accept: ["delivery"],
    by: "owner",
  })
  const fact = String(reviewed.receipt?.items[0]?.reference).replace("fact:", "")
  const link = f.db
    .prepare("SELECT metadata FROM links WHERE from_type = 'fact' AND from_id = ? AND kind = 'evidence'")
    .get(Number(fact))
  expect(JSON.parse(String(link?.metadata)).quote).toBe("delivery  moves\nto the 28th")
})

it("reads a finding without a quote as before, so its fingerprint is unchanged", async () => {
  const f = await fixture()
  const plain = validateEvidenceFindings(await f.input())
  expect(plain.findings[0]?.evidence[0]).not.toHaveProperty("quote")
  const batch = await f.store.evidenceFindings.stage(await f.input(), agent)
  expect(batch.input.findings[0]?.evidence[0]).toEqual(await f.cite(f.message))
  expect(await f.store.evidenceFindings.citable(f.message)).toMatchObject(await f.cite(f.message))
  expect(await f.store.evidenceFindings.citable("document:999999")).toBeNull()
})

it("refuses every agent on a batch staged owner-only, even with agent decisions on", async () => {
  const f = await fixture()
  const batch = await f.store.evidenceFindings.stage(await f.input("owner-1"), agent, { ownerOnly: true })
  expect(batch.ownerOnly).toBe(true)
  await expect(
    f.store.evidenceFindings.review(batch.id, {
      fingerprint: batch.fingerprint,
      accept: ["launch"],
      by: { bot: "evidence-reviewer", reason: "the message states it plainly" },
    }),
  ).rejects.toMatchObject({ details: { reason: "proposal.owner-only" } })
  const reviewed = await f.store.evidenceFindings.review(batch.id, {
    fingerprint: batch.fingerprint,
    accept: ["launch", "checklist"],
    by: "owner",
  })
  expect(reviewed.receipt?.decision).toEqual({ by: "owner" })
  expect((await f.store.evidenceFindings.stage(await f.input("plain-1"), agent)).ownerOnly).toBe(false)
})

it("leaves the findings a confirm does not name pending, and creates nothing twice", async () => {
  const f = await fixture()
  const batch = await f.store.evidenceFindings.stage(await f.input(), agent)
  const partly = await f.store.evidenceFindings.review(batch.id, {
    fingerprint: batch.fingerprint,
    accept: ["launch"],
    by: "owner",
  })
  expect(partly).toMatchObject({ status: "proposed", receipt: null })
  expect(partly.decided.map((item) => [item.id, item.status])).toEqual([["launch", "accepted"]])
  const facts = () => f.db.prepare("SELECT count(*) AS n FROM facts").get()?.n
  const made = facts()
  const done = await f.store.evidenceFindings.review(batch.id, {
    fingerprint: partly.fingerprint,
    accept: ["launch", "checklist"],
    by: "owner",
  })
  expect(done.status).toBe("reviewed")
  expect(done.receipt?.items.map((item) => [item.id, item.status])).toEqual([
    ["launch", "accepted"],
    ["checklist", "accepted"],
  ])
  expect(facts()).toBe(made)
})

it("rejects only what is still pending after a partial confirm", async () => {
  const f = await fixture()
  const batch = await f.store.evidenceFindings.stage(await f.input(), agent)
  const partly = await f.store.evidenceFindings.review(batch.id, {
    fingerprint: batch.fingerprint,
    accept: ["launch"],
    by: "owner",
  })
  const closed = await f.store.evidenceFindings.review(batch.id, {
    fingerprint: partly.fingerprint,
    accept: [],
    by: "owner",
  })
  expect(closed.receipt?.items.map((item) => [item.id, item.status])).toEqual([
    ["launch", "accepted"],
    ["checklist", "rejected"],
  ])
})

it("lets the owner edit a waiting fact and task, never their evidence, and the agent's rerun still finds the batch", async () => {
  const f = await fixture()
  const input = await f.input()
  const batch = await f.store.evidenceFindings.stage(input, agent)
  await expect(
    f.store.evidenceFindings.edit(
      batch.id,
      "launch",
      { project: "project:99" },
      {
        fingerprint: batch.fingerprint,
        by: "owner",
      },
    ),
  ).rejects.toMatchObject({ details: { reason: "finding.unknown-field" } })
  const fact = await f.store.evidenceFindings.edit(
    batch.id,
    "launch",
    { statement: "The harbour launch is late" },
    {
      fingerprint: batch.fingerprint,
      by: "owner",
    },
  )
  await expect(
    f.store.evidenceFindings.edit(
      batch.id,
      "checklist",
      { assignee: "person:999999", assigneeEvidence: [f.message] },
      {
        fingerprint: fact.fingerprint,
        by: "owner",
      },
    ),
  ).rejects.toThrow()
  const task = await f.store.evidenceFindings.edit(
    batch.id,
    "checklist",
    { title: "Print the checklist" },
    {
      fingerprint: fact.fingerprint,
      by: "owner",
    },
  )
  expect(task.edited).toEqual(["launch", "checklist"])
  expect((await f.store.evidenceFindings.stage(input, agent)).id).toBe(batch.id)
  const done = await f.store.evidenceFindings.review(batch.id, {
    fingerprint: task.fingerprint,
    accept: ["launch", "checklist"],
    by: "owner",
  })
  const made = await f.store.facts.get(done.receipt?.items[0]?.reference as string)
  expect(made.statement).toBe("The harbour launch is late")
})
