import { isCliError } from "@wirecat/cli-base"
import { type FakeCall, fakeApi, type ManifestOperation, type SchemaNode } from "@wirecat/cli-base/codegen"
import { describe, expect, it } from "vitest"
import { serviceApiCall } from "../../cli/service-api-call.js"
import type { ServiceApiManifest } from "../../cli/service-api-manifest.js"
import type { CrmItem, CrmOrganization, CrmPerson } from "../../domain/crm.js"
import type { CrmCallContext, CrmGap, CrmPage, CrmSource } from "../source.js"
import { crmSourceContract } from "../testing/source-contract.js"
import { amountOf, type CrmRaw } from "../values.js"
import { type CrmManifest, parseCrmManifest } from "./manifest.js"
import { crmManifestProblems } from "./paths.js"
import { crmSourceFromManifest } from "./source.js"

// A trimmed copy of HubSpot's CRM API (objects v2026-03, pipelines, properties, owners): enough operations, in the
// generated manifest's own shape, for its adapter's mapping to be written as a manifest and checked by the contract.

const BASE = "https://api.hubapi.com"
const TOKEN = "test-token"

const str: SchemaNode = { type: "string" }
const int: SchemaNode = { type: "integer" }
const bool: SchemaNode = { type: "boolean" }
const obj = (properties: Record<string, SchemaNode>, required: string[] = []): SchemaNode => ({
  type: "object",
  properties,
  required,
})
const list = (items: SchemaNode): SchemaNode => ({ type: "array", items })
const ref = (name: string): SchemaNode => ({ type: "ref", ref: name })

const definitions: Record<string, SchemaNode> = {
  Row: {
    type: "object",
    properties: {
      id: str,
      properties: { type: "object", properties: {}, required: [], additionalProperties: { ...str, nullable: true } },
      createdAt: str,
      updatedAt: str,
      archived: bool,
      associations: {
        type: "object",
        properties: {},
        required: [],
        additionalProperties: obj({ results: list(obj({ id: str, type: str }, ["id"])) }, ["results"]),
      },
    },
    required: ["id", "properties"],
  },
  RowPage: obj({ results: list(ref("Row")), paging: obj({ next: obj({ after: str }, ["after"]) }) }, ["results"]),
  Search: obj({
    filterGroups: list(obj({ filters: list(obj({ propertyName: str, operator: str, value: str })) })),
    sorts: list(obj({ propertyName: str, direction: str })),
    properties: list(str),
    limit: int,
    after: str,
  }),
  Pipelines: obj({
    results: list(
      obj({
        id: str,
        label: str,
        displayOrder: int,
        stages: list(
          obj({
            id: str,
            label: str,
            displayOrder: int,
            metadata: { type: "object", properties: {}, required: [], additionalProperties: str },
          }),
        ),
      }),
    ),
  }),
  Properties: obj({
    results: list(
      obj({
        name: str,
        label: str,
        type: str,
        fieldType: str,
        hubspotDefined: bool,
        options: list(obj({ label: str, value: str, hidden: bool })),
      }),
    ),
  }),
  Owners: obj({
    results: list(obj({ id: str, firstName: str, lastName: str, email: str, archived: bool })),
    paging: obj({ next: obj({ after: str }) }),
  }),
}

const query = (name: string, schema: SchemaNode = str) => ({ name, in: "query", required: false, schema }) as const
const cursor = (where: "query" | "body") =>
  ({
    style: "cursor",
    cursor: { in: where, name: "after" },
    next: "paging.next.after",
    items: "results",
  }) as const

const op = (
  id: string,
  method: "GET" | "POST",
  path: string,
  extra: Partial<ManifestOperation>,
): ManifestOperation => ({
  id,
  command: id,
  binding: { kind: "http", method, path },
  effect: "read",
  tags: [],
  parameters: [],
  ...extra,
})

const READ = [query("properties", list(str)), query("associations", list(str))]

const objectOperations = (name: string, path: string, single: string): ManifestOperation[] => [
  op(`${name}_getPage`, "GET", `/crm/objects/2026-03/${path}`, {
    parameters: [query("limit", int), query("after"), query("archived", bool), ...READ],
    response: { confidence: "contract", schema: "RowPage" },
    pagination: cursor("query"),
  }),
  // Search is a POST that only reads: the generator's `effect: read` override marks it so.
  op(`${name}_search`, "POST", `/crm/objects/2026-03/${path}/search`, {
    request: { required: true, confidence: "contract", schema: "Search" },
    response: { confidence: "contract", schema: "RowPage" },
    pagination: cursor("body"),
  }),
  op(`${name}_getById`, "GET", `/crm/objects/2026-03/${path}/{${single}}`, {
    parameters: [{ name: single, in: "path", required: true, schema: str }, ...READ],
    response: { confidence: "contract", schema: "Row" },
  }),
]

