import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { proposalRegistry } from "../services/proposals/registry.js"
import { rollBackTo } from "../testing/older-store.js"
import { openCache } from "./open.js"
import { openStore } from "./store.js"

it("moves an older build's agent and rule suggestions into proposals and keeps Drive's editor links", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "version-44-")), "wirecat.db")
  let clock = 1_000
  const store = await openStore({ path, now: () => clock++ })
  const project = await store.knowledge.addProject({ name: "Harbour Clinic", key: "HRB" })
  const studio = await store.knowledge.addOrganization({ kind: "company", name: "Synthetic Studio" })
  const vendor = await store.knowledge.addOrganization({ kind: "company", name: "Synthetic Vendor" })
  const dana = await store.people.add({ name: "Dana Example" })
  const lena = await store.people.add({ name: "Lena Example" })
  const plan = await store.notes.addNote({ text: "Synthetic plan" })
  const suggested = { origin: "suggested" as const, confirmed: false }
  const agent = await store.notes.addLink({
    ...suggested,
    from: studio.ref,
    to: project.ref,
    kind: "member-of",
    role: "client",
    evidence: "writes in the client group",
    provenance: "agent:codex",
  })
  const rule = await store.notes.addLink({
    ...suggested,
    from: `person:${dana.uid}`,
    to: `person:${lena.uid}`,
    kind: "related-to",
    provenance: "rule:email-domain-v1;confidence:weak",
  })
  const key = await store.notes.addLink({
    ...suggested,
    from: plan.ref,
    to: project.ref,
    kind: "related-to",
    role: "key",
    evidence: "the plan",
    provenance: "agent:claude-code",
  })
  const drive = await store.notes.addLink({
    ...suggested,
    from: plan.ref,
    to: `person:${dana.uid}`,
    kind: "related-to",
    provenance: "google-drive:files.get",
  })
  const confirmed = await store.notes.addLink({ by: "owner", from: vendor.ref, to: project.ref, kind: "member-of" })
  await store.close()

  const old = await openCache(path)
  rollBackTo(old, 44)
  expect(old.prepare("SELECT name FROM pragma_table_info('links') WHERE name = 'purpose'").get()).toBeUndefined()
  old.close()

  const upgraded = await openStore({
    path,
    now: () => clock++,
    decisions: { agentDecisions: true, ruleProposalsOwnerOnly: true },
  })
  try {
    const left = await upgraded.notes.links({})
    expect(left.map((link) => link.id).sort()).toEqual([drive.id, confirmed.id].sort())
    expect(left.every((link) => link.purpose === null)).toBe(true)

    const moved = await upgraded.proposedActions.list({ kinds: ["relationship", "key_document"] })
    expect(moved).toHaveLength(3)
    const byLink = (id: string) =>
      moved.find((action) => (action.payload as { suggestedLink: { id: string } }).suggestedLink.id === id)
    expect(byLink(agent.id)).toMatchObject({
      kind: "relationship",
      status: "proposed",
      reason: "writes in the client group",
      createdAt: agent.createdAt,
      target: studio.ref,
      proposedBy: { type: "bot", name: "codex", kind: "agent" },
      payload: { from: studio.ref, to: project.ref, kind: "member-of", role: "client" },
    })
    expect(byLink(rule.id)).toMatchObject({
      kind: "relationship",
      createdAt: rule.createdAt,
      proposedBy: { type: "bot", name: "rule", kind: "rule" },
      payload: { suggestedLink: { provenance: "rule:email-domain-v1;confidence:weak" } },
    })
    expect(byLink(key.id)).toMatchObject({
      kind: "key_document",
      reason: "the plan",
      createdAt: key.createdAt,
      proposedBy: { type: "bot", name: "claude-code", kind: "agent" },
      payload: { ref: plan.ref, project: project.ref },
    })

    const registry = proposalRegistry(upgraded)
    const pending = await registry.list({ limit: 10, offset: 0, kinds: ["relationship", "key_document"] })
    expect(pending.items.map((row) => row.id).some((id) => id.includes(":"))).toBe(false)
    const agentRow = byLink(agent.id)?.id as string
    const keyRow = byLink(key.id)?.id as string
    const other = { bot: "claude-code", reason: "the group is the client's" }
    const refused = await registry.decide([agentRow, keyRow], { confirm: true, by: other })
    expect(refused.refused.map((one) => one.reason)).toEqual(["proposal.owner-only", "proposal.owner-only"])
    await expect(
      upgraded.proposedActions.reject(keyRow, { bot: "claude-code", reason: "mine after all" }),
    ).rejects.toMatchObject({ code: "permission_error" })

    const decided = await registry.decide([agentRow], { confirm: true, by: "owner" })
    expect(decided.decided).toMatchObject([{ status: "confirmed" }])
    expect((await upgraded.knowledge.relations(null, studio.ref))[0]).toMatchObject({
      to: project.ref,
      role: "client",
      confirmed: true,
      purpose: null,
    })
  } finally {
    await upgraded.close()
  }

  const again = await openStore({ path })
  try {
    expect(
      await again.proposedActions.list({ kinds: ["relationship", "key_document"], status: "proposed" }),
    ).toHaveLength(2)
  } finally {
    await again.close()
  }
})
