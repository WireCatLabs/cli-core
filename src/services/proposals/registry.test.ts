import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { DEFAULT_DECISION_POLICY } from "../../store/decisions.js"
import { openCache } from "../../store/open.js"
import { openStore } from "../../store/store.js"
import { parseProposalIds } from "./ids.js"
import { proposeOrganization, proposeOrganizationRename } from "./kinds/organization.js"
import { emptyProposalRegistry, proposalRegistry } from "./registry.js"
import type { ProposalKind, ProposalRow } from "./types.js"

const handles: { close(): unknown }[] = []
afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.close()
})

const claude = { bot: "claude-code", model: "synthetic" }
const codex = { bot: "codex", reason: "the evidence names the project" }

const AGENTS_ON = { ...DEFAULT_DECISION_POLICY, agentDecisions: true }

const fixture = async (decisions = AGENTS_ON) => {
  let clock = 1_000
  const path = join(mkdtempSync(join(tmpdir(), "proposals-")), "store.db")
  const store = await openStore({ path, now: () => clock++, decisions })
  handles.push(store)
  const project = await store.knowledge.addProject({ name: "Harbour Clinic", key: "HRB" })
  const studio = await store.knowledge.addOrganization({ kind: "company", name: "Synthetic Studio" })
  const clinic = await store.knowledge.addOrganization({ kind: "company", name: "Synthetic Clinic" })
  const vendor = await store.knowledge.addOrganization({ kind: "company", name: "Synthetic Vendor" })
  const note = await store.notes.addNote({ text: "Kickoff moved to Tuesday" })
  const fact = await store.facts.add({
    type: "fact",
    statement: "Kickoff moved",
    by: claude,
    project: project.ref,
    evidence: [note.ref],
  })
  const memory = await store.memories.add({
    kind: "preference",
    body: "Prefers mornings",
    scope: "work",
    project: project.ref,
    evidence: [note.ref],
    author: claude,
  })
  const relation = await store.knowledge.proposeRelation(
    null,
    { from: studio.ref, to: project.ref, kind: "member-of", role: "client", evidence: [note.ref] },
    claude,
  )
  const legacy = await store.knowledge.relate(null, {
    by: "owner",
    from: clinic.ref,
    to: project.ref,
    kind: "member-of",
    confirmed: false,
    provenance: "agent:codex",
  })
  return {
    path,
    store,
    project,
    studio,
    clinic,
    vendor,
    note,
    fact,
    memory,
    relation,
    legacy,
    registry: proposalRegistry(store),
  }
}

describe("parseProposalIds", () => {
  it("reads ranges, lists, prefixes and the findings of a batch", () => {
    expect(parseProposalIds(["17070-17072,fact:500-501", "17080/f2", "17070"])).toEqual([
      "17070",
      "17071",
      "17072",
      "fact:500",
      "fact:501",
      "17080/f2",
    ])
    expect(parseProposalIds(["memory:9-memory:10"])).toEqual(["memory:9", "memory:10"])
    expect(parseProposalIds(["close:Q-15,close:HRB2-3"])).toEqual(["close:Q-15", "close:HRB2-3"])
  })

  it.each([
    ["fact:500-memory:502", "one prefix"],
    ["17070-fact:17072", "one prefix"],
    ["9-3", "upwards"],
    ["1-1000", "at most"],
    ["chat:telegram/1", "not a proposal id"],
    ["", "not a proposal id"],
  ])("refuses %s", (text, message) => {
    expect(() => parseProposalIds([text])).toThrow(message)
  })
})

