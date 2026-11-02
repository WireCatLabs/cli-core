import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { MeetingFindingsInput } from "../meetings/index.js"
import { sampleMeeting } from "../meetings/testing/index.js"
import { cueEvidence } from "../services/meeting-evidence.js"
import { approveAsTask } from "../services/proposal-tasks.js"
import { openCache } from "./open.js"
import { openStore } from "./store.js"

const handles: { close(): unknown }[] = []
afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.close()
})
const account = { provider: "example", account: "synthetic-findings" }
const agent = { bot: "findings-test", model: "synthetic-extractor" }
const fixture = async () => {
  const path = join(mkdtempSync(join(tmpdir(), "meeting-findings-")), "store.db")
  const store = await openStore({ path, now: () => 1000 })
  handles.push(store)
  const accountId = await store.accounts.saveAccount(account, { name: "Synthetic" })
  const seed = sampleMeeting()
  seed.meeting.accountId = accountId
  const details = await store.meetings.saveMeeting(seed)
  const project = await store.knowledge.addProject({ name: "Harbour Observatory", key: "HOB" })
  await store.knowledge.linkMeetingProject(account, String(details.meeting.id), project.id, { by: "owner" })
  const transcript = details.transcripts[0]
  if (!transcript?.rows[0]) throw new Error("Missing synthetic cue")
  const cue = cueEvidence(accountId, details.meeting.id, transcript.transcript, transcript.rows[0])
  const evidence = [{ reference: cue.reference, fingerprint: cue.fingerprint }]
  const input: MeetingFindingsInput = {
    schemaVersion: 1,
    key: "batch-1",
    extractor: "synthetic",
    findings: [
      {
        id: "decision",
        kind: "fact",
        type: "decision",
        statement: "Launch in November",
        project: project.ref,
        evidence,
      },
      {
        id: "followup",
        kind: "task",
        type: "chore",
        title: "Prepare the draft",
        reason: "Review next meeting",
        commitment: "inferred",
        project: project.ref,
        evidence,
      },
    ],
  }
  const db = await openCache(path)
  handles.push(db)
  return { store, db, input, project, seed, accountId, details, account }
}

