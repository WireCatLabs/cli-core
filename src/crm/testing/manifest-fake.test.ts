import type { ManifestOperation, SchemaNode } from "@wirecat/cli-base/codegen"
import { describe, expect, it } from "vitest"
import type { ServiceApiManifest } from "../../cli/service-api-manifest.js"
import type { CrmOrganization, CrmPerson } from "../../domain/crm.js"
import type { CrmManifest } from "../manifest/manifest.js"
import type { CrmPage, CrmSource } from "../source.js"
import { crmManifestContract, crmManifestFixture } from "./manifest-fake.js"

// An Attio-like API, synthetic: records read by a POST query that pages by limit and offset in the body, rows under
// `data`, the id an object, and every value a list of dated entries.

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
  Value: obj(
    {
      active_from: str,
      attribute_type: str,
      value: str,
      full_name: str,
      first_name: str,
      last_name: str,
      email_address: str,
      referenced_actor_id: str,
    },
    ["active_from", "attribute_type"],
  ),
  Entry: obj(
    {
      id: obj({ workspace_id: str, object_id: str, record_id: str }, ["workspace_id", "object_id", "record_id"]),
      created_at: str,
      values: { type: "object", properties: {}, required: [], additionalProperties: list(ref("Value")) },
    },
    ["id", "created_at", "values"],
  ),
  Query: obj({
    filter: { type: "unknown" },
    sorts: list(obj({ attribute: str, direction: str })),
    limit: int,
    offset: int,
  }),
  Records: obj({ data: list(ref("Entry")) }, ["data"]),
  OneRecord: obj({ data: ref("Entry") }, ["data"]),
  Attributes: obj({ data: list(obj({ api_slug: str, title: str, type: str, is_multiselect: bool }, ["api_slug"])) }, [
    "data",
  ]),
  Members: obj(
    {
      data: list(
        obj({ id: obj({ workspace_member_id: str }, ["workspace_member_id"]), first_name: str, email_address: str }),
      ),
    },
    ["data"],
  ),
}

const object = { name: "object", in: "path", required: true, schema: str } as const
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
  parameters: [object],
  ...extra,
})

const api: ServiceApiManifest = {
  operations: [
    op("records_query", "POST", "/v2/objects/{object}/records/query", {
      request: { required: false, confidence: "contract", schema: "Query" },
      response: { confidence: "contract", schema: "Records" },
      pagination: {
        style: "offset",
        offset: { in: "body", name: "offset" },
        limit: { in: "body", name: "limit" },
        items: "data",
      },
    }),
    op("records_get", "GET", "/v2/objects/{object}/records/{record_id}", {
      parameters: [object, { name: "record_id", in: "path", required: true, schema: str }],
      response: { confidence: "contract", schema: "OneRecord" },
    }),
    op("attributes_list", "GET", "/v2/objects/{object}/attributes", {
      response: { confidence: "contract", schema: "Attributes" },
    }),
    op("members_list", "GET", "/v2/workspace_members", {
      parameters: [],
      response: { confidence: "contract", schema: "Members" },
    }),
  ],
  servers: [{ url: "https://api.attio.test" }],
  securitySchemes: { token: { type: "http", scheme: "bearer" } },
  security: [{ token: [] }],
}

const records = (name: string) => ({
  list: { operation: "records_query", path: { object: name }, body: { limit: 2 } },
  changes: {
    operation: "records_query",
    path: { object: name },
    body: {
      limit: 2,
      filter: { updated_at: { $gte: "{since}" } },
      sorts: [{ attribute: "updated_at", direction: "asc" }],
    },
    since: "iso" as const,
  },
  get: { operation: "records_get", path: { object: name, record_id: "{id}" }, items: "data" },
})

const attributes = (name: string) => ({
  call: { operation: "attributes_list", path: { object: name }, items: "data" },
  map: { code: "api_slug", label: "title", type: "type", multiple: "is_multiselect" },
})

