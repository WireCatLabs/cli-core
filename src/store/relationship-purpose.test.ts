import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import { proposalRegistry } from "../services/proposals/registry.js"
import { openStore } from "./store.js"

const handles: { close(): unknown }[] = []
afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.close()
})

const claude = { bot: "claude-code", model: "synthetic" }

const fixture = async () => {
  let clock = 1_000
  const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "purpose-")), "store.db"), now: () => clock++ })
  handles.push(store)
  const project = await store.knowledge.addProject({ name: "Harbour Clinic", key: "HRB" })
  const studio = await store.knowledge.addOrganization({ kind: "company", name: "Synthetic Studio" })
  const relation = await store.knowledge.relate(null, {
    by: "owner",
    from: studio.ref,
    to: project.ref,
    kind: "member-of",
    role: "client",
    purpose: "sales",
  })
  return { store, project, studio, relation, registry: proposalRegistry(store) }
}

it("keeps any purpose the caller names and lets the owner change or clear it with the role", async () => {
  const f = await fixture()
  expect(f.relation).toMatchObject({ role: "client", purpose: "sales" })
  expect(
    await f.store.knowledge.updateRelation(null, f.relation.id, { by: "owner", purpose: "support" }),
  ).toMatchObject({ role: "client", purpose: "support" })
  expect(
    await f.store.knowledge.updateRelation(null, f.relation.id, { by: "owner", role: "contractor", purpose: null }),
  ).toMatchObject({ role: "contractor", purpose: null })
  await expect(f.store.knowledge.updateRelation(null, f.relation.id, { by: "owner" })).rejects.toMatchObject({
    code: "validation_error",
  })
})

it("makes an agent's change a proposal that its own bot cannot decide and the owner applies", async () => {
  const f = await fixture()
  const change = { by: claude, purpose: "work", reason: "the group discusses the site build" }
  const proposal = await f.store.knowledge.updateRelation(null, f.relation.id, change)
  expect(proposal).toMatchObject({ kind: "relationship_update", status: "proposed" })
  expect((await f.store.knowledge.updateRelation(null, f.relation.id, change)).id).toBe(proposal.id)
  expect((await f.store.knowledge.relations(null, f.studio.ref))[0]).toMatchObject({ purpose: "sales" })

  const listed = await f.registry.list({ limit: 10, offset: 0, project: f.project.ref })
  expect(listed.items).toMatchObject([
    { id: proposal.id, kind: "relationship_update", subject: `relationship:${f.relation.id}`, summary: "purpose work" },
  ])
  const own = await f.registry.decide([proposal.id], { confirm: true, by: { ...claude, reason: "agreed" } })
  expect(own.refused).toMatchObject([{ reason: "proposal.own" }])

  const decided = await f.registry.decide([proposal.id], { confirm: true, by: "owner" })
  expect(decided.decided).toEqual([
    { id: proposal.id, kind: "relationship_update", status: "confirmed", made: [`relationship:${f.relation.id}`] },
  ])
  expect((await f.store.knowledge.relations(null, f.studio.ref))[0]).toMatchObject({ role: "client", purpose: "work" })
})

it("carries an agent's proposed purpose into the link the owner confirms", async () => {
  const f = await fixture()
  const vendor = await f.store.knowledge.addOrganization({ kind: "company", name: "Synthetic Vendor" })
  const proposal = await f.store.knowledge.proposeRelation(
    null,
    { from: vendor.ref, to: f.project.ref, kind: "member-of", purpose: "support" },
    claude,
  )
  await f.registry.decide([proposal.id], { confirm: true, by: "owner" })
  expect((await f.store.knowledge.relations(null, vendor.ref))[0]).toMatchObject({
    purpose: "support",
    confirmed: true,
  })
})
