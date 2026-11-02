import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { contextEvidenceFingerprint } from "../context/evidence.js"
import type { MeetingFindingsInput } from "../meetings/index.js"
import { sampleMeeting } from "../meetings/testing/index.js"
import { cueEvidence } from "../services/meeting-evidence.js"
import { approveAsTask } from "../services/proposal-tasks.js"
import { contextEvidenceFixture } from "../testing/context-evidence.js"
import { type Decider, mayDecide, type Proposer } from "./decisions.js"
import { type MessageStore, openStore } from "./store.js"

const handles: { close(): unknown }[] = []
afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.close()
})

const bot = (name: string, kind: "agent" | "rule" = "agent"): Proposer => ({ type: "bot", id: "1", name, kind })
const self: Decider = { bot: "claude-code", reason: "the chat names the project" }

describe("mayDecide", () => {
  const policy = { agentDecisions: true, ruleProposalsOwnerOnly: true }
  it.each([
    ["the owner, always", bot("claude-code"), "owner", policy, null],
    ["an agent with a reason, on another bot's proposal", bot("codex"), self, policy, null],
    ["an agent on the owner's proposal", { type: "person", id: "1" }, self, policy, null],
    [
      "an agent without a reason",
      bot("codex"),
      { bot: "claude-code", reason: " " },
      policy,
      "proposal.reason-required",
    ],
    [
      "an agent when agent decisions are off",
      bot("codex"),
      self,
      { ...policy, agentDecisions: false },
      "proposals.agent-decisions-off",
    ],
    ["an agent on its own proposal", bot("claude-code"), self, policy, "proposal.own"],
    ["an agent on a rule's proposal", bot("memo-scan", "rule"), self, policy, "proposal.owner-only"],
    [
      "an agent on a rule's proposal the policy opens",
      bot("memo-scan", "rule"),
      self,
      { ...policy, ruleProposalsOwnerOnly: false },
      null,
    ],
    ["an agent on a proposal with no author", { type: "unknown" }, self, policy, "proposal.owner-only"],
  ] as [string, Proposer, Decider, typeof policy, string | null][])("%s", (_, proposedBy, by, rules, reason) => {
    expect(mayDecide({ id: "1", proposedBy }, by, rules)?.reason ?? null).toBe(reason)
  })
})

const opened = async (): Promise<MessageStore> => {
  const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "decisions-")), "store.db") })
  handles.push(store)
  return store
}
const own = { details: { reason: "proposal.own" } }
const agent = { bot: "claude-code", model: "synthetic" }