const SOURCE: CrmManifest = {
  provider: "attio",
  kinds: ["organization", "person"],
  entities: {
    organization: {
      ...records("companies"),
      map: {
        externalId: "id.record_id",
        name: "values.name.0.value",
        assignee: "values.owner.0.referenced_actor_id",
        createdAt: "created_at",
        updatedAt: "values.updated_at.0.value",
      },
    },
    person: {
      ...records("people"),
      map: {
        externalId: "id.record_id",
        name: "values.name.0.full_name",
        firstName: "values.name.0.first_name",
        lastName: "values.name.0.last_name",
        emails: { each: "values.email_addresses", value: "email_address" },
        createdAt: "created_at",
        updatedAt: "values.updated_at.0.value",
      },
    },
  },
  fields: { organization: attributes("companies"), person: attributes("people") },
  users: {
    call: { operation: "members_list", items: "data" },
    map: { externalId: "id.workspace_member_id", name: "first_name", email: "email_address" },
  },
}

describe("crmManifestContract over an Attio-like manifest", () => {
  for (const { name, run } of crmManifestContract(SOURCE, { api, definitions })) it(name, run)
})

describe("crmManifestFake", () => {
  it("pages by the offset in the body and writes each mapped value where the map reads it", async () => {
    const { source, fake } = crmManifestFixture(SOURCE, { api, definitions })
    const people: CrmPerson[] = []
    let page: string | undefined
    do {
      const answer = (await source.changes("person", null, page)) as CrmPage<CrmPerson>
      people.push(...answer.items)
      page = answer.nextCursor
    } while (page)
    expect(people.map(({ externalId, name }) => [externalId, name])).toEqual([
      ["2001", "name 1"],
      ["2002", "name 2"],
      ["2003", "name 3"],
    ])
    expect(fake.calls.map((call) => (call.body as { offset?: number }).offset)).toEqual([undefined, 2, 3])
    expect(fake.refusals).toEqual([])
  })

  it("lists in changes only the rows changed since, oldest first, a touched one last", async () => {
    const { source, fake } = crmManifestFixture(SOURCE, { api, definitions })
    const since = new Date(Date.now() - 60_000).toISOString()
    expect(await source.changes("organization", since)).toMatchObject({ items: [], hasMore: false })
    fake.touch("organization", "1001")
    const ids = async (cursor: string) =>
      ((await source.changes("organization", cursor)) as CrmPage<CrmOrganization>).items.map(
        ({ externalId }) => externalId,
      )
    expect(await ids(since)).toEqual(["1001"])
    expect(await ids(new Date(0).toISOString())).toEqual(["1002", "1003"])
    expect(fake.refusals).toEqual([])
  })

  it("reads a row by id inside the answer's data, and an id it does not hold as none", async () => {
    const { source, fake } = crmManifestFixture(SOURCE, { api, definitions })
    expect(await source.get?.("person", "2001")).toMatchObject({ externalId: "2001", name: "name 1" })
    expect(await source.get?.("person", "contract-missing-0")).toBeNull()
    expect(fake.refusals).toEqual([])
  })

  it("records a call the manifest never makes as a refusal", async () => {
    const { fake } = crmManifestFixture(SOURCE, { api, definitions })
    const answer = await fake.fetch("https://api.attio.test/v2/objects/deals/attributes", {
      headers: { authorization: "Bearer fake-manifest-token" },
    })
    expect(answer.status).toBe(404)
    expect(fake.refusals).toEqual(["attributes_list: no call of the source manifest is this one"])
  })
})