const api: ServiceApiManifest = {
  operations: [
    ...objectOperations("companies", "companies", "companyId"),
    ...objectOperations("contacts", "contacts", "contactId"),
    ...objectOperations("deals", "0-3", "dealId"),
    op("pipelines_getAll", "GET", "/crm/pipelines/2026-03/{objectType}", {
      parameters: [{ name: "objectType", in: "path", required: true, schema: str }],
      response: { confidence: "contract", schema: "Pipelines" },
    }),
    op("properties_getAll", "GET", "/crm/properties/2026-03/{objectType}", {
      parameters: [{ name: "objectType", in: "path", required: true, schema: str }],
      response: { confidence: "contract", schema: "Properties" },
    }),
    op("owners_getPage", "GET", "/crm/owners/2026-03", {
      parameters: [query("limit", int), query("after"), query("archived", bool)],
      response: { confidence: "contract", schema: "Owners" },
      pagination: cursor("query"),
    }),
  ],
  servers: [{ url: BASE }],
  securitySchemes: { token: { type: "http", scheme: "bearer" } },
  security: [{ token: [] }],
}

const changedSince = (modified: string) => ({
  filterGroups: [{ filters: [{ propertyName: modified, operator: "GTE", value: "{since}" }] }],
  sorts: [{ propertyName: modified, direction: "ASCENDING" }],
  properties: "{select}",
  limit: 2,
})

const objects = (name: string, modified: string, associations?: string) => ({
  list: {
    operation: `${name}_getPage`,
    query: { limit: 2, archived: false, properties: "{select}", ...(associations ? { associations } : {}) },
  },
  changes: {
    operation: `${name}_search`,
    body: changedSince(modified),
    since: "ms" as const,
    // The search guide's limit: a query reaches its first 10,000 results only.
    keyset: { field: `properties.${modified}`, cap: 10_000 },
  },
  ids: { operation: `${name}_getPage`, query: { limit: 2, archived: false } },
  select: { from: "properties" },
})

/** HubSpot's adapter (hubspot-cli `src/crm/records.ts` at 9b7043b) for contacts, companies and deals, as data. */
const MANIFEST: CrmManifest = {
  provider: "hubspot",
  kinds: ["organization", "person", "deal"],
  entities: {
    organization: {
      ...objects("companies", "hs_lastmodifieddate"),
      get: { operation: "companies_getById", path: { companyId: "{id}" }, query: { properties: "{select}" } },
      map: {
        externalId: "id",
        name: { first: ["properties.name", "properties.domain"] },
        phones: { all: ["properties.phone"] },
        assignee: "properties.hubspot_owner_id",
        createdAt: "properties.createdate",
        updatedAt: "properties.hs_lastmodifieddate",
      },
      custom: { from: "properties" },
    },
    person: {
      ...objects("contacts", "lastmodifieddate", "companies"),
      get: {
        operation: "contacts_getById",
        path: { contactId: "{id}" },
        query: { properties: "{select}", associations: "companies" },
      },
      map: {
        externalId: "id",
        name: { join: ["properties.firstname", "properties.lastname"] },
        firstName: "properties.firstname",
        lastName: "properties.lastname",
        emails: { all: ["properties.email", "properties.hs_additional_emails"], split: ";" },
        phones: { all: ["properties.phone", "properties.mobilephone"] },
        position: "properties.jobtitle",
        organizations: {
          each: "associations.companies.results",
          id: "id",
          primary: "properties.associatedcompanyid",
        },
        assignee: "properties.hubspot_owner_id",
        createdAt: "properties.createdate",
        updatedAt: "properties.lastmodifieddate",
      },
    },
    deal: {
      ...objects("deals", "hs_lastmodifieddate", "contacts,companies"),
      map: {
        externalId: "id",
        title: "properties.dealname",
        pipeline: "properties.pipeline",
        stage: "properties.dealstage",
        amount: "properties.amount",
        currency: "properties.deal_currency_code",
        closeDate: "properties.closedate",
        closedReason: { first: ["properties.closed_won_reason", "properties.closed_lost_reason"] },
        organization: "associations.companies.results.0.id",
        people: { each: "associations.contacts.results", id: "id" },
        assignee: "properties.hubspot_owner_id",
        createdAt: "properties.createdate",
        updatedAt: "properties.hs_lastmodifieddate",
      },
      custom: { from: "properties", split: ";" },
    },
  },
  pipelines: {
    deal: {
      call: { operation: "pipelines_getAll", path: { objectType: "deals" }, items: "results" },
      map: { externalId: "id", name: "label" },
      stages: {
        each: "stages",
        map: { externalId: "id", name: "label", position: "displayOrder" },
        // A closed deal stage is won at probability 1.0 and lost at 0.0 (HubSpot pipelines guide).
        outcome: (stage) =>
          (stage.metadata as CrmRaw | undefined)?.isClosed !== "true"
            ? "open"
            : Number((stage.metadata as CrmRaw).probability) === 1
              ? "won"
              : "lost",
      },
    },
  },
  fields: Object.fromEntries(
    (["organization", "person", "deal"] as const).map((kind) => [
      kind,
      {
        call: {
          operation: "properties_getAll",
          path: { objectType: { organization: "companies", person: "contacts", deal: "deals" }[kind] },
          items: "results",
        },
        map: {
          code: "name",
          label: "label",
          type: "type",
          multiple: (raw: CrmRaw) => raw.type === "enumeration" && raw.fieldType === "checkbox",
          options: { each: "options", id: "value", label: "label" },
        },
        keep: (raw: CrmRaw) => raw.hubspotDefined !== true,
      },
    ]),
  ),
  users: {
    call: { operation: "owners_getPage", query: { limit: 2 } },
    map: {
      externalId: "id",
      name: { join: ["firstName", "lastName"] },
      email: "email",
      active: (raw) => raw.archived !== true,
    },
  },
}