describe("reviewed meeting findings", () => {
  it("rechecks membership and project changes and keeps reviewed historical receipts", async () => {
    const f = await fixture()
    const batch = await f.store.meetingFindings.stage(account, f.input, agent)
    f.db.prepare("UPDATE links SET confirmed=0 WHERE kind='member-of'").run()
    await expect(
      f.store.meetingFindings.review(account, batch.id, {
        fingerprint: batch.fingerprint,
        accept: ["decision"],
        by: "owner",
      }),
    ).rejects.toThrow("confirmed membership")
    f.db.prepare("UPDATE links SET confirmed=1 WHERE kind='member-of'").run()
    f.db.prepare("UPDATE projects SET name='Renamed synthetic project' WHERE id=?").run(Number(f.project.id))
    await expect(
      f.store.meetingFindings.review(account, batch.id, {
        fingerprint: batch.fingerprint,
        accept: ["decision"],
        by: "owner",
      }),
    ).rejects.toMatchObject({ details: { reason: "meeting-findings.stale" } })
    const next = await f.store.meetingFindings.stage(account, { ...f.input, key: "new-preview" }, agent)
    const decision = { fingerprint: next.fingerprint, accept: ["decision"], by: "owner" as const }
    const reviewed = await f.store.meetingFindings.review(account, next.id, decision)
    f.seed.transcripts[0].contentHash = "corrected-synthetic-revision"
    f.seed.transcripts[0].rows[0].text = "A corrected synthetic statement"
    await f.store.meetings.saveMeeting(f.seed)
    expect(await f.store.meetingFindings.review(account, next.id, decision)).toEqual(reviewed)
    expect(await f.store.meetingFindings.stage(account, { ...f.input, key: "new-preview" }, agent)).toEqual(reviewed)
    const historical = await f.store.facts.get(reviewed.receipt?.items[0]?.reference as string)
    expect(historical.evidence).toEqual(f.input.findings[0]?.evidence.map((item) => item.reference))
  })
  it("creates a cited assignment and due date with normal task events", async () => {
    const f = await fixture()
    f.db.exec("INSERT INTO persons (id,name,owner,created_at,updated_at) VALUES (21,'Kai Sample',0,0,0)")
    const task = f.input.findings[1]
    if (task?.kind !== "task") throw new Error("Missing task")
    const supporting = task.evidence.map((item) => item.reference)
    const input = {
      ...f.input,
      findings: [
        {
          ...task,
          assignee: "person:21",
          assigneeEvidence: supporting,
          dueAt: "2026-11-01T10:00:00Z",
          dueEvidence: supporting,
        },
      ],
    }
    const batch = await f.store.meetingFindings.stage(account, input, agent)
    const reviewed = await f.store.meetingFindings.review(account, batch.id, {
      fingerprint: batch.fingerprint,
      accept: [task.id],
      by: "owner",
    })
    const made = await f.store.tasks.details(reviewed.receipt?.items[0]?.reference as string)
    expect(made).toMatchObject({
      dueAt: "2026-11-01T10:00:00.000Z",
      assignments: [{ to: "person:21", role: "assignee" }],
    })
    expect((await f.store.tasks.events(made.id)).map((item) => item.kind)).toContain("assigned")
  })

  it("stages without records, reviews once and reuses records across batches", async () => {
    const f = await fixture()
    const batch = await f.store.meetingFindings.stage(account, f.input, agent)
    expect(batch).toMatchObject({ status: "proposed", receipt: null, author: { name: agent.bot } })
    expect(await f.store.facts.list()).toEqual([])
    expect(await f.store.tasks.find({ project: f.project.ref })).toEqual([])
    expect(await f.store.meetingFindings.stage(account, f.input, agent)).toEqual(batch)
    const decision = { fingerprint: batch.fingerprint, accept: ["decision", "followup"], by: "owner" as const }
    const reviewed = await f.store.meetingFindings.review(account, batch.id, decision)
    expect(reviewed).toMatchObject({ decidedBy: { type: "person" }, decidedAt: new Date(1000).toISOString() })
    expect(reviewed.receipt?.items.map((x) => x.status)).toEqual(["accepted", "accepted"])
    expect((await f.store.meetingFindings.list(account, { status: "proposed" })).items).toEqual([])
    expect((await f.store.meetingFindings.list(account, { status: "reviewed" })).items.map((item) => item.id)).toEqual([
      batch.id,
    ])
    const fact = await f.store.facts.get(reviewed.receipt?.items[0]?.reference as string)
    expect(fact).toMatchObject({
      status: "accepted",
      source: "agent",
      model: agent.model,
      evidence: [f.input.findings[0]?.evidence[0]?.reference],
    })
    expect(await f.store.meetingFindings.review(account, batch.id, decision)).toEqual(reviewed)
    const second = await f.store.meetingFindings.stage(account, { ...f.input, key: "batch-2" }, agent)
    const repeated = await f.store.meetingFindings.review(account, second.id, {
      fingerprint: second.fingerprint,
      accept: decision.accept,
      by: "owner",
    })
    expect(repeated.receipt?.items.map((x) => [x.reference, x.reused])).toEqual(
      reviewed.receipt?.items.map((x) => [x.reference, true]),
    )
    expect(await f.store.facts.list()).toHaveLength(1)
    expect(await f.store.tasks.find({ project: f.project.ref })).toHaveLength(1)
  })
  it("reserves findings from generic proposal approval before any inbox task is made", async () => {
    const f = await fixture()
    const batch = await f.store.meetingFindings.stage(account, f.input, agent)
    await expect(approveAsTask(f.store, batch.id, "owner")).rejects.toMatchObject({
      details: { reason: "meeting-findings.dedicated-review" },
    })
    await expect(f.store.proposedActions.approve(batch.id, "owner")).rejects.toThrow("dedicated")
    await expect(f.store.proposedActions.reject(batch.id, "owner")).rejects.toThrow("dedicated")
    await expect(f.store.proposedActions.propose({ kind: "meeting_findings", by: agent })).rejects.toThrow("dedicated")
    expect(f.db.prepare("SELECT count(*) AS n FROM tasks").get()?.n).toBe(0)
  })
  it("rejects changed input under one key and conflicting re-review", async () => {
    const f = await fixture()
    const batch = await f.store.meetingFindings.stage(account, f.input, agent)
    await expect(f.store.meetingFindings.stage(account, { ...f.input, extractor: "different" }, agent)).rejects.toThrow(
      "different input",
    )
    await f.store.meetingFindings.review(account, batch.id, { fingerprint: batch.fingerprint, accept: [], by: "owner" })
    await expect(
      f.store.meetingFindings.review(account, batch.id, {
        fingerprint: batch.fingerprint,
        accept: ["decision"],
        by: "owner",
      }),
    ).rejects.toThrow("different decision")
    const next = await f.store.meetingFindings.stage(account, { ...f.input, key: "batch-2" }, agent)
    await expect(
      f.store.meetingFindings.review(account, next.id, {
        fingerprint: next.fingerprint,
        accept: ["decision"],
        by: "owner",
      }),
    ).rejects.toThrow("already rejected")
    expect(await f.store.facts.list()).toEqual([])
  })
  it("rolls back all accepted records, task numbering and receipt when a later write fails", async () => {
    const f = await fixture()
    const batch = await f.store.meetingFindings.stage(account, f.input, agent)
    f.db.exec(
      "CREATE TRIGGER fail_finding_task BEFORE INSERT ON tasks BEGIN SELECT RAISE(ABORT,'synthetic task failure'); END",
    )
    await expect(
      f.store.meetingFindings.review(account, batch.id, {
        fingerprint: batch.fingerprint,
        accept: ["decision", "followup"],
        by: "owner",
      }),
    ).rejects.toThrow("synthetic task failure")
    expect(await f.store.facts.list()).toEqual([])
    expect(await f.store.meetingFindings.get(account, batch.id)).toMatchObject({ status: "proposed", receipt: null })
    expect(f.db.prepare("SELECT tasks_count FROM projects WHERE id=?").get(Number(f.project.id))?.tasks_count).toBe(0)
  })
  it("rechecks cue hashes, revisions, membership and the selected account", async () => {
    const f = await fixture()
    const batch = await f.store.meetingFindings.stage(account, f.input, agent)
    f.db.prepare("UPDATE meeting_transcript_rows SET text='Changed synthetic cue'").run()
    await expect(
      f.store.meetingFindings.review(account, batch.id, {
        fingerprint: batch.fingerprint,
        accept: ["decision"],
        by: "owner",
      }),
    ).rejects.toMatchObject({ details: { reason: "meeting-findings.stale" } })
    expect(
      await f.store.meetingFindings.review(account, batch.id, {
        fingerprint: batch.fingerprint,
        accept: [],
        by: "owner",
      }),
    ).toMatchObject({ status: "reviewed", receipt: { accepted: [] } })
    await expect(f.store.meetingFindings.stage(account, { ...f.input, key: "changed" }, agent)).rejects.toMatchObject({
      details: { reason: "meeting-findings.stale" },
    })
    const other = { ...account, account: "other-synthetic" }
    await f.store.accounts.saveAccount(other, { name: "Other" })
    await expect(f.store.meetingFindings.get(other, batch.id)).rejects.toThrow("unavailable")
    await expect(f.store.meetingFindings.stage(other, f.input, agent)).rejects.toThrow("another account")
    expect(await f.store.facts.list()).toEqual([])
  })
  it("requires date/assignee evidence, bounds payloads and rejects payload-supplied actors", async () => {
    const f = await fixture()
    const task = f.input.findings[1]
    if (task?.kind !== "task") throw new Error("Missing task")
    await expect(
      f.store.meetingFindings.stage(
        account,
        { ...f.input, findings: [{ ...task, dueAt: "2026-11-01T10:00:00Z" }] },
        agent,
      ),
    ).rejects.toThrow("supporting evidence")
    await expect(
      f.store.meetingFindings.stage(account, { ...f.input, findings: [{ ...task, assignee: "person:1" }] }, agent),
    ).rejects.toThrow("supporting evidence")
    await expect(
      f.store.meetingFindings.stage(account, { ...f.input, extractor: "x".repeat(70000) }, agent),
    ).rejects.toThrow("65536")
    await expect(
      f.store.meetingFindings.stage(account, { ...f.input, by: "owner" } as MeetingFindingsInput, agent),
    ).rejects.toThrow("unknown")
  })
})
