import { createReadStream } from "node:fs"
import { afterEach, describe, expect, it } from "vitest"
import { RECORD_TYPES, type RecordRoleSpec } from "../domain/record-types.js"
import type { EnvelopeRecord } from "../domain/records.js"
import { checkEnds, roleListOf } from "../domain/relations.js"
import { ingestLines, jsonlLines } from "../services/ingest.js"
import { envelopeOf, recordsFixture, SOURCE, type TestStore, take, upsert } from "../testing/records.js"

const handles: { close(): unknown }[] = []
afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.close()
})

type Sql = Awaited<ReturnType<typeof recordsFixture>>["sql"]

interface Link {
  id: number
  kind: string
  from: string
  to: string
  role: string | null
  metadata: Record<string, unknown> | null
  account: string | null
  withdrawn: boolean
}

/** Every relationship link a source account holds, withdrawn ones too. */
const reported = (sql: Sql, kind?: string): Link[] =>
  sql()
    .prepare(
      "SELECT l.id, l.kind, l.from_type, l.from_id, l.to_type, l.to_id, l.role, l.metadata, l.deleted_at, " +
        "a.provider || ':' || a.external_id AS account FROM links l JOIN accounts a ON a.id = l.account_id " +
        "WHERE ? IS NULL OR l.kind = ? ORDER BY l.id",
    )
    .all(kind ?? null, kind ?? null)
    .map((row) => ({
      id: Number(row.id),
      kind: String(row.kind),
      from: `${row.from_type}:${row.from_id}`,
      to: `${row.to_type}:${row.to_id}`,
      role: row.role == null ? null : String(row.role),
      metadata: row.metadata == null ? null : (JSON.parse(String(row.metadata)) as Record<string, unknown>),
      account: row.account == null ? null : String(row.account),
      withdrawn: row.deleted_at != null,
    }))

/** A person the store already has, with an e-mail identity when given one, as mail writes it. */
const knownPerson = (sql: Sql, name: string, email?: string): string => {
  const db = sql()
  const person = Number(
    db.prepare("INSERT INTO persons (name, created_at, updated_at) VALUES (?, 1, 1) RETURNING id").get(name)?.id,
  )
  if (email) {
    const identity = Number(
      db
        .prepare(
          "INSERT INTO identities (provider, external_id, name, email, created_at, updated_at) " +
            "VALUES ('email', ?, ?, ?, 1, 1) RETURNING id",
        )
        .get(email, name, email)?.id,
    )
    db.prepare(
      "INSERT INTO identity_links (identity_id, person_id, method, confidence, created_at, author, updated_at) " +
        "VALUES (?, ?, 'initial', 1, 1, 'ingest', 1)",
    ).run(identity, person)
  }
  return `person:${person}`
}

const live = (links: Link[]) => links.filter((link) => !link.withdrawn)

const entityOf = async (store: TestStore, type: string, externalId: string, source = SOURCE) =>
  (await store.records.get({ ...source, type, externalId }))?.entity as string

const org = (id: string, extra: Partial<EnvelopeRecord> = {}) =>
  upsert(
    "organization",
    id,
    { name: id, identifiers: [{ scheme: "tax-id:ru", value: `77${id.length}0000${id}` }] },
    extra,
  )

const memberOf = (person: string, organization: string, fields: Record<string, unknown> = {}, as?: string) =>
  upsert(
    "person",
    person,
    { name: person, email: `${person}@example.com`, ...fields },
    { relations: [{ role: "member-of", type: "organization", external_id: organization, ...(as ? { as } : {}) }] },
  )

const PIPELINE = upsert("pipeline", "sales", {
  kind: "deal",
  name: "Sales",
  stages: [{ external_id: "new", name: "New", position: 1, outcome: "open" }],
})

const deal = (person: string, as: string) =>
  upsert(
    "deal",
    "d1",
    { title: "Fleet", pipeline: "sales", stage: "new" },
    { relations: [{ role: "person", type: "person", external_id: person, as }] },
  )

