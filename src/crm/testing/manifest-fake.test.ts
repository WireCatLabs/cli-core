import type { ManifestOperation, SchemaNode } from "@wirecat/cli-base/codegen"
import { describe, expect, it } from "vitest"
import type { ServiceApiManifest } from "../../cli/service-api-manifest.js"
import type { CrmOrganization, CrmPerson } from "../../domain/crm.js"
import type { CrmManifest } from "../manifest/manifest.js"
import type { CrmPage } from "../source.js"
import { type CrmManifestFake, crmManifestFixture } from "./manifest-fake.js"
import { crmSourceContract } from "./source-contract.js"

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

describe("crmSourceContract over an Attio-like manifest and the fake built from it", () => {
  const fakes: CrmManifestFake[] = []
  for (const { name, run } of crmSourceContract(() => {
    const fixture = crmManifestFixture(SOURCE, { api, definitions })
    fakes.push(fixture.fake)
    return fixture
  }))
    it(name, async () => {
      await run()
      for (const fake of fakes.splice(0)) expect(fake.refusals).toEqual([])
    })
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