/** The account's currency, for a deal with an amount and none of its own: a hook, as HubSpot reads it elsewhere. */
const hooks = {
  after: {
    deal: (deal: CrmItem, raw: CrmRaw): CrmItem => {
      const properties = raw.properties as CrmRaw
      return properties.amount && !properties.deal_currency_code
        ? { ...deal, ...amountOf(properties.amount, "USD") }
        : deal
    },
  },
}

const SEEDED = Date.parse("2026-11-01T10:00:00Z")

interface Row {
  id: string
  properties: Record<string, string | null>
  associations?: Record<string, string[]>
}

const MODIFIED: Record<string, string> = { contacts: "lastmodifieddate", companies: "hs_lastmodifieddate" }
const modifiedOf = (type: string) => MODIFIED[type] ?? "hs_lastmodifieddate"

const at = (ms: number) => new Date(ms).toISOString()

/** A HubSpot account in memory: pages of two, search by modified time, and the contract's faults. */
const fakeHubspot = () => {
  const stamp = (type: string, offset: number) => ({ createdate: at(SEEDED), [modifiedOf(type)]: at(SEEDED + offset) })
  const rows: Record<string, Row[]> = {
    companies: [
      {
        id: "101",
        properties: { name: "Acme", domain: "acme.test", phone: "+1 555 0101", tier: "gold", ...stamp("companies", 1) },
      },
      { id: "102", properties: { name: null, domain: "beta.test", phone: null, ...stamp("companies", 2) } },
      { id: "103", properties: { name: "Gamma", hubspot_owner_id: "7", ...stamp("companies", 3) } },
    ],
    contacts: [
      {
        id: "201",
        properties: {
          firstname: "Ana",
          lastname: "Lee",
          email: "ana@acme.test",
          hs_additional_emails: "ana.lee@acme.test;ana@acme.test",
          phone: "+1 555 0201",
          mobilephone: "+1 555 0202",
          jobtitle: "Buyer",
          associatedcompanyid: "102",
          hubspot_owner_id: "7",
          ...stamp("contacts", 1),
        },
        associations: { companies: ["101", "102"] },
      },
      { id: "202", properties: { firstname: "Ben", lastname: null, email: "ben@beta.test", ...stamp("contacts", 2) } },
      { id: "203", properties: { firstname: "Cy", ...stamp("contacts", 3) }, associations: { companies: [] } },
    ],
    "0-3": [
      {
        id: "301",
        properties: {
          dealname: "Example kitchen",
          pipeline: "default",
          dealstage: "closedwon",
          amount: "1200.50",
          deal_currency_code: "EUR",
          closedate: "2026-10-30T12:00:00Z",
          closed_won_reason: "Fast install",
          kitchen_size: "s;m",
          hubspot_owner_id: "7",
          ...stamp("0-3", 1),
        },
        associations: { contacts: ["201"], companies: ["101"] },
      },
      {
        id: "302",
        properties: { dealname: "Office", pipeline: "default", dealstage: "open", amount: "90", ...stamp("0-3", 2) },
      },
      {
        id: "303",
        properties: { dealname: "Lost one", pipeline: "default", dealstage: "closedlost", ...stamp("0-3", 3) },
      },
    ],
  }
  const denied = new Map<string, number>()
  const refusedTypes = new Set<string>()
  const page = <T>(all: T[], after: unknown, limit: number) => {
    const from = Number(after ?? 0)
    const next = from + limit
    return {
      results: all.slice(from, next),
      ...(next < all.length ? { paging: { next: { after: String(next) } } } : {}),
    }
  }
  const typeOf = (call: FakeCall) => call.url.pathname.split("/")[4] as string
  const shaped = (row: Row, wanted: unknown, associations: readonly string[]) => ({
    id: row.id,
    properties: Object.fromEntries(
      (Array.isArray(wanted) ? wanted : []).map((name: string) => [name, row.properties[name] ?? null]),
    ),
    ...(associations.length
      ? {
          associations: Object.fromEntries(
            associations.map((type) => [
              type,
              { results: (row.associations?.[type] ?? []).map((id) => ({ id, type: `${type}_unlabeled` })) },
            ]),
          ),
        }
      : {}),
  })
  const listOf = (call: FakeCall) => {
    const type = typeOf(call)
    if (refusedTypes.has(type)) return { status: 403, body: { message: "missing scope" } }
    const wanted = call.query.properties
    const associations = call.query.associations
    return {
      body: page(
        (rows[type] ?? []).map((row) =>
          shaped(
            row,
            typeof wanted === "string" ? [wanted] : wanted,
            typeof associations === "string" ? [associations] : (associations ?? []),
          ),
        ),
        call.query.after,
        Number(call.query.limit ?? 100),
      ),
    }
  }
  const searchOf = (call: FakeCall) => {
    const type = typeOf(call)
    if (refusedTypes.has(type)) return { status: 403, body: { message: "missing scope" } }
    const body = call.body as {
      filterGroups: { filters: { value: string }[] }[]
      properties?: string[]
      after?: string
      limit: number
    }
    const since = Number(body.filterGroups[0]?.filters[0]?.value)
    const modified = modifiedOf(type)
    const found = (rows[type] ?? [])
      .filter((row) => Date.parse(row.properties[modified] ?? "") >= since)
      .sort((a, b) => Date.parse(a.properties[modified] ?? "") - Date.parse(b.properties[modified] ?? ""))
    // Search answers no associations (HubSpot search guide).
    return {
      body: page(
        found.map((row) => shaped(row, body.properties, [])),
        body.after,
        body.limit,
      ),
    }
  }
  const byId = (call: FakeCall) => {
    const type = typeOf(call)
    const id = Object.values(call.path)[0] as string
    const status = denied.get(`${type}/${id}`)
    if (status) return { status, body: { message: "denied" } }
    const row = rows[type]?.find((one) => one.id === id)
    if (!row) return { status: 404, body: { message: "not found" } }
    const wanted = call.query.properties
    const associations = call.query.associations
    return {
      body: shaped(
        row,
        typeof wanted === "string" ? [wanted] : wanted,
        typeof associations === "string" ? [associations] : (associations ?? []),
      ),
    }
  }
  const stages = (closed: string, probability: string) => ({ isClosed: closed, probability })
  const answers = Object.fromEntries([
    ...["companies", "contacts", "deals"].flatMap((name) => [
      [`${name}_getPage`, listOf],
      [`${name}_search`, searchOf],
      [`${name}_getById`, byId],
    ]),
    [
      "pipelines_getAll",
      () => ({
        body: {
          results: [
            {
              id: "default",
              label: "Sales",
              displayOrder: 0,
              stages: [
                { id: "open", label: "Open", displayOrder: 0, metadata: stages("false", "0.2") },
                { id: "closedwon", label: "Won", displayOrder: 1, metadata: stages("true", "1.0") },
                { id: "closedlost", label: "Lost", displayOrder: 2, metadata: stages("true", "0.0") },
              ],
            },
          ],
        },
      }),
    ],
    [
      "properties_getAll",
      (call: FakeCall) => ({
        body: {
          results: [
            { name: "dealname", label: "Deal name", type: "string", fieldType: "text", hubspotDefined: true },
            ...(call.path.objectType === "deals"
              ? [
                  {
                    name: "kitchen_size",
                    label: "Kitchen size",
                    type: "enumeration",
                    fieldType: "checkbox",
                    hubspotDefined: false,
                    options: [
                      { label: "Small", value: "s", hidden: false },
                      { label: "Medium", value: "m", hidden: false },
                    ],
                  },
                ]
              : call.path.objectType === "companies"
                ? [{ name: "tier", label: "Tier", type: "string", fieldType: "text", hubspotDefined: false }]
                : []),
          ],
        },
      }),
    ],
    [
      "owners_getPage",
      (call: FakeCall) => ({
        body: page(
          [
            { id: "7", firstName: "Olga", lastName: "Owner", email: "olga@seller.test", archived: false },
            { id: "8", firstName: "Gone", lastName: "User", email: "gone@seller.test", archived: true },
            { id: "7", firstName: "Olga", lastName: "Owner", email: "olga@seller.test", archived: false },
          ],
          call.query.after,
          Number(call.query.limit),
        ),
      }),
    ],
  ])
  const api_ = fakeApi({
    operations: api.operations,
    definitions,
    baseUrl: BASE,
    auth: { header: "authorization", value: `Bearer ${TOKEN}` },
    answers,
  })
  return {
    ...api_,
    deny: (type: string, id: string, status: number) => denied.set(`${type}/${id}`, status),
    refuse: (type: string) => refusedTypes.add(type),
    rows,
    touch: (type: string, id: string, properties: Record<string, string>) => {
      const row = rows[type]?.find((one) => one.id === id) as Row
      row.properties = { ...row.properties, ...properties, [modifiedOf(type)]: at(Date.now()) }
    },
  }
}