const EXAMPLE = new URL("../../schemas/examples/records-business.jsonl", import.meta.url)
const KEY = { provider: "example-erp", account: "demo" }

describe("the plan's example", () => {
  it("reports the member, the contract party and the deal's person, and a re-import keeps them", async () => {
    const { store, sql } = await recordsFixture(handles)
    const run = () => ingestLines(store, jsonlLines(createReadStream(EXAMPLE)), { account: "demo" })
    const first = await run()
    expect(first.relationships).toEqual({
      added: 3,
      kept: 0,
      restored: 0,
      withdrawn: 0,
      proposed: 0,
      skippedOwnerRejected: 0,
    })
    expect(first.errors).toEqual([])
    const [organization, anna, deal, contract] = await Promise.all([
      entityOf(store, "organization", "C-1", { ...KEY, batch_id: "" }),
      entityOf(store, "person", "P-1", { ...KEY, batch_id: "" }),
      entityOf(store, "deal", "D-7", { ...KEY, batch_id: "" }),
      entityOf(store, "contract", "K-2026-14", { ...KEY, batch_id: "" }),
    ])
    const account = "example-erp:demo"
    expect(reported(sql).map(({ kind, from, to, role, account: by }) => ({ kind, from, to, role, by }))).toEqual(
      expect.arrayContaining([
        { kind: "member-of", from: anna, to: organization, role: null, by: account },
        { kind: "related-to", from: deal, to: anna, role: "decision-maker", by: account },
        { kind: "related-to", from: contract, to: organization, role: "customer", by: account },
      ]),
    )
    const again = await run()
    expect(again.relationships).toMatchObject({ added: 0, kept: 3, withdrawn: 0 })
    expect(live(reported(sql))).toHaveLength(3)
  })
})

describe("member-of", () => {
  it("takes a listed role, keeps an unlisted word as source_role and the title as position, never as the role", async () => {
    const { store, sql } = await recordsFixture(handles)
    const receipt = await take(
      store,
      envelopeOf([
        org("c1"),
        org("c2"),
        memberOf("ana", "c1", { position: "CTO" }, "founder"),
        memberOf("boris", "c2", { position: "Head of sales" }, "rainmaker"),
      ]),
    )
    expect(receipt.errors).toEqual([])
    const [ana, boris] = await Promise.all([entityOf(store, "person", "ana"), entityOf(store, "person", "boris")])
    const links = reported(sql, "member-of")
    expect(links.find((link) => link.from === ana)).toMatchObject({ role: "founder", metadata: { position: "CTO" } })
    expect(links.find((link) => link.from === boris)).toMatchObject({
      role: null,
      metadata: { source_role: ["rainmaker"], position: "Head of sales" },
    })
  })

  it("takes a word the owner added to the organization roles as the role", async () => {
    const { store, sql } = await recordsFixture(handles)
    await store.knowledge.addRole("organization", "rainmaker")
    await take(store, envelopeOf([org("c1"), memberOf("ana", "c1", {}, "rainmaker")]))
    expect(reported(sql, "member-of")).toEqual([expect.objectContaining({ role: "rainmaker", metadata: null })])
  })

  it("reports a member whose organization arrives in a later chunk", async () => {
    const { store, sql } = await recordsFixture(handles)
    const receipt = await ingestLines(
      store,
      (async function* () {
        yield JSON.stringify({ schema_version: 1, source: SOURCE })
        yield JSON.stringify(memberOf("ana", "c1"))
        yield JSON.stringify(org("c1"))
      })(),
      { account: SOURCE.account, chunk: 1 },
    )
    expect(receipt.relationships).toMatchObject({ added: 1 })
    expect(live(reported(sql, "member-of"))).toEqual([
      expect.objectContaining({
        from: await entityOf(store, "person", "ana"),
        to: await entityOf(store, "organization", "c1"),
      }),
    ])
  })

  it("takes a person's set from every record of the account that maps to the person", async () => {
    const { store, sql } = await recordsFixture(handles)
    await take(
      store,
      envelopeOf([
        org("c1"),
        org("c2"),
        memberOf("ana", "c1"),
        upsert(
          "person",
          "ana-again",
          { name: "Ana", email: "ana@example.com" },
          { relations: [{ role: "member-of", type: "organization", external_id: "c2" }] },
        ),
      ]),
    )
    expect(await entityOf(store, "person", "ana-again")).toBe(await entityOf(store, "person", "ana"))
    const again = await take(store, envelopeOf([memberOf("ana", "c1", { position: "CEO" })], { batch: "2" }))
    expect(again.relationships).toMatchObject({ kept: 2, withdrawn: 0 })
    expect(live(reported(sql, "member-of"))).toHaveLength(2)
  })
})

