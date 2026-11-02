import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { DEFAULT_DECISION_POLICY } from "../../store/decisions.js"
import { type MessageStore, openStore } from "../../store/store.js"
import { parseProposalIds } from "./ids.js"
import { emptyProposalRegistry, proposalRegistry } from "./registry.js"
import type { ProposalKind, ProposalRow } from "./types.js"

const handles: MessageStore[] = []
afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.close()
})

const claude = { bot: "claude-code", model: "synthetic" }
const codex = { bot: "codex", reason: "the evidence names the project" }

const fixture = async () => {
  let clock = 1_000
  const store = await openStore({
    path: join(mkdtempSync(join(tmpdir(), "proposals-")), "store.db"),
    now: () => clock++,
  })
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
    from: clinic.ref,
    to: project.ref,
    kind: "member-of",
    confirmed: false,
    provenance: "agent:codex",
  })
  return {
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
    registry: proposalRegistry(store, DEFAULT_DECISION_POLICY),
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
    expect((await f.registry.list({ limit: 50, offset: 0, by: { bot: "codex" } })).items.map((row) => row.id)).toEqual([
      `link:${f.legacy.id}`,
    ])
  })

  it("decides each id on its own: an agent's own proposal is refused, the rest are decided", async () => {
    const f = await fixture()
    const ids = [f.fact.ref, f.memory.ref, f.relation.id, `link:${f.legacy.id}`, "fact:999"]
    const { decided, refused } = await f.registry.decide(ids, {
      confirm: true,
      by: { bot: "claude-code", reason: "the note says so" },
    })
    expect(decided.map((one) => one.id)).toEqual([`link:${f.legacy.id}`])
    expect(refused.map((one) => [one.id, one.reason])).toEqual([
      [f.fact.ref, "proposal.own"],
      [f.memory.ref, "proposal.own"],
      [f.relation.id, "proposal.own"],
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
    const f = await fixture()
    const registry = proposalRegistry(f.store, { ...DEFAULT_DECISION_POLICY, agentDecisions: false })
    const { refused } = await registry.decide([`link:${f.legacy.id}`], { confirm: true, by: codex })
    expect(refused).toMatchObject([{ code: "permission_error", reason: "proposals.agent-decisions-off" }])
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
    const registry = emptyProposalRegistry(f.store, DEFAULT_DECISION_POLICY)
    registry.register(kind)
    expect((await registry.list({ limit: 5, offset: 0 })).items).toEqual([merge])
    expect(
      (await registry.decide(["person_merge:1"], { confirm: true, by: { ...claude, reason: "x" } })).refused,
    ).toMatchObject([{ reason: "proposal.own" }])
    expect(() => registry.register(kind)).toThrow("twice")
  })
})