describe("the proposal registry", () => {
  it("lists every kind newest first, with stable pages and filters", async () => {
    const f = await fixture()
    const all = await f.registry.list({ limit: 50, offset: 0 })
    expect(all.items.map((row) => [row.kind, row.id])).toEqual([
      ["relationship", `link:${f.legacy.id}`],
      ["relationship", f.relation.id],
      ["memory", f.memory.ref],
      ["fact", f.fact.ref],
    ])
    expect(all.items[1]).toMatchObject({
      subject: f.studio.ref,
      object: f.project.ref,
      project: f.project.ref,
      proposedBy: { type: "bot", name: "claude-code", kind: "agent" },
      evidence: [f.note.ref],
    })
    const first = await f.registry.list({ limit: 2, offset: 0 })
    const second = await f.registry.list({ limit: 2, offset: 2 })
    expect(first.hasMore).toBe(true)
    expect(second.hasMore).toBe(false)
    expect([...first.items, ...second.items]).toEqual(all.items)
    expect((await f.registry.list({ limit: 50, offset: 0, kinds: ["fact"] })).items).toHaveLength(1)
    expect((await f.registry.list({ limit: 50, offset: 0, by: { bot: "claude-code" } })).items).toHaveLength(3)
    expect(all.items[0]?.proposedBy).toEqual({ type: "unknown" })
  })

  it("decides each id on its own: an agent's own proposal is refused, the rest are decided", async () => {
    const f = await fixture()
    const other = await f.store.facts.add({
      type: "fact",
      statement: "Kickoff is at ten",
      by: { bot: "codex" },
      evidence: [f.note.ref],
    })
    const ids = [f.fact.ref, f.memory.ref, f.relation.id, `link:${f.legacy.id}`, other.ref, "fact:999"]
    const { decided, refused } = await f.registry.decide(ids, {
      confirm: true,
      by: { bot: "claude-code", reason: "the note says so" },
    })
    expect(decided.map((one) => one.id)).toEqual([other.ref])
    expect(refused.map((one) => [one.id, one.reason])).toEqual([
      [f.fact.ref, "proposal.own"],
      [f.memory.ref, "proposal.own"],
      [f.relation.id, "proposal.own"],
      [`link:${f.legacy.id}`, "proposal.owner-only"],
      ["fact:999", "not_found"],
    ])
    const owner = await f.registry.decide([f.fact.ref, f.relation.id], { confirm: true, by: "owner" })
    expect(owner.refused).toEqual([])
    expect(owner.decided[1]).toMatchObject({
      kind: "relationship",
      status: "confirmed",
      made: [expect.stringMatching(/^relationship:/)],
    })
    expect(await f.store.knowledge.relations(null, f.studio.ref)).toEqual([
      expect.objectContaining({ to: f.project.ref, confirmed: true, role: "client" }),
    ])
    const again = await f.registry.decide([f.fact.ref], { confirm: false, by: "owner" })
    expect(again.refused).toMatchObject([{ reason: "proposal.wrong-state" }])
  })

  it("keeps the agent's decisions with the owner when the host turns them off", async () => {
    const f = await fixture(DEFAULT_DECISION_POLICY)
    const { refused } = await f.registry.decide([`link:${f.legacy.id}`, f.relation.id], { confirm: true, by: codex })
    expect(refused).toMatchObject([
      { code: "permission_error", reason: "proposals.agent-decisions-off" },
      { code: "permission_error", reason: "proposals.agent-decisions-off" },
    ])
    await expect(f.store.proposedActions.reject(f.relation.id, codex)).rejects.toMatchObject({
      details: { reason: "proposals.agent-decisions-off" },
    })
  })

  it("leaves a rejected relationship behind a rejected or removed project link, and dedupes a pending pair", async () => {
    const f = await fixture()
    const same = await f.store.knowledge.proposeRelation(
      null,
      { from: f.studio.ref, to: f.project.ref, kind: "member-of" },
      { bot: "codex" },
    )
    expect(same.id).toBe(f.relation.id)
    await f.registry.decide([f.relation.id, `link:${f.legacy.id}`], { confirm: false, by: "owner" })
    const confirmed = await f.store.knowledge.relate(null, {
      by: "owner",
      from: f.vendor.ref,
      to: f.project.ref,
      kind: "member-of",
    })
    await f.store.knowledge.removeRelation(null, confirmed.id, "owner")
    const rejected = await f.registry.list({ limit: 50, offset: 0, status: "rejected", kinds: ["relationship"] })
    expect(rejected.items.map((row) => row.subject).sort()).toEqual([f.clinic.ref, f.vendor.ref, f.studio.ref].sort())
  })

  it("routes a kind a host registers by its prefix, with no change to the registry", async () => {
    const f = await fixture()
    const merge: ProposalRow = {
      id: "person_merge:1",
      kind: "person_merge",
      status: "proposed",
      project: null,
      subject: "person:1",
      object: "person:2",
      summary: null,
      proposedBy: { type: "bot", id: "9", name: "claude-code", kind: "agent" },
      reason: null,
      evidence: [],
      score: null,
      signals: null,
      parts: null,
      createdAt: new Date(9_999_999).toISOString(),
    }
    const kind: ProposalKind = {
      kind: "person_merge",
      prefix: "person_merge",
      list: async () => [merge],
      get: async () => merge,
      decide: async (id) => ({ id, kind: "person_merge", status: "confirmed", made: [] }),
    }
    const registry = emptyProposalRegistry(f.store)
    registry.register(kind)
    expect((await registry.list({ limit: 5, offset: 0 })).items).toEqual([merge])
    expect(
      (await registry.decide(["person_merge:1"], { confirm: true, by: { ...claude, reason: "x" } })).refused,
    ).toMatchObject([{ reason: "proposal.own" }])
    expect(() => registry.register(kind)).toThrow("twice")
  })
})