describe("a changed or deleted record", () => {
  it("adds a link for a changed role, withdraws the old one, and withdraws all of them on delete", async () => {
    const { store, sql } = await recordsFixture(handles)
    await take(
      store,
      envelopeOf([
        PIPELINE,
        upsert("person", "ana", { name: "Ana", email: "ana@example.com" }),
        deal("ana", "contact"),
      ]),
    )
    const changed = await take(store, envelopeOf([deal("ana", "decision-maker")], { batch: "2" }))
    expect(changed.relationships).toMatchObject({ added: 1, withdrawn: 1 })
    expect(live(reported(sql, "related-to"))).toEqual([expect.objectContaining({ role: "decision-maker" })])

    const deleted = await take(
      store,
      envelopeOf([{ key: "gone", type: "deal", external_id: "d1", operation: "delete" }], { batch: "3" }),
    )
    expect(deleted.relationships).toMatchObject({ withdrawn: 1 })
    expect(live(reported(sql))).toEqual([])
  })

  it("withdraws the links of a record sent again without its relations", async () => {
    const { store, sql } = await recordsFixture(handles)
    await take(
      store,
      envelopeOf([
        PIPELINE,
        upsert("person", "ana", { name: "Ana", email: "ana@example.com" }),
        deal("ana", "contact"),
      ]),
    )
    const bare = upsert("deal", "d1", { title: "Fleet", pipeline: "sales", stage: "new" })
    const again = await take(store, envelopeOf([bare], { batch: "2" }))
    expect(again.relationships).toMatchObject({ withdrawn: 1 })
    expect(live(reported(sql))).toEqual([])
  })

  it("never writes again the relationship the owner removed, role included", async () => {
    const { store, sql } = await recordsFixture(handles)
    const records = [org("c1"), memberOf("ana", "c1", {}, "founder")]
    await take(store, envelopeOf(records))
    const [link] = reported(sql, "member-of")
    await store.knowledge.removeRelation(null, String(link?.id), "owner")
    const again = await take(store, envelopeOf(records, { batch: "2" }))
    expect(again.relationships).toMatchObject({ added: 0, skippedOwnerRejected: 1 })
    expect(reported(sql, "member-of")).toEqual([])
  })
})

describe("partner-of", () => {
  it("keeps a partnership one side reports when the other side is imported again", async () => {
    const { store, sql } = await recordsFixture(handles)
    await take(
      store,
      envelopeOf([org("a"), org("b", { relations: [{ role: "partner-of", type: "organization", external_id: "a" }] })]),
    )
    const again = await take(store, envelopeOf([org("a")], { batch: "2" }))
    expect(again.relationships).toMatchObject({ withdrawn: 0, kept: 1 })
    expect(live(reported(sql, "partner-of"))).toHaveLength(1)
  })
})