type FakeHubspot = ReturnType<typeof fakeHubspot>

const sourceOver = (hub: FakeHubspot, now: () => number = Date.now): CrmSource =>
  crmSourceFromManifest(MANIFEST, {
    api,
    call: serviceApiCall({ manifest: api, service: "HubSpot", fetch: hub.fetch, token: () => TOKEN }),
    now,
    hooks,
  })

const all = async <K extends "organization" | "person" | "deal">(
  source: CrmSource,
  kind: K,
  cursor: string | null = null,
) => {
  const items: unknown[] = []
  let page: string | undefined
  do {
    const answer = (await source.changes(kind, cursor, page)) as CrmPage<unknown>
    items.push(...answer.items)
    page = answer.nextCursor
  } while (page)
  return items
}

describe("crmSourceContract over HubSpot's mapping as a manifest", () => {
  const fakes: FakeHubspot[] = []
  for (const { name, run } of crmSourceContract(() => {
    const hub = fakeHubspot()
    fakes.push(hub)
    return {
      source: sourceOver(hub),
      deadCursor: { kind: "deal" as const, cursor: "not a time" },
      faults: {
        deny: (status: 403 | 404) => {
          hub.deny("contacts", "201", status)
          return { kind: "person" as const, id: "201" }
        },
        skewed: (ms: number) => sourceOver(hub, () => Date.now() + ms),
        change: () => {
          hub.touch("0-3", "302", { dealname: "Office, changed" })
          return { kind: "deal" as const, id: "302" }
        },
        sameToken: () => sourceOver(hub),
      },
    }
  }))
    it(name, async () => {
      await run()
      for (const hub of fakes.splice(0)) expect(hub.refusals).toEqual([])
    })
})