describe("the review fixes", () => {
  it("BUG-1: reads a rule from the bot's kind, not only from the name rule", async () => {
    const f = await fixture()
    const scan = await f.store.knowledge.proposeRelation(
      null,
      { from: f.vendor.ref, to: f.project.ref, kind: "member-of" },
      { bot: "memo-scan", kind: "rule" },
    )
    expect((await f.registry.get(scan.id)).proposedBy).toMatchObject({ name: "memo-scan", kind: "rule" })
    expect((await f.registry.list({ limit: 50, offset: 0, by: "rule" })).items.map((row) => row.id)).toEqual([scan.id])
    const { refused } = await f.registry.decide([scan.id], { confirm: true, by: codex })
    expect(refused).toMatchObject([{ reason: "proposal.owner-only" }])
  })

  it("BUG-2: fills a page of one project when newer proposals of another come first", async () => {
    const f = await fixture()
    const other = await f.store.knowledge.addProject({ name: "Other Example", key: "OTH" })
    for (let n = 0; n < 30; n++)
      await f.store.facts.add({
        type: "fact",
        statement: `Other ${n}`,
        by: { bot: "codex" },
        project: other.ref,
        evidence: [f.note.ref],
      })
    const page = await f.registry.list({ limit: 5, offset: 0, project: f.project.ref, kinds: ["fact"] })
    expect(page).toMatchObject({ items: [{ id: f.fact.ref }], hasMore: false })
    const mine = await f.registry.list({ limit: 2, offset: 0, by: { bot: "claude-code" } })
    expect(mine.items).toHaveLength(2)
    expect(mine.hasMore).toBe(true)
  })

  it("BUG-3: refuses a part on a kind without parts, and a whole id with its part", async () => {
    const f = await fixture()
    const { refused } = await f.registry.decide([`${f.relation.id}/f9`], { confirm: true, by: "owner" })
    expect(refused).toMatchObject([{ reason: "proposal.ids" }])
    const both = await f.registry.decide([f.relation.id, `${f.relation.id}/f1`], { confirm: true, by: "owner" })
    expect(both).toMatchObject({ decided: [], refused: [{ reason: "proposal.ids" }] })
    expect((await f.registry.get(f.relation.id)).status).toBe("proposed")
  })

  it("RISK-1: writes no link when recording the decision fails", async () => {
    const f = await fixture()
    const db = await openCache(f.path)
    handles.push(db)
    db.exec("CREATE TRIGGER no_decisions BEFORE UPDATE ON proposed_actions BEGIN SELECT RAISE(ABORT, 'synthetic'); END")
    await expect(f.registry.decide([f.relation.id], { confirm: true, by: "owner" })).rejects.toThrow("synthetic")
    expect(await f.store.knowledge.relations(null, f.studio.ref)).toEqual([])
  })

  it("DEBT-1: records the agent that reviewed and the reason it gave", async () => {
    const f = await fixture()
    const other = await f.store.facts.add({
      type: "fact",
      statement: "Kickoff at ten",
      by: { bot: "codex" },
      evidence: [f.note.ref],
    })
    await f.registry.decide([other.ref], {
      confirm: true,
      by: { bot: "claude-code", reason: "the note says ten" },
      reason: "checked twice",
    })
    expect(await f.store.facts.get(other.ref)).toMatchObject({ status: "accepted", confirmedBy: { type: "bot" } })
    const db = await openCache(f.path)
    handles.push(db)
    const metadata = db.prepare("SELECT metadata FROM facts WHERE id = ?").get(Number(other.id))?.metadata
    expect(JSON.parse(String(metadata))).toMatchObject({
      decision: { by: "agent", bot: "claude-code", reason: "the note says ten: checked twice" },
    })
    await f.registry.decide([f.relation.id], { confirm: false, by: "owner", reason: "not a client" })
    expect((await f.store.proposedActions.get(f.relation.id)).result).toEqual({ reason: "not a client" })
  })
})

