import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { contextEvidenceFingerprint } from "../../context/evidence.js"
import { sampleMeeting } from "../../meetings/testing/index.js"
import { mayDecide } from "../../store/decisions.js"
import { openStore } from "../../store/store.js"
import { contextEvidenceFixture } from "../../testing/context-evidence.js"
import { storeOnlyDeps } from "../deps.js"
import { cueEvidence } from "../meeting-evidence.js"
import { tasksService } from "../tasks.js"
import { proposalRegistry } from "./registry.js"

const handles: { close(): unknown }[] = []
afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.close()
})
const agent = { bot: "claude-code", model: "synthetic" }
const codex = { bot: "codex", reason: "the evidence names the project" }

const fixture = async () => {
  const f = await contextEvidenceFixture(undefined, { agentDecisions: true, ruleProposalsOwnerOnly: true })
  handles.push(f)
  const project = (await f.store.knowledge.projects())[0]
  if (!project) throw new Error("Missing project")
  const record = await f.store.contextRecords?.read(f.doc.ref)
  if (!record) throw new Error("Missing record")
  const evidence = [{ reference: f.doc.ref, fingerprint: contextEvidenceFingerprint(record) }]
  const stage = (key: string) =>
    f.store.evidenceFindings.stage(
      {
        schemaVersion: 1,
        key,
        extractor: "synthetic",
        findings: [
          {
            id: "launch",
            kind: "fact",
            type: "decision",
            statement: "Launch is planned",
            project: project.ref,
            evidence,
          },
          {
            id: "checklist",
            kind: "task",
            type: "chore",
            title: "Review the checklist",
            reason: "The document is the plan",
            commitment: "inferred",
            project: project.ref,
            evidence,
          },
        ],
      },
      agent,
    )
  return { ...f, project, stage, registry: proposalRegistry(f.store) }
}

describe("the findings kind", () => {
  it("lists a batch with its parts, confirms only the parts named and rejects the rest", async () => {
    const f = await fixture()
    const batch = await f.stage("one")
    const listed = await f.registry.list({ limit: 10, offset: 0, kinds: ["findings"], project: f.project.ref })
    expect(listed.items).toMatchObject([
      {
        id: batch.id,
        kind: "findings",
        status: "proposed",
        summary: "2 findings",
        proposedBy: { type: "bot", name: "claude-code", kind: "agent" },
        evidence: [f.doc.ref],
        parts: [
          { id: "launch", kind: "fact", outcome: null },
          { id: "checklist", kind: "task", outcome: null },
        ],
      },
    ])
    expect((await f.registry.list({ limit: 10, offset: 0, kinds: ["findings"], by: { bot: "codex" } })).items).toEqual(
      [],
    )
    const own = await f.registry.decide([batch.id], { confirm: true, by: { ...agent, reason: "mine" } })
    expect(own.refused).toMatchObject([{ reason: "proposal.own" }])
    const { decided } = await f.registry.decide([`${batch.id}/launch`], { confirm: true, by: codex })
    expect(decided).toMatchObject([
      { id: batch.id, kind: "findings", status: "confirmed", made: [expect.stringMatching(/^fact:/)] },
    ])
    const row = await f.registry.get(batch.id)
    expect(row).toMatchObject({
      status: "confirmed",
      parts: [
        { id: "launch", outcome: "accepted" },
        { id: "checklist", outcome: "rejected" },
      ],
    })
    expect(
      (await f.registry.list({ limit: 10, offset: 0, kinds: ["findings"], status: "confirmed" })).items,
    ).toHaveLength(1)
    expect((await f.registry.decide([batch.id], { confirm: true, by: "owner" })).refused).toMatchObject([
      { reason: "proposal.wrong-state" },
    ])
  })

  it("confirms every finding not rejected before, and rejects a whole batch", async () => {
    const f = await fixture()
    const batch = await f.stage("all")
    const all = await f.registry.decide([batch.id], { confirm: true, by: "owner", reason: "checked" })
    expect(all.decided[0]?.made).toHaveLength(2)
    expect((await f.store.evidenceFindings.get(batch.id)).receipt?.decision).toEqual({ by: "owner", reason: "checked" })
    const next = await f.stage("none")
    const none = await f.registry.decide([next.id], { confirm: false, by: "owner" })
    expect(none.decided).toMatchObject([{ status: "rejected", made: [] }])
    expect(
      (await f.registry.list({ limit: 10, offset: 0, kinds: ["findings"], status: "rejected" })).items,
    ).toMatchObject([{ id: next.id }])
  })
})

