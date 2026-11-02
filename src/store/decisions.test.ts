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
  const store = await openStore({
    path: join(mkdtempSync(join(tmpdir(), "decisions-")), "store.db"),
    decisions: { agentDecisions: true, ruleProposalsOwnerOnly: true },
  })
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

  it("on a relationship, stored as a proposal or left as an old suggested link", async () => {
    const store = await opened()
    const project = await store.knowledge.addProject({ name: "Harbour" })
    const studio = await store.knowledge.addOrganization({ kind: "company", name: "Synthetic Studio" })
    const clinic = await store.knowledge.addOrganization({ kind: "company", name: "Synthetic Clinic" })
    const proposal = await store.knowledge.proposeRelation(
      null,
      { from: studio.ref, to: project.ref, kind: "member-of" },
      agent,
    )
    for (const confirm of [true, false])
      await expect(store.knowledge.decideLinkProposal(proposal.id, { confirm, by: self })).rejects.toMatchObject(own)
    const link = await store.knowledge.relate(null, {
      by: "owner",
      from: clinic.ref,
      to: project.ref,
      kind: "member-of",
      confirmed: false,
      provenance: "agent:claude-code",
    })
    const owner = { details: { reason: "proposal.owner-only" } }
    await expect(store.knowledge.confirmRelation(null, link.id, self)).rejects.toMatchObject(owner)
    await expect(store.knowledge.removeRelation(null, link.id, self)).rejects.toMatchObject(owner)
    await expect(store.knowledge.decideSuggestedLink(link.id, { confirm: true, by: self })).rejects.toMatchObject(owner)
    expect(await store.knowledge.confirmRelation(null, link.id, "owner")).toMatchObject({ confirmed: true })
    expect(await store.knowledge.decideLinkProposal(proposal.id, { confirm: true, by: "owner" })).toMatchObject({
      proposal: { status: "approved" },
      link: { from: studio.ref, confirmed: true },
    })
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

describe("an agent cannot get round the check", () => {
  it("SEC-1: by adding a confirmed memory, or by marking its own memory stale", async () => {
    const store = await opened()
    const note = await store.notes.addNote({ text: "Prefers mornings" })
    const input = {
      kind: "preference" as const,
      body: "Prefers mornings",
      scope: "work" as const,
      evidence: [note.ref],
    }
    await expect(store.memories.add({ ...input, author: agent, status: "confirmed" })).rejects.toMatchObject({
      details: { reason: "proposal.owner-only" },
    })
    const memory = await store.memories.add({ ...input, author: agent })
    await expect(store.memories.markStale(memory.ref, self)).rejects.toMatchObject(own)
    expect((await store.memories.get(memory.ref)).status).toBe("proposed")
  })

  it("SEC-2: by writing a confirmed relationship link itself", async () => {
    const store = await opened()
    const project = await store.knowledge.addProject({ name: "Harbour" })
    const studio = await store.knowledge.addOrganization({ kind: "company", name: "Synthetic Studio" })
    await expect(
      store.notes.addLink({
        from: studio.ref,
        to: project.ref,
        kind: "member-of",
        origin: "suggested",
        confirmed: true,
      }),
    ).rejects.toMatchObject({ details: { reason: "proposal.decider-required" } })
    await expect(
      store.notes.addLink({ from: studio.ref, to: project.ref, kind: "member-of", by: self }),
    ).rejects.toMatchObject({ details: { reason: "proposal.owner-only" } })
    const proposal = await store.knowledge.relate(null, {
      from: studio.ref,
      to: project.ref,
      kind: "member-of",
      by: agent,
    })
    expect(proposal).toMatchObject({ kind: "relationship", status: "proposed" })
    expect(await store.knowledge.relations(null, studio.ref)).toEqual([])
  })

  it("SEC-3: by naming another bot in a link's provenance", async () => {
    const store = await opened()
    const project = await store.knowledge.addProject({ name: "Harbour" })
    const studio = await store.knowledge.addOrganization({ kind: "company", name: "Synthetic Studio" })
    const link = await store.knowledge.relate(null, {
      from: studio.ref,
      to: project.ref,
      kind: "member-of",
      confirmed: false,
      provenance: "agent:someone-else",
      by: "owner",
    })
    await expect(store.knowledge.confirmRelation(null, link.id, self)).rejects.toMatchObject({
      details: { reason: "proposal.owner-only" },
    })
  })

  it("SEC-4: by removing a link the owner confirmed", async () => {
    const store = await opened()
    const project = await store.knowledge.addProject({ name: "Harbour" })
    const studio = await store.knowledge.addOrganization({ kind: "company", name: "Synthetic Studio" })
    const link = await store.knowledge.relate(null, {
      from: studio.ref,
      to: project.ref,
      kind: "member-of",
      by: "owner",
    })
    await expect(store.knowledge.removeRelation(null, link.id, self)).rejects.toMatchObject({
      details: { reason: "proposal.owner-only" },
    })
    expect(await store.knowledge.relations(null, studio.ref)).toHaveLength(1)
  })
})

describe("the second review", () => {
  const ownerOnly = { details: { reason: "proposal.owner-only" } }
  const setup = async () => {
    const store = await opened()
    const project = await store.knowledge.addProject({ name: "Harbour" })
    const studio = await store.knowledge.addOrganization({ kind: "company", name: "Synthetic Studio" })
    const clinic = await store.knowledge.addOrganization({ kind: "company", name: "Synthetic Clinic" })
    const note = await store.notes.addNote({ text: "Kickoff moved" })
    return { store, project, studio, clinic, note }
  }

  it("SEC-5: an agent cannot remove a link the owner confirmed", async () => {
    const f = await setup()
    const link = await f.store.notes.addLink({ from: f.studio.ref, to: f.project.ref, kind: "member-of", by: "owner" })
    await expect(f.store.notes.removeLink(link.id, self)).rejects.toMatchObject(ownerOnly)
    expect(await f.store.notes.links({ from: f.studio.ref })).toHaveLength(1)
  })

  it("SEC-6: an agent cannot write a confirmed link of any kind", async () => {
    const f = await setup()
    await expect(
      f.store.notes.addLink({ from: f.studio.ref, to: f.clinic.ref, kind: "related-to" }),
    ).rejects.toMatchObject({ details: { reason: "proposal.decider-required" } })
    await expect(
      f.store.notes.addLink({ from: f.note.ref, to: f.clinic.ref, kind: "about", by: self }),
    ).rejects.toMatchObject(ownerOnly)
  })

  it("SEC-7: an agent cannot remove or reverse an accepted fact, nor remove another's memory", async () => {
    const f = await setup()
    const fact = await f.store.facts.add({ type: "decision", statement: "Ship", by: "owner", evidence: [f.note.ref] })
    await expect(f.store.facts.reverse(fact.ref, self)).rejects.toMatchObject(ownerOnly)
    await expect(f.store.facts.remove(fact.ref, self)).rejects.toMatchObject(ownerOnly)
    const input = { kind: "summary" as const, body: "Summary", scope: "work" as const, evidence: [f.note.ref] }
    const memory = await f.store.memories.add({ ...input, author: { bot: "codex" } })
    await expect(f.store.memories.remove(memory.ref, self)).rejects.toMatchObject(ownerOnly)
    const mine = await f.store.facts.add({ type: "fact", statement: "Mine", by: agent, evidence: [f.note.ref] })
    expect(await f.store.facts.remove(mine.ref, self)).toMatchObject({ removed: true })
  })

  it("keeps agent decisions off unless the host turns them on, and owner-only rows off either way", async () => {
    const dir = mkdtempSync(join(tmpdir(), "decisions-"))
    const off = await openStore({ path: join(dir, "store.db") })
    handles.push(off)
    const note = await off.notes.addNote({ text: "Kickoff moved" })
    const fact = await off.facts.add({ type: "fact", statement: "Kickoff", by: agent, evidence: [note.ref] })
    await expect(off.facts.accept(fact.ref, { bot: "codex", reason: "the note" })).rejects.toMatchObject({
      details: { reason: "proposals.agent-decisions-off" },
    })
    await off.close()
    handles.pop()

    const on = await openStore({
      path: join(dir, "store.db"),
      decisions: { agentDecisions: true, ruleProposalsOwnerOnly: true },
    })
    handles.push(on)
    expect(await on.facts.accept(fact.ref, { bot: "codex", reason: "the note" })).toMatchObject({ status: "accepted" })

    const ownerOnly = { id: "mail:1", proposedBy: bot("codex"), ownerOnly: true }
    for (const agentDecisions of [false, true])
      expect(mayDecide(ownerOnly, self, { agentDecisions, ruleProposalsOwnerOnly: true })?.reason).toBe(
        "proposal.owner-only",
      )
  })

  it("SEC-9: the store keeps agent decisions off when the host turns them off", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "decisions-")), "store.db")
    const store = await openStore({ path, decisions: { agentDecisions: false, ruleProposalsOwnerOnly: true } })
    handles.push(store)
    const note = await store.notes.addNote({ text: "Kickoff moved" })
    const fact = await store.facts.add({ type: "fact", statement: "Kickoff", by: agent, evidence: [note.ref] })
    await expect(store.facts.accept(fact.ref, { bot: "codex", reason: "the note" })).rejects.toMatchObject({
      details: { reason: "proposals.agent-decisions-off" },
    })
  })

  it("SEC-10: a bot is the same bot whatever its letter case", async () => {
    const f = await setup()
    const fact = await f.store.facts.add({ type: "fact", statement: "Kickoff", by: agent, evidence: [f.note.ref] })
    await expect(f.store.facts.accept(fact.ref, { bot: "Claude-Code", reason: "the note" })).rejects.toMatchObject(own)
  })
})