describe("crmSourceFromManifest", () => {
  it("maps HubSpot's rows as its adapter does, custom values and the hook's currency included", async () => {
    const source = sourceOver(fakeHubspot())
    const [ana] = (await all(source, "person")) as CrmPerson[]
    expect(ana).toMatchObject({
      externalId: "201",
      name: "Ana Lee",
      email: "ana@acme.test",
      emails: ["ana@acme.test", "ana.lee@acme.test"],
      phones: ["+1 555 0201", "+1 555 0202"],
      position: "Buyer",
      organizations: [{ externalId: "102", primary: true }, { externalId: "101" }],
      assignee: "7",
      createdAt: SEEDED,
    })
    const companies = (await all(source, "organization")) as CrmOrganization[]
    expect(companies.map(({ name }) => name)).toEqual(["Acme", "beta.test", "Gamma"])
    expect(companies[0]?.metadata).toEqual({ tier: { label: "Tier", value: "gold" } })
    const [kitchen, office] = (await all(source, "deal")) as CrmItem[]
    expect(kitchen).toMatchObject({
      amount: "1200.50",
      currency: "EUR",
      closeDate: "2026-10-30",
      closedReason: "Fast install",
      organization: "101",
      people: [{ externalId: "201", role: "contact" }],
      metadata: { kitchen_size: { label: "Kitchen size", value: ["Small", "Medium"], option_id: ["s", "m"] } },
    })
    expect(office).toMatchObject({ amount: "90", currency: "USD" })
    expect(await source.users?.()).toEqual([
      { externalId: "7", name: "Olga Owner", email: "olga@seller.test", active: true },
      { externalId: "8", name: "Gone User", email: "gone@seller.test", active: false },
    ])
  })

  it("leaves out a field the answer did not carry, so the stored copy keeps it", async () => {
    const hub = fakeHubspot()
    const source = sourceOver(hub)
    const listed = (await all(source, "deal")) as CrmItem[]
    expect(listed[0]?.people).toEqual([{ externalId: "201", role: "contact" }])
    const changed = (await all(source, "deal", at(SEEDED))) as CrmItem[]
    // The row at a page's boundary time is read again: saved twice, never missed.
    expect([...new Set(changed.map(({ externalId }) => externalId))]).toEqual(["301", "302", "303"])
    expect(changed[0]).not.toHaveProperty("people")
    expect(changed[0]).not.toHaveProperty("organization")
    const [, ben] = (await all(source, "person")) as CrmPerson[]
    // Asked for and none is an empty list, so a link removed in the CRM leaves the copy too.
    expect(ben).toMatchObject({ name: "Ben", lastName: null, organizations: [] })
  })

  it("asks only for the properties the map reads and the account's own fields", async () => {
    const hub = fakeHubspot()
    await sourceOver(hub).changes("deal", null)
    const listed = hub.calls.find((call) => call.operation === "deals_getPage")
    expect(listed?.query.properties).toEqual([
      "dealname",
      "pipeline",
      "dealstage",
      "amount",
      "deal_currency_code",
      "closedate",
      "closed_won_reason",
      "closed_lost_reason",
      "hubspot_owner_id",
      "createdate",
      "hs_lastmodifieddate",
      "kitchen_size",
    ])
    const changed = await sourceOver(hub).changes("deal", at(SEEDED + 60 * 60_000))
    const search = hub.calls.findLast((call) => call.operation === "deals_search")
    const body = search?.body as { filterGroups: { filters: { value: string }[] }[] }
    expect(body.filterGroups[0]?.filters[0]?.value).toBe(String(SEEDED + 50 * 60_000))
    expect(changed).toMatchObject({ items: [], hasMore: false })
  })

  it("loses no row that changes while a round of changes pages", async () => {
    const hub = fakeHubspot()
    const source = sourceOver(hub)
    const first = (await source.changes("deal", at(SEEDED))) as CrmPage<CrmItem>
    expect(first.items.map(({ externalId }) => externalId)).toEqual(["301", "302"])
    hub.touch("0-3", "301", { dealname: "Example kitchen, changed" })
    const seen = first.items.map(({ externalId }) => externalId)
    let page = first.nextCursor
    while (page) {
      const next = (await source.changes("deal", at(SEEDED), page)) as CrmPage<CrmItem>
      seen.push(...next.items.map(({ externalId }) => externalId))
      page = next.nextCursor
    }
    expect(new Set(seen)).toEqual(new Set(["301", "302", "303"]))
    expect(hub.refusals).toEqual([])
  })

  it("answers reset once a round of changes at one time passes the service's cap", async () => {
    const deal = MANIFEST.entities.deal as NonNullable<CrmManifest["entities"]["deal"]>
    const changes = deal.changes as NonNullable<typeof deal.changes>
    const capped = {
      ...MANIFEST,
      entities: {
        ...MANIFEST.entities,
        deal: { ...deal, changes: { ...changes, keyset: { field: "properties.pipeline", cap: 2 } } },
      },
    }
    const hub = fakeHubspot()
    const source = crmSourceFromManifest(capped, {
      api,
      call: serviceApiCall({ manifest: api, service: "HubSpot", fetch: hub.fetch, token: () => TOKEN }),
    })
    expect(await source.changes("deal", at(SEEDED))).toEqual({ reset: true })
  })

  it("lets a hook replace a method and keep the rest", async () => {
    const source = crmSourceFromManifest(MANIFEST, {
      api,
      call: serviceApiCall({ manifest: api, service: "HubSpot", fetch: fakeHubspot().fetch, token: () => TOKEN }),
      hooks: {
        extend: (base) => ({ self: () => "7", pipelines: async (kind) => (await base.pipelines(kind)).slice(0, 1) }),
      },
    })
    expect(await source.self?.()).toBe("7")
    expect((await source.pipelines("deal")).map(({ stages }) => stages.map(({ outcome }) => outcome))).toEqual([
      ["open", "won", "lost"],
    ])
  })
})

