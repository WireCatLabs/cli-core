import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import { byEngagement, inverseOf, standingOf } from "../domain/relations.js"
import { openCache } from "./open.js"
import { type MessageStore, openStore } from "./store.js"

const stores: MessageStore[] = []
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close()
})

const fixture = async () => {
  const path = join(mkdtempSync(join(tmpdir(), "relations-")), "store.db")
  const store = await openStore({ path })
  stores.push(store)
  const acme = await store.knowledge.addOrganization({ kind: "company", name: "Acme Ltd" })
  const northstar = await store.knowledge.addOrganization({ kind: "company", name: "Northstar Consulting" })
  const alice = `person:${(await store.people.add({ name: "Alice" })).uid}`
  const bob = `person:${(await store.people.add({ name: "Bob" })).uid}`
  return { path, store, acme: acme.ref, northstar: northstar.ref, alice, bob }
}

const role = { code: "validation_error", details: { reason: "relationship.role-unknown" } }

it("refuses a role off the list a relationship's ends name, and says which roles it takes", async () => {
  const { store, acme, alice } = await fixture()
  await expect(
    store.knowledge.relate(null, { by: "owner", from: alice, to: acme, kind: "member-of", role: "author" }),
  ).rejects.toMatchObject({ ...role, message: expect.stringContaining("employee, contractor, founder") })
  const member = await store.knowledge.relate(null, {
    by: "owner",
    from: alice,
    to: acme,
    kind: "member-of",
    role: "contact",
  })
  expect(member).toMatchObject({ role: "contact", standing: "confirmed" })
  await expect(store.knowledge.updateRelation(null, member.id, { role: "author", by: "owner" })).rejects.toMatchObject(
    role,
  )
  expect(
    await store.knowledge.relate(null, { by: "owner", from: acme, to: alice, kind: "related-to", role: "any" }),
  ).toMatchObject({ role: "any" })
})

it("joins only the ends a kind names: a person reports to a person, an organization buys from an organization", async () => {
  const { store, acme, northstar, alice, bob } = await fixture()
  expect(await store.knowledge.relate(null, { by: "owner", from: alice, to: bob, kind: "reports-to" })).toMatchObject({
    from: alice,
    to: bob,
    kind: "reports-to",
  })
  expect(inverseOf("reports-to")).toBe("manages")
  expect(inverseOf("customer-of")).toBe("supplier of")
  for (const input of [
    { from: acme, to: bob, kind: "reports-to" },
    { from: acme, to: alice, kind: "customer-of" },
    { from: alice, to: acme, kind: "partner-of" },
    { from: alice, to: bob, kind: "member-of" },
  ] as const)
    await expect(store.knowledge.relate(null, { ...input, by: "owner" })).rejects.toMatchObject({
      code: "validation_error",
    })
  expect(
    await store.knowledge.relate(null, { by: "owner", from: acme, to: northstar, kind: "customer-of" }),
  ).toMatchObject({ from: acme, to: northstar })
})

it("stores a partnership once, the lower id first, whichever way it is named", async () => {
  const { store, acme, northstar } = await fixture()
  const partners = await store.knowledge.relate(null, { by: "owner", from: northstar, to: acme, kind: "partner-of" })
  expect(partners).toMatchObject({ from: acme, to: northstar })
  expect(await store.knowledge.relate(null, { by: "owner", from: acme, to: northstar, kind: "partner-of" })).toEqual(
    partners,
  )
  expect(await store.knowledge.relationState(null, { from: northstar, to: acme, kind: "partner-of" })).toMatchObject({
    linked: true,
  })
  expect(await store.knowledge.updateRelation(null, partners.id, { role: "reseller", by: "owner" })).toMatchObject({
    from: acme,
    to: northstar,
    role: "reseller",
  })
})

it("confirms a suggested partnership in its stored order", async () => {
  const { store, acme, northstar } = await fixture()
  const suggested = await store.knowledge.relate(null, {
    by: "owner",
    from: northstar,
    to: acme,
    kind: "partner-of",
    confirmed: false,
  })
  expect(suggested).toMatchObject({ from: acme, to: northstar, standing: "proposed" })
  expect(await store.knowledge.confirmRelation(null, suggested.id, "owner")).toMatchObject({
    from: acme,
    standing: "confirmed",
  })
})

it("puts people on a deal by the deal's roles, an influencer among them", async () => {
  const { store, acme, alice, bob } = await fixture()
  await store.deals.addPipeline({ name: "Sales", stages: ["Call"], by: "owner" })
  const deal = await store.deals.add({ by: "owner", title: "Acme renewal", stage: "Call", organization: acme })
  expect(
    await store.knowledge.relate(null, {
      by: "owner",
      from: deal.ref,
      to: alice,
      kind: "related-to",
      role: "influencer",
    }),
  ).toMatchObject({ from: deal.ref, role: "influencer" })
  await expect(
    store.knowledge.relate(null, { by: "owner", from: deal.ref, to: bob, kind: "related-to", role: "approver" }),
  ).rejects.toMatchObject(role)
  expect((await store.deals.get(deal.ref)).people).toEqual([
    expect.objectContaining({ ref: alice, role: "influencer" }),
  ])
})