describe("an agent's new organization", () => {
  it("waits as a proposal and exists once confirmed", async () => {
    const f = await fixture()
    const proposal = await proposeOrganization(f.store, { name: "Synthetic Dairy", kind: "company" }, claude)
    expect((await f.store.knowledge.organizations()).map((org) => org.name)).not.toContain("Synthetic Dairy")
    const row = await f.registry.get(proposal.id)
    expect(row).toMatchObject({ kind: "organization", status: "proposed", summary: "add company Synthetic Dairy" })

    const { decided } = await f.registry.decide([proposal.id], { confirm: true, by: "owner" })
    expect(decided).toMatchObject([
      { kind: "organization", status: "confirmed", made: [expect.stringMatching(/^organization:/)] },
    ])
    expect((await f.store.knowledge.organizations()).map((org) => org.name)).toContain("Synthetic Dairy")
  })

  it("makes nothing when rejected", async () => {
    const f = await fixture()
    const proposal = await proposeOrganization(f.store, { name: "Synthetic Dairy", kind: "company" }, claude)
    await f.registry.decide([proposal.id], { confirm: false, by: "owner" })
    expect((await f.store.knowledge.organizations()).map((org) => org.name)).not.toContain("Synthetic Dairy")
  })
})

describe("an agent's organization rename", () => {
  it("keeps the name until confirmed, then renames", async () => {
    const f = await fixture()
    const org = await f.store.knowledge.addOrganization({ kind: "company", name: "Synthetic Dairy" })
    const proposal = await proposeOrganizationRename(f.store, { organization: org.ref, name: "Synthetic Farm" }, claude)
    expect((await f.store.knowledge.organizations()).map((one) => one.name)).toContain("Synthetic Dairy")
    expect(await f.registry.get(proposal.id)).toMatchObject({
      kind: "organization",
      status: "proposed",
      subject: org.ref,
      summary: `rename ${org.ref} to Synthetic Farm`,
    })

    await f.registry.decide([proposal.id], { confirm: true, by: "owner" })
    expect((await f.store.knowledge.organizations()).map((one) => one.name)).toContain("Synthetic Farm")
  })

  it("changes nothing when rejected", async () => {
    const f = await fixture()
    const org = await f.store.knowledge.addOrganization({ kind: "company", name: "Synthetic Dairy" })
    const proposal = await proposeOrganizationRename(f.store, { organization: org.ref, name: "Synthetic Farm" }, claude)
    await f.registry.decide([proposal.id], { confirm: false, by: "owner" })
    expect((await f.store.knowledge.organizations()).map((one) => one.name)).toContain("Synthetic Dairy")
  })
})