describe("issues", () => {
  it("keeps a contract party's unlisted word as source_role with a notice, and names a missing ref in errors", async () => {
    const { store, sql } = await recordsFixture(handles)
    const receipt = await take(
      store,
      envelopeOf([
        org("c1"),
        upsert(
          "contract",
          "k1",
          { name: "Lease", kind: "service" },
          {
            relations: [
              { role: "party", type: "organization", external_id: "c1", as: "witness" },
              { role: "party", ref: "person:999999" },
            ],
          },
        ),
      ]),
    )
    expect(receipt.errors).toEqual([
      expect.objectContaining({
        pointer: "/records/1/relations",
        code: "relationship.reference-unknown",
        key: "contract-k1",
      }),
    ])
    expect(receipt.notices).toEqual([
      expect.objectContaining({
        pointer: "/records/1/relations",
        code: "relationship.role-unlisted",
        key: "contract-k1",
      }),
    ])
    expect(receipt.refused).toBe(0)
    expect(reported(sql, "related-to")).toEqual([
      expect.objectContaining({ role: null, metadata: { source_role: ["witness"] } }),
    ])
  })

  it("takes a contract role the owner added", async () => {
    const { store, sql } = await recordsFixture(handles)
    await store.knowledge.addRole("contract", "witness")
    const receipt = await take(
      store,
      envelopeOf([
        org("c1"),
        upsert(
          "contract",
          "k1",
          { name: "Lease", kind: "service" },
          { relations: [{ role: "party", type: "organization", external_id: "c1", as: "witness" }] },
        ),
      ]),
    )
    expect(receipt.errors).toEqual([])
    expect(reported(sql, "related-to")).toEqual([expect.objectContaining({ role: "witness" })])
    await expect(store.knowledge.removeRole("contract", "witness")).rejects.toMatchObject({
      details: { reason: "relationship.role-in-use" },
    })
  })
})

describe("accounts", () => {
  it("leaves a CRM's links under its account alone, and the CRM leaves the import's", async () => {
    const { store, sql } = await recordsFixture(handles)
    const PORTAL = { provider: "example-crm", account: "portal-a" }
    await store.crm.saveOrganizations(PORTAL, [{ externalId: "c1", name: "Example LLC" }])
    await store.crm.savePeople(PORTAL, [
      {
        externalId: "5",
        name: "Ana",
        email: "ana@example.com",
        organizations: [{ externalId: "c1" }],
        position: "CTO",
      },
    ])
    const crmOrg = await entityOf(store, "organization", "c1", { ...PORTAL, batch_id: "" })
    const record = upsert(
      "person",
      "ana",
      { name: "Ana", email: "ana@example.com" },
      { relations: [{ role: "member-of", ref: crmOrg, as: "founder" }] },
    )
    await take(store, envelopeOf([record]))
    await store.crm.savePeople(PORTAL, [
      {
        externalId: "5",
        name: "Ana",
        email: "ana@example.com",
        organizations: [{ externalId: "c1" }],
        position: "CTO",
      },
    ])
    await take(store, envelopeOf([record], { batch: "2" }))
    expect(live(reported(sql, "member-of")).map(({ role, account }) => ({ role, account }))).toEqual(
      expect.arrayContaining([
        { role: "contact", account: "example-crm:portal-a" },
        { role: "founder", account: `${SOURCE.provider}:${SOURCE.account}` },
      ]),
    )
  })

  it("diffs an envelope on the CRM's own account as that account's set", async () => {
    const { store, sql } = await recordsFixture(handles)
    const PORTAL = { provider: "example-crm", account: "portal-a" }
    await store.crm.savePipelines(PORTAL, "deal", [
      { externalId: "p1", name: "Sales", stages: [{ externalId: "s1", name: "New", position: 1, outcome: "open" }] },
    ])
    await store.crm.savePeople(PORTAL, [{ externalId: "5", name: "Ana", email: "ana@example.com" }])
    await store.crm.saveItems(PORTAL, "deal", [
      {
        externalId: "d1",
        title: "Website",
        pipeline: "p1",
        stage: "s1",
        people: [{ externalId: "5", role: "contact" }],
      },
    ])
    const boris = knownPerson(sql, "Boris")
    await take(
      store,
      envelopeOf(
        [
          upsert(
            "deal",
            "d1",
            { title: "Website", pipeline: "p1", stage: "s1" },
            { relations: [{ role: "person", ref: boris, as: "owner" }] },
          ),
        ],
        { ...PORTAL },
      ),
      { account: PORTAL.account },
    )
    expect(live(reported(sql, "related-to")).map(({ to, role }) => ({ to, role }))).toEqual([
      { to: boris, role: "owner" },
    ])
  })
})