it("derives a relationship's standing from the link, never from a stored word", () => {
  const now = 1_000
  expect(standingOf({ confirmed: true }, now)).toBe("confirmed")
  expect(standingOf({ confirmed: false }, now)).toBe("proposed")
  expect(standingOf({ confirmed: false, accountId: 3 }, now)).toBe("reported")
  expect(standingOf({ confirmed: true, endsAt: now }, now)).toBe("ended")
  expect(standingOf({ confirmed: false, accountId: 3, deletedAt: 5 }, now)).toBe("ended")
  expect(standingOf({ confirmed: true, accountId: 3, deletedAt: 5 }, now)).toBe("confirmed")
})

it("keeps a job title and the dates beside a relationship, and ends it without removing it", async () => {
  const { store, acme, alice } = await fixture()
  const start = Date.UTC(2025, 0, 1)
  const member = await store.knowledge.relate(null, {
    by: "owner",
    from: alice,
    to: acme,
    kind: "member-of",
    role: "employee",
    position: "Procurement manager",
    startsAt: start,
  })
  expect(member).toMatchObject({ position: "Procurement manager", startsAt: "2025-01-01T00:00:00.000Z", endsAt: null })
  await expect(
    store.knowledge.updateRelation(null, member.id, { endsAt: start - 1, by: "owner" }),
  ).rejects.toMatchObject({ code: "validation_error" })
  const proposal = await store.knowledge.endRelation(null, member.id, start + 1000, { bot: "claude" })
  expect(proposal).toMatchObject({ kind: "relationship_update", payload: { changes: { endsAt: start + 1000 } } })
  const ended = await store.knowledge.endRelation(null, member.id, start + 1000, "owner")
  expect(ended).toMatchObject({ id: member.id, standing: "ended", endsAt: "2025-01-01T00:00:01.000Z" })
  expect(await store.knowledge.relations(null, alice)).toEqual([expect.objectContaining({ id: member.id })])
  expect(
    await store.knowledge.updateRelation(null, member.id, { position: null, endsAt: null, by: "owner" }),
  ).toMatchObject({ position: null, endsAt: null, standing: "confirmed" })
})

it("takes the owner's own roles on a list beside the built-in ones, and keeps those in use", async () => {
  const { store, acme, alice } = await fixture()
  expect(await store.knowledge.addRole("organization", "board-member", "Board member")).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: "employee", label: null, builtIn: true }),
      { id: "board-member", label: "Board member", labels: null, builtIn: false },
    ]),
  )
  await expect(store.knowledge.addRole("organization", "employee")).rejects.toMatchObject({
    details: { reason: "relationship.role-exists" },
  })
  await expect(store.knowledge.addRole("organization", "Board Member")).rejects.toMatchObject({
    code: "validation_error",
  })
  const member = await store.knowledge.relate(null, {
    by: "owner",
    from: alice,
    to: acme,
    kind: "member-of",
    role: "board-member",
  })
  expect(member).toMatchObject({ role: "board-member" })
  await expect(
    store.knowledge.relate(null, { by: "owner", from: alice, to: acme, kind: "member-of", role: "trustee" }),
  ).rejects.toMatchObject({ details: { reason: "relationship.role-unknown" } })
  await expect(store.knowledge.removeRole("organization", "employee")).rejects.toMatchObject({
    details: { reason: "relationship.role-built-in" },
  })
  await expect(store.knowledge.removeRole("organization", "board-member")).rejects.toMatchObject({
    details: { reason: "relationship.role-in-use", count: 1 },
  })
  await store.knowledge.removeRelation(null, member.id, "owner")
  expect((await store.knowledge.removeRole("organization", "board-member")).some(({ builtIn }) => !builtIn)).toBe(false)
  expect((await store.knowledge.roles("project")).every(({ builtIn }) => builtIn)).toBe(true)
})

it("checks a proposal's role against the role lists when it is approved, and counts pending ones as uses", async () => {
  const { store, acme, alice } = await fixture()
  await store.knowledge.addRole("organization", "board-member")
  const proposal = await store.knowledge.proposeRelation(
    null,
    { from: alice, to: acme, kind: "member-of", role: "board-member" },
    { bot: "claude" },
  )
  await expect(store.knowledge.removeRole("organization", " board-member ")).rejects.toMatchObject({
    details: { reason: "relationship.role-in-use", count: 1 },
  })
  await store.knowledge.decideLinkProposal(proposal.id, { confirm: false, by: "owner" })
  await store.knowledge.removeRole("organization", " board-member ")
  const again = await store.knowledge.proposeRelation(
    null,
    { from: alice, to: acme, kind: "member-of", role: "employee" },
    { bot: "claude" },
  )
  const stale = await store.knowledge.relate(null, {
    by: "owner",
    from: alice,
    to: acme,
    kind: "member-of",
    role: "adviser",
  })
  const update = await store.knowledge.updateRelation(null, stale.id, { role: "employee", by: { bot: "claude" } })
  expect(update).toMatchObject({ kind: "relationship_update" })
  await store.knowledge.decideLinkProposal(again.id, { confirm: true, by: "owner" })
  await expect(store.knowledge.decideRelationUpdate(update.id, { confirm: true, by: "owner" })).rejects.toMatchObject({
    details: { reason: "relationship.exists" },
  })
})

