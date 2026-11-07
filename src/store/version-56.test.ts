import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { RELATION_KINDS } from "../domain/relations.js"
import { rollBackTo } from "../testing/older-store.js"
import { MIGRATIONS } from "./migrations.js"
import { openCache } from "./open.js"
import { openStore } from "./store.js"

const PORTAL = { provider: "example-crm", account: "acme.example" }

const seeded = async () => {
  const path = join(mkdtempSync(join(tmpdir(), "version-56-")), "wirecat.db")
  const store = await openStore({ path })
  await store.crm.savePipelines(PORTAL, "deal", [
    { externalId: "p1", name: "Sales", stages: [{ externalId: "s1", name: "New", position: 1, outcome: "open" }] },
  ])
  await store.crm.savePeople(PORTAL, [{ externalId: "7", name: "Alice", email: "alice@acme.example" }])
  await store.crm.saveItems(PORTAL, "deal", [
    {
      externalId: "d1",
      title: "Acme renewal",
      pipeline: "p1",
      stage: "s1",
      people: [{ externalId: "7", role: "contact" }],
    },
  ])
  const acme = await store.knowledge.addOrganization({ kind: "company", name: "Acme Ltd" })
  const bob = `person:${(await store.people.add({ name: "Bob" })).uid}`
  const deal = (await store.crm.refOf(PORTAL, "deal", "d1")) as string
  await store.close()
  return { path, acme: acme.ref, bob, deal }
}

it("moves a version 55 file's CRM deal people to the CRM's account, folds duplicate relationships and starts their history", async () => {
  const { path, acme, bob, deal } = await seeded()
  const old = await openCache(path)
  rollBackTo(old, 56)
  // What a version 55 build wrote: CRM people as confirmed, and the same relationship twice.
  old.exec("UPDATE links SET confirmed = 1 WHERE source = 'crm'")
  const bobId = Number(bob.slice("person:".length))
  const acmeId = Number(acme.slice("organization:".length))
  const insert = old.prepare(
    "INSERT INTO links (from_type, from_id, to_type, to_id, kind, role, source, confirmed, created_at, author, updated_at) " +
      "VALUES ('person', ?, 'organization', ?, 'member-of', 'employee', ?, ?, 1, ?, 1)",
  )
  insert.run(bobId, acmeId, "suggested", 0, null)
  insert.run(bobId, acmeId, "owner", 1, "owner")
  insert.run(bobId, acmeId, "owner", 1, "owner")
  for (const _ of [1, 2])
    old
      .prepare(
        "INSERT INTO links (from_type, from_id, to_type, to_id, kind, source, confirmed, created_at, updated_at) " +
          "VALUES ('memory', 1, 'person', ?, 'evidence', 'owner', 1, 1, 1)",
      )
      .run(bobId)
  old.close()

  const upgraded = await openStore({ path })
  try {
    const db = await openCache(path)
    try {
      const members = db
        .prepare(
          "SELECT source, confirmed FROM links WHERE kind = 'member-of' AND from_type = 'person' AND from_id = ?",
        )
        .all(bobId)
      expect(members).toEqual([{ source: "owner", confirmed: 1 }])
      expect(db.prepare("SELECT count(*) AS n FROM links WHERE kind = 'evidence'").get()?.n).toBe(2)
      expect(db.prepare("SELECT count(*) AS n FROM link_revisions").get()?.n).toBe(0)
      const account = db
        .prepare("SELECT id FROM accounts WHERE provider = ? AND external_id = ?")
        .get(PORTAL.provider, PORTAL.account)
      expect(db.prepare("SELECT confirmed, account_id FROM links WHERE source = 'crm'").all()).toEqual([
        { confirmed: 0, account_id: account?.id },
      ])
    } finally {
      db.close()
    }
    const [participant] = await upgraded.knowledge.relations(null, deal)
    expect(participant).toMatchObject({ kind: "related-to", role: "contact", confirmed: false, standing: "reported" })
    expect((await upgraded.deals.get(deal)).people).toEqual([expect.objectContaining({ role: "contact" })])
  } finally {
    await upgraded.close()
  }
})