describe("parseCrmManifest", () => {
  const refused = (manifest: unknown) => {
    try {
      parseCrmManifest(manifest, api)
    } catch (error) {
      if (isCliError(error)) return error.message
      throw error
    }
    throw new Error("the manifest was taken")
  }

  it("names a misspelt operation and the one it likely meant", () => {
    const entity = MANIFEST.entities.person as NonNullable<CrmManifest["entities"]["person"]>
    expect(
      refused({
        ...MANIFEST,
        entities: { ...MANIFEST.entities, person: { ...entity, list: { operation: "contacts_getPag" } } },
      }),
    ).toBe(
      "source manifest: entities.person.list.operation: no operation contacts_getPag in the API; did you mean contacts_getPage?",
    )
  })

  it("names where a rule has the wrong shape", () => {
    const entity = MANIFEST.entities.person as NonNullable<CrmManifest["entities"]["person"]>
    expect(
      refused({
        ...MANIFEST,
        entities: { ...MANIFEST.entities, person: { ...entity, map: { ...entity.map, name: { join: [] } } } },
      }),
    ).toMatch(/^source manifest: entities\.person\.map\.name\.join: /)
  })

  it("names a field the kind does not have", () => {
    const entity = MANIFEST.entities.person as NonNullable<CrmManifest["entities"]["person"]>
    expect(
      refused({
        ...MANIFEST,
        entities: { ...MANIFEST.entities, person: { ...entity, map: { ...entity.map, emials: "x" } } },
      }),
    ).toBe("source manifest: entities.person.map.emials: person has no such field; did you mean emails?")
  })

  it("refuses a change call without {since} and a deal kind without pipelines", () => {
    const entity = MANIFEST.entities.deal as NonNullable<CrmManifest["entities"]["deal"]>
    expect(
      refused({
        ...MANIFEST,
        entities: {
          ...MANIFEST.entities,
          deal: { ...entity, changes: { operation: "deals_search", body: {}, since: "ms" } },
        },
      }),
    ).toBe('source manifest: entities.deal.changes: no "{since}" in its path, query or body')
    expect(refused({ ...MANIFEST, pipelines: {} })).toBe(
      "source manifest: pipelines.deal: deal is in kinds, and every deal or lead stands in a pipeline",
    )
  })
})