describe("the key document kind", () => {
  it("decides a stored key document proposal and records the link", async () => {
    const f = await fixture()
    const proposal = await f.store.proposedActions.propose({
      kind: "key_document",
      by: agent,
      target: f.doc.ref,
      payload: { ref: f.doc.ref, project: f.project.ref },
      reason: "the plan for the launch",
    })
    expect(await f.registry.list({ limit: 10, offset: 0, kinds: ["key_document"] })).toMatchObject({
      items: [{ id: proposal.id, kind: "key_document", subject: f.doc.ref, project: f.project.ref }],
    })
    expect(
      (await f.registry.decide([proposal.id], { confirm: true, by: { ...agent, reason: "x" } })).refused,
    ).toMatchObject([{ reason: "proposal.own" }])
    const { decided } = await f.registry.decide([proposal.id], { confirm: true, by: codex })
    expect(decided).toMatchObject([
      { kind: "key_document", status: "confirmed", made: [expect.stringMatching(/^link:/)] },
    ])
    expect(await f.store.notes.links({ from: f.doc.ref, role: "key" })).toMatchObject([
      { to: f.project.ref, confirmed: true, provenance: expect.stringContaining("agent:codex for the owner") },
    ])
    const other = await f.store.proposedActions.propose({
      kind: "key_document",
      by: agent,
      target: f.doc.ref,
      payload: { ref: f.doc.ref, project: f.project.ref },
    })
    await f.registry.decide([other.id], { confirm: false, by: "owner", reason: "already key" })
    expect(await f.registry.get(other.id)).toMatchObject({ status: "rejected" })
  })

  it("leaves an older suggested key link to the owner, who confirms or rejects it in place", async () => {
    const f = await fixture()
    const note = await f.store.notes.addNote({ text: "Launch notes" })
    const suggest = (from: string) =>
      f.store.notes.addLink({
        from,
        to: f.project.ref,
        kind: "related-to",
        role: "key",
        origin: "suggested",
        confirmed: false,
        provenance: "agent:codex",
        evidence: "the plan",
      })
    const first = await suggest(f.doc.ref)
    const second = await suggest(note.ref)
    const listed = await f.registry.list({ limit: 10, offset: 0, kinds: ["key_document"] })
    expect(listed.items.map((row) => row.id).sort()).toEqual([`key:${first.id}`, `key:${second.id}`].sort())
    expect(listed.items[0]?.proposedBy).toEqual({ type: "unknown" })
    expect(
      (await f.registry.list({ limit: 10, offset: 0, kinds: ["key_document"], status: "rejected" })).items,
    ).toEqual([])
    expect((await f.registry.decide([`key:${first.id}`], { confirm: true, by: codex })).refused).toMatchObject([
      { reason: "proposal.owner-only" },
    ])
    const owner = await f.registry.decide([`key:${first.id}`, `key:${second.id}`, "key:999999"], {
      confirm: true,
      by: "owner",
    })
    expect(owner.decided.map((one) => one.made)).toEqual([[`link:${first.id}`], [`link:${second.id}`]])
    expect(owner.refused).toMatchObject([{ id: "key:999999", code: "not_found" }])
    const fourth = await f.store.notes.addLink({
      from: note.ref,
      to: f.project.ref,
      kind: "related-to",
      role: "key",
      anchor: "second",
      origin: "suggested",
      confirmed: false,
      provenance: "agent:codex",
    })
    const rejected = await f.registry.decide([`key:${fourth.id}`], { confirm: false, by: "owner" })
    expect(rejected.decided).toMatchObject([{ status: "rejected", made: [] }])
    await expect(f.registry.get(`key:${fourth.id}`)).rejects.toMatchObject({ code: "not_found" })
  })
})

describe("the action kind", () => {
  it("lists other stored proposals, makes a confirmed one a task and keeps a rejection's reason", async () => {
    const f = await fixture()
    await f.store.accounts.saveAccount({ provider: "example", account: "a1" }, { name: "Example" })
    const propose = () =>
      f.store.proposedActions.propose({ kind: "reply", by: agent, account: { provider: "example", account: "a1" } })
    const reply = await propose()
    const ban = await propose()
    await f.stage("hidden")
    expect((await f.registry.list({ limit: 10, offset: 0, kinds: ["action"] })).items.map((row) => row.id)).toEqual([
      ban.id,
      reply.id,
    ])
    expect(await f.registry.get(reply.id)).toMatchObject({ kind: "action", summary: "reply", status: "proposed" })
    const { decided } = await f.registry.decide([reply.id], { confirm: true, by: codex })
    expect(decided).toMatchObject([{ kind: "action", status: "confirmed", made: [expect.stringMatching(/^task:/)] }])
    await f.registry.decide([ban.id], { confirm: false, by: "owner", reason: "not now" })
    expect(await f.store.proposedActions.get(ban.id)).toMatchObject({
      status: "rejected",
      result: { reason: "not now" },
    })
  })
})

