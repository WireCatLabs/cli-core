import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import { inverseOf, standingOf } from "../domain/relations.js"
import { type MessageStore, openStore } from "./store.js"

const stores: MessageStore[] = []
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close()
})

const fixture = async () => {
  const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "relations-")), "store.db") })
  stores.push(store)
  const acme = await store.knowledge.addOrganization({ kind: "company", name: "Acme Ltd" })
  const northstar = await store.knowledge.addOrganization({ kind: "company", name: "Northstar Consulting" })
  const alice = `person:${(await store.people.add({ name: "Alice" })).uid}`
  const bob = `person:${(await store.people.add({ name: "Bob" })).uid}`
  return { store, acme: acme.ref, northstar: northstar.ref, alice, bob }
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
})