it("writes a relationship's history in the same statement, and never an evidence link's", async () => {
  const { path, acme, bob } = await seeded()
  const store = await openStore({ path })
  try {
    const member = await store.knowledge.relate(null, {
      by: "owner",
      from: bob,
      to: acme,
      kind: "member-of",
      role: "employee",
    })
    const founder = await store.knowledge.relate(null, {
      by: "owner",
      from: bob,
      to: acme,
      kind: "member-of",
      role: "founder",
    })
    expect(founder.id).not.toBe(member.id)
    expect(await store.knowledge.relate(null, { by: "owner", from: bob, to: acme, kind: "member-of" })).toMatchObject({
      id: member.id,
    })
    await store.knowledge.updateRelation(null, member.id, { role: "manager", by: "owner" })
    await store.knowledge.removeRelation(null, founder.id, "owner")
    const db = await openCache(path)
    try {
      const bobId = Number(bob.slice("person:".length))
      const evidence = db.prepare(
        "INSERT INTO links (from_type, from_id, to_type, to_id, kind, source, confirmed, created_at, updated_at) " +
          "VALUES ('memory', 1, 'person', ?, 'evidence', 'owner', 1, 1, 1) RETURNING id",
      )
      const one = Number(evidence.get(bobId)?.id)
      evidence.get(bobId)
      db.prepare("UPDATE links SET metadata = '{}', role = 'x' WHERE id = ?").run(one)
      db.prepare("DELETE FROM links WHERE id = ?").run(one)
      db.prepare("UPDATE links SET updated_at = updated_at + 1 WHERE id = ?").run(Number(member.id))
      const changes = db
        .prepare("SELECT link_id, change, json_extract(after, '$.role') AS role FROM link_revisions ORDER BY id")
        .all()
        .filter((row) => [member.id, founder.id].includes(String(row.link_id)))
      expect(changes).toEqual([
        { link_id: Number(member.id), change: "added", role: "employee" },
        { link_id: Number(founder.id), change: "added", role: "founder" },
        { link_id: Number(member.id), change: "changed", role: "manager" },
        { link_id: Number(founder.id), change: "removed", role: null },
      ])
    } finally {
      db.close()
    }
  } finally {
    await store.close()
  }
})

it("folds a relationship stored twice, NULL and empty alike, onto the owner's row with both rows' metadata", async () => {
  const { path, acme, bob } = await seeded()
  const store = await openStore({ path })
  const held = await store.knowledge.relate(null, { by: "owner", from: bob, to: acme, kind: "related-to" })
  const proposal = await store.knowledge.updateRelation(null, held.id, { role: "vendor", by: { bot: "claude" } })
  await store.close()
  const old = await openCache(path)
  rollBackTo(old, 56)
  old.prepare("UPDATE links SET source = 'suggested', metadata = '{\"a\":1}' WHERE id = ?").run(Number(held.id))
  const owner = old
    .prepare(
      "INSERT INTO links (from_type, from_id, to_type, to_id, kind, role, anchor, source, metadata, confirmed, " +
        "created_at, author, updated_at) VALUES ('person', ?, 'organization', ?, 'related-to', '', '', 'owner', " +
        "'{\"b\":2}', 1, 2, 'owner', 2) RETURNING id",
    )
    .get(Number(bob.slice("person:".length)), Number(acme.slice("organization:".length)))
  old.close()

  const upgraded = await openStore({ path })
  try {
    const db = await openCache(path)
    try {
      const rows = db
        .prepare("SELECT id, metadata FROM links WHERE kind = 'related-to' AND from_type = 'person' ORDER BY id")
        .all()
      expect(rows).toEqual([{ id: owner?.id, metadata: '{"a":1,"b":2}' }])
    } finally {
      db.close()
    }
    expect((await upgraded.proposedActions.get(proposal.id)).payload).toMatchObject({
      relationship: String(owner?.id),
    })
  } finally {
    await upgraded.close()
  }
})

it("names in triggers, the unique key and the fold exactly the relationship kinds of the registry", () => {
  const sql = MIGRATIONS.find(({ version }) => version === 56)?.statements.join("\n") ?? ""
  const lists = [...sql.matchAll(/kind IN \(([^)]*)\)/g)].map((match) =>
    (match[1] as string)
      .split(",")
      .map((one) => one.trim().replaceAll("'", ""))
      .sort(),
  )
  // The fold four times, the three triggers and the unique key.
  expect(lists.length).toBe(8)
  for (const list of lists) expect(list).toEqual([...RELATION_KINDS].sort())
})

it("records a suggestion the owner rejected as rejected, at the store's time", async () => {
  const { path, acme, bob } = await seeded()
  const store = await openStore({ path, now: () => 5_000 })
  try {
    const suggestion = await store.knowledge.relate(null, {
      by: "owner",
      from: bob,
      to: acme,
      kind: "member-of",
      role: "adviser",
      confirmed: false,
    })
    await store.knowledge.removeRelation(null, suggestion.id, "owner")
    const db = await openCache(path)
    try {
      expect(
        db
          .prepare("SELECT change, created_at FROM link_revisions WHERE link_id = ? ORDER BY id")
          .all(Number(suggestion.id)),
      ).toEqual([
        { change: "added", created_at: 5_000 },
        { change: "rejected", created_at: 5_000 },
      ])
    } finally {
      db.close()
    }
  } finally {
    await store.close()
  }
})