describe("path checks, enrich, optional kinds and select.max", () => {
  const deal = MANIFEST.entities.deal as NonNullable<CrmManifest["entities"]["deal"]>
  const withDeal = (changes: Partial<typeof deal>) => ({
    ...MANIFEST,
    entities: { ...MANIFEST.entities, deal: { ...deal, ...changes } },
  })
  const over = (manifest: unknown, hub: FakeHubspot, hooks_ = {}) =>
    crmSourceFromManifest(manifest, {
      api,
      call: serviceApiCall({ manifest: api, service: "HubSpot", fetch: hub.fetch, token: () => TOKEN }),
      hooks: hooks_,
    })
  const recording = () => {
    const gaps: Omit<CrmGap, "reason">[] = []
    const context: CrmCallContext = { spend: () => {}, gap: (gap) => gaps.push(gap) }
    return { gaps, context }
  }

  it("checks every mapped path against what each operation answers", () => {
    expect(crmManifestProblems(MANIFEST, api, definitions)).toEqual([])
    const broken = withDeal({
      map: { ...deal.map, externalId: "idd", people: { each: "associations.contacts.reslts", id: "id" } },
    })
    expect(crmManifestProblems(broken, api, definitions)).toEqual([
      "source manifest: entities.deal.map.externalId: idd is not in what deals_getPage answers; did you mean id?",
      "source manifest: entities.deal.map.people: associations.contacts.reslts is not in what deals_getPage answers; " +
        "did you mean associations.contacts.results?",
      "source manifest: entities.deal.map.externalId: idd is not in what deals_search answers; did you mean id?",
      "source manifest: entities.deal.map.people: associations.contacts.reslts is not in what deals_search answers; " +
        "did you mean associations.contacts.results?",
    ])
  })

  it("enriches a page in one batch before the map: a change read gets the links a search does not answer", async () => {
    const hub = fakeHubspot()
    let batches = 0
    const source = over(MANIFEST, hub, {
      enrich: {
        deal: async (rows: CrmRaw[]) => {
          batches += 1
          return rows.map((raw) => {
            const row = hub.rows["0-3"]?.find((one) => one.id === raw.id)
            const contacts = (row?.associations?.contacts ?? []).map((id) => ({ id, type: "deal_to_contact" }))
            return { ...raw, associations: { contacts: { results: contacts } } }
          })
        },
      },
    })
    const changed = (await all(source, "deal", at(SEEDED))) as CrmItem[]
    expect(changed.find(({ externalId }) => externalId === "301")?.people).toEqual([
      { externalId: "201", role: "contact" },
    ])
    expect(batches).toBe(2)
  })

  it("names an optional kind the service refuses as a gap, and reads it as empty", async () => {
    const hub = fakeHubspot()
    hub.refuse("0-3")
    const source = over(
      withDeal({ optional: { message: "deals need the deals scope", scope: "crm.objects.deals.read" } }),
      hub,
    )
    const { gaps, context } = recording()
    expect(await source.changes("deal", null, undefined, context)).toEqual({ items: [], hasMore: false, cursor: null })
    expect(await source.ids?.("deal", undefined, context)).toEqual({ items: [], hasMore: false })
    // Once per call context, however many reads were refused.
    expect(gaps).toEqual([{ kind: "deal", message: "deals need the deals scope", scope: "crm.objects.deals.read" }])
    await expect(source.ids?.("deal", "2")).rejects.toMatchObject({ code: "permission_error" })
    await expect(over(MANIFEST, hub).changes("deal", null)).rejects.toMatchObject({ code: "permission_error" })
  })

  it("always asks for the mapped fields, then the account's own that fit select.max, and names the rest once", async () => {
    const hub = fakeHubspot()
    const select = deal.select as NonNullable<typeof deal.select>
    const source = over(withDeal({ select: { ...select, max: 40 } }), hub)
    const { gaps, context } = recording()
    await source.changes("deal", null, undefined, context)
    await source.changes("deal", null, "2@1", context)
    const asked = hub.calls.find((call) => call.operation === "deals_getPage")?.query.properties as string[]
    expect(asked).toContain("hs_lastmodifieddate")
    expect(asked).not.toContain("kitchen_size")
    expect(gaps).toEqual([
      { kind: "deal", message: "1 of the account's own deal fields do not fit one request and were not read" },
    ])
  })
})