it("refuses to approve a proposal whose role left the lists since it was made", async () => {
  const { path, store, acme, alice } = await fixture()
  await store.knowledge.addRole("organization", "trustee")
  const proposal = await store.knowledge.proposeRelation(
    null,
    { from: alice, to: acme, kind: "member-of", role: "trustee" },
    { bot: "claude" },
  )
  const database = await openCache(path)
  database.prepare("DELETE FROM store_settings WHERE key = 'relationships.roles.organization'").run()
  database.close()
  await expect(store.knowledge.decideLinkProposal(proposal.id, { confirm: true, by: "owner" })).rejects.toMatchObject({
    details: { reason: "relationship.role-unknown" },
  })
})

it("keeps a person's engagement on a project and a role note beside the role, and refuses engagement elsewhere", async () => {
  const { store, acme, alice } = await fixture()
  const project = (await store.knowledge.addProject({ name: "Harbour" })).ref
  const member = await store.knowledge.relate(null, {
    by: "owner",
    from: alice,
    to: project,
    kind: "member-of",
    role: "approver",
    roleNote: " signs the acts ",
    engagement: "high",
  })
  expect(member).toMatchObject({ role: "approver", roleNote: "signs the acts", engagement: "high" })
  await expect(
    store.knowledge.updateRelation(null, member.id, { engagement: "rarely" as never, by: "owner" }),
  ).rejects.toMatchObject({ details: { reason: "relationship.engagement-unknown" } })
  const proposal = await store.knowledge.updateRelation(null, member.id, { engagement: "low", by: { bot: "claude" } })
  expect(proposal).toMatchObject({ payload: { changes: { engagement: "low" }, before: { engagement: "high" } } })
  await store.knowledge.decideRelationUpdate(proposal.id, { confirm: true, by: "owner" })
  expect(
    await store.knowledge.updateRelation(null, member.id, { roleNote: null, position: "PM", by: "owner" }),
  ).toMatchObject({ engagement: "low", roleNote: null, position: "PM" })
  expect(await store.knowledge.updateRelation(null, member.id, { engagement: null, by: "owner" })).toMatchObject({
    engagement: null,
    position: "PM",
  })
  const employee = await store.knowledge.relate(null, { by: "owner", from: alice, to: acme, kind: "member-of" })
  await expect(
    store.knowledge.updateRelation(null, employee.id, { engagement: "low", by: "owner" }),
  ).rejects.toMatchObject({ details: { reason: "relationship.engagement-ends" } })
  await expect(
    store.knowledge.relate(null, { by: "owner", from: alice, to: acme, kind: "member-of", engagement: "low" }),
  ).rejects.toMatchObject({ details: { reason: "relationship.engagement-ends" } })
})

it("orders links by engagement: high, medium, unknown, low, none, the rest in their order", () => {
  const links = [
    { id: 1, engagement: "none" as const },
    { id: 2, engagement: null },
    { id: 3, engagement: "low" as const },
    { id: 4, engagement: "high" as const },
    { id: 5 },
    { id: 6, engagement: "medium" as const },
  ]
  expect(byEngagement(links).map(({ id }) => id)).toEqual([4, 6, 2, 5, 3, 1])
})

it("offers the related list for a tie between people and organizations, with labels, and keeps any other word", async () => {
  const { store, acme, alice, bob } = await fixture()
  await store.knowledge.addRole("related", "co-founder", "Сооснователь")
  await store.knowledge.relate(null, { by: "owner", from: alice, to: bob, kind: "related-to", role: "co-founder" })
  await store.knowledge.relate(null, { by: "owner", from: alice, to: acme, kind: "related-to", role: "mentor" })
  await store.knowledge.relate(null, { by: "owner", from: bob, to: acme, kind: "related-to", role: "drinking buddy" })
  const { items } = await store.knowledge.listRelations({ kind: "related-to" })
  expect(items.map(({ role, roleList, custom }) => ({ role, roleList, custom }))).toEqual([
    { role: "co-founder", roleList: "related", custom: false },
    { role: "mentor", roleList: "related", custom: false },
    { role: "drinking buddy", roleList: "related", custom: true },
  ])
  const roles = await store.knowledge.roles("related")
  expect(roles.find(({ id }) => id === "colleague")).toMatchObject({
    builtIn: true,
    labels: { en: "Colleague", ru: "Коллега", es: "Colega" },
  })
  expect(roles.at(-1)).toEqual({ id: "co-founder", label: "Сооснователь", labels: null, builtIn: false })
  await expect(store.knowledge.removeRole("related", "co-founder")).rejects.toMatchObject({
    details: { reason: "relationship.role-in-use", count: 1 },
  })
})