// Each a broken source the contract once passed: the case must now fail.
describe("crmManifestContract catches a broken source", () => {
  const failing = (prefix: string, extend: (base: CrmSource) => Partial<CrmSource>) => {
    const found = crmManifestContract(SOURCE, { api, definitions, hooks: { extend } }).find(({ name }) =>
      name.startsWith(prefix),
    )
    if (!found) throw new Error(`no case ${prefix}`)
    return found.run()
  }

  it("a get that reads a wrong id fails the denied cases", async () => {
    const wrong = (base: CrmSource) => ({
      get: ((kind, id, context) => base.get?.(kind, `9${id}`, context)) as CrmSource["get"],
    })
    await expect(failing("faults: a contact or company that answers 403", wrong)).rejects.toThrow(/did not read/)
  })

  it("a change time the fake cannot write refuses to build, rather than list every row as changed", () => {
    const organization = SOURCE.entities.organization as NonNullable<CrmManifest["entities"]["organization"]>
    const broken: CrmManifest = {
      ...SOURCE,
      entities: {
        ...SOURCE.entities,
        organization: { ...organization, map: { ...organization.map, updatedAt: () => 0 } },
      },
    }
    expect(() => crmManifestFixture(broken, { api, definitions })).toThrow(/cannot write a change time organization/)
  })

  it("a list that stops after its first page fails the held rows case", async () => {
    const cut = (base: CrmSource) => ({
      changes: (async (kind, cursor, page, context) => {
        const answer = await base.changes(kind, cursor, page, context)
        return "reset" in answer || !answer.hasMore
          ? answer
          : { items: answer.items, hasMore: false, cursor: new Date().toISOString() }
      }) as CrmSource["changes"],
    })
    await expect(failing("changes: a full list gives every row the fixture holds", cut)).rejects.toThrow(/listed/)
  })

  it("a read of changes that ignores its cursor fails the change case", async () => {
    const full = (base: CrmSource) => ({
      changes: ((kind, _cursor, page, context) => base.changes(kind, null, page, context)) as CrmSource["changes"],
    })
    await expect(failing("faults: a clock off by ten minutes", full)).rejects.toThrow(/did not change/)
  })

  it("refuses a read of changes sent without its since", async () => {
    const { fake } = crmManifestFixture(SOURCE, { api, definitions })
    const answer = await fake.fetch("https://api.attio.test/v2/objects/people/records/query", {
      method: "POST",
      headers: { authorization: "Bearer fake-manifest-token", "content-type": "application/json" },
      body: JSON.stringify({
        limit: 2,
        filter: { updated_at: {} },
        sorts: [{ attribute: "updated_at", direction: "asc" }],
      }),
    })
    expect(answer.status).toBe(400)
    expect(fake.refusals).toEqual(["records_query: a read of changes without its since"])
  })
})

// Attio's real value schema: a oneOf of typed values, each with its own fields and an enum attribute_type, so a value
// sampled from the first branch with another branch's field written in matches none of them.
describe("crmManifestFake over values that are one of several types", () => {
  const typedValue = (type: string, fields: Record<string, SchemaNode>) =>
    obj({ active_from: str, attribute_type: { type: "string", enum: [type] }, ...fields }, [
      "active_from",
      "attribute_type",
      ...Object.keys(fields),
    ])
  const typed: Record<string, SchemaNode> = {
    ...definitions,
    Value: {
      type: "union",
      of: [
        typedValue("actor-reference", { referenced_actor_id: str }),
        typedValue("text", { value: str }),
        typedValue("personal-name", { full_name: str, first_name: str, last_name: str }),
        typedValue("email-address", { email_address: str }),
      ],
    },
  }

  it("writes each mapped value into the branch that has it, and the strict fake takes its own answer", async () => {
    const { source, fake } = crmManifestFixture(SOURCE, { api, definitions: typed })
    const people = (await source.changes("person", null)) as CrmPage<CrmPerson>
    expect(people.items.map(({ name, lastName }) => [name, lastName])).toEqual([
      ["name 1", "lastName 1"],
      ["name 2", "lastName 2"],
    ])
    const raw = fake.rows.person?.[0] as { values: Record<string, { attribute_type: string }[]> }
    expect(raw.values.name?.[0]?.attribute_type).toBe("personal-name")
    expect(fake.refusals).toEqual([])
  })

  for (const { name, run } of crmManifestContract(SOURCE, { api, definitions: typed })) it(name, run)
})