/** SEC-118: every decide path in core refuses an agent deciding its own proposal, and lets the owner decide it. */
describe("an agent cannot decide its own proposal", () => {
  it("on a fact, accepted or rejected", async () => {
    const store = await opened()
    const note = await store.notes.addNote({ text: "Kickoff moved" })
    const fact = await store.facts.add({ type: "fact", statement: "Kickoff moved", by: agent, evidence: [note.ref] })
    await expect(store.facts.accept(fact.ref, self)).rejects.toMatchObject(own)
    await expect(store.facts.reject(fact.ref, self)).rejects.toMatchObject(own)
    expect((await store.facts.get(fact.ref)).status).toBe("proposed")
    expect(await store.facts.accept(fact.ref, { bot: "codex", reason: "the note says so" })).toMatchObject({
      status: "accepted",
      confirmedBy: { type: "bot" },
    })
  })

  it("on a memory", async () => {
    const store = await opened()
    const note = await store.notes.addNote({ text: "Prefers mornings" })
    const memory = await store.memories.add({
      kind: "preference",
      body: "Prefers mornings",
      scope: "work",
      evidence: [note.ref],
      author: agent,
    })
    await expect(store.memories.confirm(memory.ref, self)).rejects.toMatchObject(own)
    expect((await store.memories.get(memory.ref)).status).toBe("proposed")
    expect(await store.memories.confirm(memory.ref, "owner")).toMatchObject({ status: "confirmed" })
  })

  it("on a relationship, confirmed or removed while unconfirmed", async () => {
    const store = await opened()
    const project = await store.knowledge.addProject({ name: "Harbour" })
    const studio = await store.knowledge.addOrganization({ kind: "company", name: "Synthetic Studio" })
    const clinic = await store.knowledge.addOrganization({ kind: "company", name: "Synthetic Clinic" })
    const link = await store.knowledge.relate(null, {
      from: studio.ref,
      to: project.ref,
      kind: "member-of",
      confirmed: false,
      provenance: "agent:claude-code",
    })
    await expect(store.knowledge.confirmRelation(null, link.id, self)).rejects.toMatchObject(own)
    await expect(store.knowledge.removeRelation(null, link.id, self)).rejects.toMatchObject(own)
    const rule = await store.knowledge.relate(null, {
      from: clinic.ref,
      to: project.ref,
      kind: "member-of",
      confirmed: false,
      provenance: "rule:email-domain-v1;confidence:weak",
    })
    await expect(store.knowledge.confirmRelation(null, rule.id, self)).rejects.toMatchObject({
      details: { reason: "proposal.owner-only" },
    })
    expect(await store.knowledge.confirmRelation(null, link.id, "owner")).toMatchObject({ confirmed: true })
  })

  it("on an action, approved, rejected or made a task", async () => {
    const store = await opened()
    await store.accounts.saveAccount({ provider: "example", account: "a1" }, { name: "Example" })
    const action = await store.proposedActions.propose({
      kind: "reply",
      by: agent,
      account: { provider: "example", account: "a1" },
    })
    await expect(store.proposedActions.approve(action.id, self)).rejects.toMatchObject(own)
    await expect(store.proposedActions.reject(action.id, self)).rejects.toMatchObject(own)
    await expect(approveAsTask(store, action.id, self)).rejects.toMatchObject(own)
    expect((await store.tasks.list({})).length).toBe(0)
    expect(await store.proposedActions.reject(action.id, "owner")).toMatchObject({ status: "rejected" })
  })

  it("on an evidence findings batch", async () => {
    const f = await contextEvidenceFixture()
    handles.push(f)
    const record = await f.store.contextRecords?.read(f.doc.ref)
    if (!record) throw new Error("Missing record")
    const project = (await f.store.knowledge.projects())[0]
    if (!project) throw new Error("Missing project")
    const batch = await f.store.evidenceFindings.stage(
      {
        schemaVersion: 1,
        key: "own",
        extractor: "synthetic",
        findings: [
          {
            id: "launch",
            kind: "fact",
            type: "decision",
            statement: "The launch is planned",
            project: project.ref,
            evidence: [{ reference: f.doc.ref, fingerprint: contextEvidenceFingerprint(record) }],
          },
        ],
      },
      agent,
    )
    const decision = { fingerprint: batch.fingerprint, accept: ["launch"] }
    await expect(f.store.evidenceFindings.review(batch.id, { ...decision, by: self })).rejects.toMatchObject(own)
    expect(await f.store.evidenceFindings.review(batch.id, { ...decision, by: "owner" })).toMatchObject({
      status: "reviewed",
    })
  })

  it("on a meeting findings batch", async () => {
    const store = await opened()
    const account = { provider: "example", account: "synthetic-findings" }
    const accountId = await store.accounts.saveAccount(account, { name: "Synthetic" })
    const seed = sampleMeeting()
    seed.meeting.accountId = accountId
    const details = await store.meetings.saveMeeting(seed)
    const project = await store.knowledge.addProject({ name: "Harbour Observatory", key: "HOB" })
    await store.knowledge.linkMeetingProject(account, String(details.meeting.id), project.id, { by: "owner" })
    const transcript = details.transcripts[0]
    if (!transcript?.rows[0]) throw new Error("Missing synthetic cue")
    const cue = cueEvidence(accountId, details.meeting.id, transcript.transcript, transcript.rows[0])
    const input: MeetingFindingsInput = {
      schemaVersion: 1,
      key: "own",
      extractor: "synthetic",
      findings: [
        {
          id: "decision",
          kind: "fact",
          type: "decision",
          statement: "Launch in November",
          project: project.ref,
          evidence: [{ reference: cue.reference, fingerprint: cue.fingerprint }],
        },
      ],
    }
    const batch = await store.meetingFindings.stage(account, input, agent)
    const decision = { fingerprint: batch.fingerprint, accept: ["decision"] }
    await expect(store.meetingFindings.review(account, batch.id, { ...decision, by: self })).rejects.toMatchObject(own)
    expect(await store.meetingFindings.review(account, batch.id, { ...decision, by: "owner" })).toMatchObject({
      status: "reviewed",
    })
  })
})