describe("crmManifestProblems over schema shapes", () => {
  const shapes: Record<string, SchemaNode> = {
    Answer: obj({ results: list(ref("Row")) }),
    Row: {
      type: "allOf",
      of: [
        obj({ id: str, open: { type: "object", properties: {}, required: [] } }),
        obj({
          either: { type: "union", of: [obj({ x: str }), obj({ x: obj({ y: str }) })] },
          stages: list(obj({ id: str, label: str })),
          links: list(obj({ target: str })),
        }),
      ],
    },
  }
  const shaped: ServiceApiManifest = {
    operations: [
      op("rows", "GET", "/rows", {
        response: { confidence: "contract", schema: "Answer" },
        pagination: { style: "offset", offset: { in: "query", name: "offset" }, items: "results" },
      }),
    ],
  }
  const manifestOf = (person: Record<string, unknown>, stages: Record<string, unknown> = {}): CrmManifest =>
    ({
      provider: "shapes",
      kinds: ["person", "deal"],
      entities: {
        person: { list: { operation: "rows" }, map: { externalId: "id", ...person } },
        deal: { list: { operation: "rows" }, map: { externalId: "id" } },
      },
      pipelines: {
        deal: {
          call: { operation: "rows" },
          map: { externalId: "id", name: "id" },
          stages: { each: "stages", map: { externalId: "id", name: "label", ...stages }, outcome: { value: "open" } },
        },
      },
    }) as CrmManifest

  it("passes a ref, allOf, an open object, every branch of a union, and an each's inner field", () => {
    expect(
      crmManifestProblems(
        manifestOf({
          name: "open.anything.deep",
          firstName: "either.x.y",
          organizations: { each: "links", id: "target" },
        }),
        shaped,
        shapes,
      ),
    ).toEqual([])
  })

  it("names a wrong inner field, a wrong stage field in any rule, and a wrong items path", () => {
    expect(
      crmManifestProblems(
        manifestOf({ organizations: { each: "links", id: "targte" } }, { name: { first: ["lable"] } }),
        shaped,
        shapes,
      ),
    ).toEqual([
      "source manifest: entities.person.map.organizations: targte is not in what rows answers; did you mean target?",
      "source manifest: pipelines.deal.stages.map.name: lable is not in what rows answers; did you mean label?",
    ])
    const misplaced = manifestOf({})
    const person = misplaced.entities.person as NonNullable<CrmManifest["entities"]["person"]>
    expect(
      crmManifestProblems(
        {
          ...misplaced,
          entities: { ...misplaced.entities, person: { ...person, list: { operation: "rows", items: "rsults" } } },
        },
        shaped,
        shapes,
      ),
    ).toEqual(["source manifest: entities.person.map.items: rsults is not in what rows answers; did you mean results?"])
  })
})