describe("the owner's map and match", () => {
  it("moves the reported links with the entity on a remap, and what pointed at the old one", async () => {
    const { store, sql } = await recordsFixture(handles)
    await take(store, envelopeOf([org("c1"), memberOf("ana", "c1"), PIPELINE, deal("ana", "contact")]))
    const made = await entityOf(store, "person", "ana")
    const real = knownPerson(sql, "Ana Real")
    await store.records.map({ ...SOURCE, type: "person", externalId: "ana" }, real, "owner")
    const links = live(reported(sql))
    expect(links.map(({ kind, from, to }) => ({ kind, from, to }))).toEqual(
      expect.arrayContaining([
        { kind: "member-of", from: real, to: await entityOf(store, "organization", "c1") },
        { kind: "related-to", from: await entityOf(store, "deal", "d1"), to: real },
      ]),
    )
    expect(links.some((link) => link.from === made || link.to === made)).toBe(false)
  })

  it("reports an unmatched person's links once the owner says who it is", async () => {
    const { store, sql } = await recordsFixture(handles)
    const one = knownPerson(sql, "One", "ana@example.com")
    knownPerson(sql, "Two")
    sql()
      .prepare(
        "INSERT INTO identities (provider, external_id, name, phone, created_at, updated_at) " +
          "VALUES ('phone', '+79000000002', 'Two', '+79000000002', 1, 1)",
      )
      .run()
    sql()
      .prepare(
        "INSERT INTO identity_links (identity_id, person_id, method, confidence, created_at, author, updated_at) " +
          "SELECT i.id, p.id, 'initial', 1, 1, 'ingest', 1 FROM identities i, persons p " +
          "WHERE i.external_id = '+79000000002' AND p.name = 'Two'",
      )
      .run()
    const receipt = await take(store, envelopeOf([org("c1"), memberOf("ana", "c1", { phone: "+7 900 000 00 02" })]))
    expect(receipt.unmatched).toHaveLength(1)
    expect(reported(sql, "member-of")).toEqual([])
    await store.records.map({ ...SOURCE, type: "person", externalId: "ana" }, one, "owner")
    expect(live(reported(sql, "member-of"))).toEqual([expect.objectContaining({ from: one })])
  })
})

describe("records match", () => {
  it("reports the links of a person it makes for an account", async () => {
    const { store, sql } = await recordsFixture(handles)
    const one = knownPerson(sql, "One", "ana@example.com")
    await take(store, envelopeOf([org("c1"), memberOf("ana", "c1")]))
    sql()
      .prepare("DELETE FROM identity_links WHERE person_id = ?")
      .run(Number(one.split(":")[1]))
    sql().prepare("UPDATE records SET entity_type = NULL, entity_id = NULL WHERE type = 'person'").run()
    sql().prepare("UPDATE links SET deleted_at = 1").run()
    const matched = await store.records.match({ provider: SOURCE.provider, account: SOURCE.account })
    expect(matched).toMatchObject({ created: 1, errors: [] })
    const made = await entityOf(store, "person", "ana")
    expect(live(reported(sql, "member-of"))).toEqual([expect.objectContaining({ from: made })])
  })
})

describe("a dry run", () => {
  it("counts the relationships and writes none", async () => {
    const { store, sql } = await recordsFixture(handles)
    const receipt = await take(store, envelopeOf([org("c1"), memberOf("ana", "c1")]), { dryRun: true })
    expect(receipt.relationships).toMatchObject({ added: 1 })
    expect(reported(sql)).toEqual([])
  })
})