describe("the owner-only meeting findings and task close kinds", () => {
  const ownerOnlyFixture = async () => {
    const store = await openStore({
      path: join(mkdtempSync(join(tmpdir(), "owner-kinds-")), "store.db"),
      decisions: { agentDecisions: true, ruleProposalsOwnerOnly: true },
    })
    handles.push(store)
    const account = { provider: "example", account: "synthetic" }
    const seed = sampleMeeting()
    seed.meeting.accountId = await store.accounts.saveAccount(account, { name: "Synthetic" })
    const meeting = await store.meetings.saveMeeting(seed)
    const project = await store.knowledge.addProject({ name: "Harbour Observatory", key: "HOB" })
    await store.knowledge.linkMeetingProject(account, String(meeting.meeting.id), project.id, { by: "owner" })
    const transcript = meeting.transcripts[0]
    if (!transcript?.rows[0]) throw new Error("Missing synthetic cue")
    const cue = cueEvidence(seed.meeting.accountId, meeting.meeting.id, transcript.transcript, transcript.rows[0])
    const evidence = [{ reference: cue.reference, fingerprint: cue.fingerprint }]
    const task = (id: string, title: string) => ({
      id,
      kind: "task" as const,
      type: "chore" as const,
      title,
      reason: "asked in the meeting",
      commitment: "inferred" as const,
      project: project.ref,
      evidence,
    })
    await store.tasks.create({ project: project.ref, title: "Send the signed lease", type: "chore" }, "owner")
    const [board] = await store.tasks.find({ project: project.ref, status: "open", limit: 1 })
    const note = await store.notes.addNote({ text: "Synthetic request" })
    const app = { command: "chat", appName: "chat-cli", envPrefix: "CHAT", description: "", version: "1.0.0" }
    const { task: noted } = await tasksService(storeOnlyDeps(store, account, { app })).add(note.ref, "request", "owner")
    const [lease, request] = [board, await store.tasks.details(noted.id)]
    if (!lease) throw new Error("Missing task")
    for (const one of [lease, request])
      await store.tasks.suggestClose(one.id, { as: "done", certainty: 0.8, reason: "you replied" }, { bot: "codex" })
    const batch = await store.meetingFindings.stage(
      account,
      {
        schemaVersion: 1,
        key: "followups",
        extractor: "synthetic",
        findings: [task("a", "Draft"), task("b", "Budget")],
      },
      agent,
    )
    return { store, project, batch, lease, request, registry: proposalRegistry(store) }
  }

  it("lists each once, owner only, and refuses an agent on every one", async () => {
    const f = await ownerOnlyFixture()
    const { items } = await f.registry.list({ limit: 10, offset: 0 })
    expect(items.map((row) => [row.kind, row.ownerOnly])).toEqual(
      expect.arrayContaining([
        ["meeting_findings", true],
        ["task_close", true],
        ["task_close", true],
      ]),
    )
    expect(items).toHaveLength(3)
    expect(await f.registry.get(`close:${f.lease.key}`)).toMatchObject({
      kind: "task_close",
      subject: f.lease.ref,
      score: 0.8,
      reason: "you replied",
      ownerOnly: true,
    })
    const ids = [f.batch.id, `close:${f.lease.key}`]
    for (const confirm of [true, false]) {
      const tried = await f.registry.decide(ids, { confirm, by: codex })
      expect(tried.decided).toEqual([])
      expect(tried.refused.map((one) => one.reason)).toEqual(["proposal.owner-only", "proposal.owner-only"])
    }
    const close = await f.registry.get(`close:${f.lease.key}`)
    const unmarked = { id: close.id, proposedBy: close.proposedBy, kind: close.kind }
    expect(mayDecide(unmarked, codex, f.store.decisionPolicy)).toMatchObject({ reason: "proposal.owner-only" })
  })

  it("on the owner's confirm makes the meeting tasks named and closes the suggested tasks", async () => {
    const f = await ownerOnlyFixture()
    const ids = [`${f.batch.id}/a`, `close:${f.lease.key}`, `close:${f.request.key}`]
    const { decided, refused } = await f.registry.decide(ids, { confirm: true, by: "owner" })
    expect(refused).toEqual([])
    expect(decided).toMatchObject([
      { kind: "meeting_findings", status: "confirmed", made: [expect.stringMatching(/^task:/)] },
      { kind: "task_close", status: "confirmed", made: [f.lease.ref] },
      { kind: "task_close", status: "confirmed", made: [f.request.ref] },
    ])
    const titles = (await f.store.tasks.find({ project: f.project.ref, limit: 10 })).map((one) => one.title)
    expect(titles).toContain("Draft")
    expect(titles).not.toContain("Budget")
    expect(await f.store.tasks.details(f.lease.id)).toMatchObject({ status: "done", closeSuggestion: null })
    expect(await f.store.tasks.get(f.request.id)).toMatchObject({ state: "done", reason: "you replied" })
    expect((await f.registry.list({ limit: 10, offset: 0, kinds: ["task_close"] })).items).toEqual([])
  })

  it("on the owner's reject leaves the task open without the suggestion", async () => {
    const f = await ownerOnlyFixture()
    const { decided } = await f.registry.decide([`close:${f.lease.key}`], { confirm: false, by: "owner" })
    expect(decided).toMatchObject([{ kind: "task_close", status: "rejected", made: [] }])
    expect(await f.store.tasks.details(f.lease.id)).toMatchObject({ status: "open", closeSuggestion: null })
  })
})