describe("the registry", () => {
  it("relates a contract only to a person or an organization, with the contract role list", () => {
    expect(roleListOf("related-to", "contract", "organization")).toBe("contract")
    expect(() => checkEnds("related-to", "contract", "person")).not.toThrow()
    expect(() => checkEnds("related-to", "contract", "project")).toThrow(/only to a person or an organization/)
  })
})

describe("the review's cases", () => {
  const contract = (as: string, extra: Record<string, unknown> = {}) =>
    upsert(
      "contract",
      "k1",
      { name: "Lease", kind: "service", ...extra },
      { relations: [{ role: "party", type: "organization", external_id: "c1", as }] },
    )

  it("withdraws a rejected contract's parties at once, and a re-import does not bring them back", async () => {
    const { store, sql } = await recordsFixture(handles)
    const records = [org("c1"), contract("customer", { value: "1000.00", currency: "EUR" })]
    await take(store, envelopeOf(records))
    expect(live(reported(sql, "related-to"))).toHaveLength(1)
    await store.contracts.reject(await entityOf(store, "contract", "k1"), "owner")
    expect(live(reported(sql, "related-to"))).toEqual([])
    const again = await take(store, envelopeOf(records, { batch: "2" }))
    expect(again.relationships).toMatchObject({ added: 0, kept: 0, restored: 0 })
    expect(live(reported(sql, "related-to"))).toEqual([])
  })

  it("is the contract alone among the reviewed types that report relationships, so rejecting it withdraws them", () => {
    const reviewed = Object.entries(RECORD_TYPES).flatMap(([type, spec]) =>
      (spec.review === "proposal" || spec.review === "valued-proposal") &&
      Object.values(spec.roles as Record<string, RecordRoleSpec>).some((role) => role.relationship)
        ? [type]
        : [],
    )
    expect(reviewed).toEqual(["contract"])
  })

  it("leaves the pair a link when a party's role changes to a word off the list", async () => {
    const { store, sql } = await recordsFixture(handles)
    await take(store, envelopeOf([org("c1"), contract("customer")]))
    const changed = await take(store, envelopeOf([contract("buyer")], { batch: "2" }))
    expect(changed).toMatchObject({ errors: [], relationships: { added: 1, withdrawn: 1 } })
    expect(live(reported(sql, "related-to"))).toEqual([
      expect.objectContaining({ role: null, metadata: { source_role: ["buyer"] } }),
    ])
  })

  it("takes the role once the owner adds the word to the list, and withdraws the link without one", async () => {
    const { store, sql } = await recordsFixture(handles)
    const records = [org("c1"), memberOf("ana", "c1", {}, "rainmaker")]
    await take(store, envelopeOf(records))
    await store.knowledge.addRole("organization", "rainmaker")
    const again = await take(store, envelopeOf(records, { batch: "2" }))
    expect(again).toMatchObject({ notices: [], relationships: { added: 1, withdrawn: 1 } })
    expect(live(reported(sql, "member-of"))).toEqual([expect.objectContaining({ role: "rainmaker", metadata: null })])
  })

  it("keeps every word when two records, or the two sides of a partnership, use different ones", async () => {
    const { store, sql } = await recordsFixture(handles)
    await take(
      store,
      envelopeOf([
        org("c1"),
        org("a", { relations: [{ role: "partner-of", type: "organization", external_id: "b", as: "reseller" }] }),
        org("b", { relations: [{ role: "partner-of", type: "organization", external_id: "a", as: "distributor" }] }),
        memberOf("ana", "c1", {}, "rainmaker"),
        upsert(
          "person",
          "ana-again",
          { name: "Ana", email: "ana@example.com" },
          { relations: [{ role: "member-of", type: "organization", external_id: "c1", as: "closer" }] },
        ),
      ]),
    )
    const words = (kind: string) =>
      [...((live(reported(sql, kind))[0]?.metadata?.source_role as string[]) ?? [])].sort()
    expect(live(reported(sql, "member-of"))).toHaveLength(1)
    expect(words("member-of")).toEqual(["closer", "rainmaker"])
    expect(live(reported(sql, "partner-of"))).toHaveLength(1)
    expect(words("partner-of")).toEqual(["distributor", "reseller"])
  })

  it("counts each link once per run when one entity's records come in separate chunks", async () => {
    const { store, sql } = await recordsFixture(handles)
    const ana = memberOf("ana", "c1")
    const again = upsert(
      "person",
      "ana-again",
      { name: "Ana", email: "ana@example.com" },
      { relations: [{ role: "member-of", type: "organization", external_id: "c2" }] },
    )
    await take(store, envelopeOf([org("c1"), org("c2"), ana, again]))
    const lines = async function* (batch: string) {
      yield JSON.stringify({ schema_version: 1, source: { ...SOURCE, batch_id: batch } })
      yield JSON.stringify(ana)
      yield JSON.stringify(again)
    }
    const kept = await ingestLines(store, lines("2"), { account: SOURCE.account, chunk: 1 })
    expect(kept.relationships).toMatchObject({ added: 0, kept: 2 })

    sql()
      .prepare("INSERT INTO store_settings (key, value, at) VALUES (?, ?, 1)")
      .run(`crm.${SOURCE.provider}:${SOURCE.account}.links`, JSON.stringify("review"))
    const twice = upsert(
      "person",
      "bo",
      { name: "Bo", email: "bo@example.com" },
      { relations: [{ role: "member-of", type: "organization", external_id: "c1" }] },
    )
    const twiceAgain = upsert(
      "person",
      "bo-again",
      { name: "Bo", email: "bo@example.com" },
      { relations: [{ role: "member-of", type: "organization", external_id: "c1" }] },
    )
    const proposed = await ingestLines(
      store,
      (async function* () {
        yield JSON.stringify({ schema_version: 1, source: { ...SOURCE, batch_id: "3" } })
        yield JSON.stringify(twice)
        yield JSON.stringify(twiceAgain)
      })(),
      { account: SOURCE.account, chunk: 1 },
    )
    const pending = sql()
      .prepare("SELECT count(*) AS n FROM proposed_actions WHERE kind = 'relationship' AND status = 'proposed'")
      .get()
    expect(proposed.relationships.proposed).toBe(Number(pending?.n))
    expect(pending?.n).toBe(1)
  })

  it("counts a link the owner confirmed as kept", async () => {
    const { store, sql } = await recordsFixture(handles)
    const records = [org("c1"), memberOf("ana", "c1")]
    await take(store, envelopeOf(records))
    await store.knowledge.confirmRelation(null, String(reported(sql, "member-of")[0]?.id), "owner")
    const again = await take(store, envelopeOf(records, { batch: "2" }))
    expect(again.relationships).toMatchObject({ added: 0, kept: 1, withdrawn: 0 })
  })

  it("names the record of an earlier batch an issue is about", async () => {
    const { store } = await recordsFixture(handles)
    await take(
      store,
      envelopeOf([
        org("c1"),
        upsert(
          "contract",
          "k1",
          { name: "Lease", kind: "service" },
          {
            relations: [
              { role: "party", type: "organization", external_id: "c1", as: "customer" },
              { role: "party", ref: "person:999999" },
            ],
          },
        ),
      ]),
    )
    const receipt = await take(
      store,
      envelopeOf([{ key: "gone", type: "organization", external_id: "c1", operation: "delete" }], { batch: "2" }),
    )
    expect(receipt.errors).toEqual([
      expect.objectContaining({
        pointer: "",
        code: "relationship.reference-unknown",
        record: { type: "contract", externalId: "k1" },
      }),
    ])
  })
})
