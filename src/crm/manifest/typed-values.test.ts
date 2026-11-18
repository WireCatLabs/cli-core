import { isCliError } from "@wirecat/cli-base"
import type { ManifestOperation, SchemaNode } from "@wirecat/cli-base/codegen"
import { describe, expect, it } from "vitest"
import type { ServiceApiManifest } from "../../cli/service-api-manifest.js"
import { crmManifestContract } from "../testing/manifest-fake.js"
import type { CrmRaw } from "../values.js"
import { type CrmManifest, type CrmManifestHooks, parseCrmManifest } from "./manifest.js"
import { crmManifestProblems } from "./paths.js"
import { crmSourceFromManifest } from "./source.js"

// A trimmed copy of Attio's API: records whose attributes are lists of typed entries with their history, a deal
// pipeline answered as a flat list of stages, attribute definitions, and a records query that pages by offset in
// its body and filters by a name.

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
  Entry: obj({
    attribute_type: str,
    active_until: { ...str, nullable: true },
    value: str,
    full_name: str,
    email_address: str,
    target_record_id: str,
    currency_value: { type: "number" },
    currency_code: str,
    status: obj({ id: obj({ status_id: str }), title: str }),
    option: obj({ title: str }),
  }),
  Row: obj(
    {
      id: obj({ record_id: str }, ["record_id"]),
      created_at: str,
      values: { type: "object", properties: {}, required: [], additionalProperties: list(ref("Entry")) },
    },
    ["id", "values"],
  ),
  Records: obj({ data: list(ref("Row")) }, ["data"]),
  One: obj({ data: ref("Row") }, ["data"]),
  Query: obj({
    filter: { type: "object", properties: {}, required: [], additionalProperties: { type: "unknown" } },
    limit: int,
    offset: int,
  }),
  Statuses: obj(
    { data: list(obj({ id: obj({ status_id: str }), title: str, celebration_enabled: bool, is_archived: bool })) },
    ["data"],
  ),
  Attributes: obj(
    { data: list(obj({ api_slug: str, title: str, type: str, is_system_attribute: bool, is_multiselect: bool })) },
    ["data"],
  ),
}

const path = (name: string) => ({ name, in: "path", required: true, schema: str }) as const

const op = (id: string, method: "GET" | "POST", url: string, extra: Partial<ManifestOperation>): ManifestOperation => ({
  id,
  command: id,
  binding: { kind: "http", method, path: url },
  effect: "read",
  tags: [],
  parameters: [],
  ...extra,
})

const api: ServiceApiManifest = {
  operations: [
    op("query", "POST", "/v2/objects/{object}/records/query", {
      parameters: [path("object")],
      request: { required: false, confidence: "contract", schema: "Query" },
      response: { confidence: "contract", schema: "Records" },
      pagination: {
        style: "offset",
        offset: { in: "body", name: "offset" },
        limit: { in: "body", name: "limit" },
        items: "data",
      },
    }),
    op("scroll", "POST", "/v2/objects/{object}/records/scroll", {
      parameters: [path("object")],
      request: { required: false, confidence: "contract", schema: "Query" },
      response: { confidence: "contract", schema: "Records" },
      pagination: { style: "cursor", cursor: { in: "body", name: "after" }, next: "next", items: "data" },
    }),
    op("get", "GET", "/v2/objects/{object}/records/{record_id}", {
      parameters: [path("object"), path("record_id")],
      response: { confidence: "contract", schema: "One" },
    }),
    op("statuses", "GET", "/v2/objects/{object}/attributes/{attribute}/statuses", {
      parameters: [path("object"), path("attribute")],
      response: { confidence: "contract", schema: "Statuses" },
    }),
    op("attributes", "GET", "/v2/objects/{object}/attributes", {
      parameters: [path("object")],
      response: { confidence: "contract", schema: "Attributes" },
    }),
  ],
  servers: [{ url: "https://api.attio.test" }],
  securitySchemes: { token: { type: "http", scheme: "bearer" } },
  security: [{ token: [] }],
}

const records = (object: string, filter: unknown) => ({
  list: { operation: "query", path: { object }, body: { limit: 2 }, items: "data" },
  search: { operation: "query", path: { object }, body: { limit: 2, filter }, items: "data" },
  get: { operation: "get", path: { object, record_id: "{id}" }, items: "data" },
  custom: { from: "values", typed: { by: "attribute_type", current: "active_until" } },
})

const attributes = (object: string) => ({
  call: { operation: "attributes", path: { object }, items: "data" },
  map: { code: "api_slug", label: "title", type: "type", multiple: "is_multiselect" },
  keep: { path: "is_system_attribute", is: false },
})

const MANIFEST: CrmManifest = {
  provider: "attio",
  kinds: ["organization", "person", "deal"],
  entities: {
    organization: {
      ...records("companies", { name: { $contains: "{query}" } }),
      map: { externalId: "id.record_id", name: "values.name.0.value", createdAt: "created_at" },
    },
    person: {
      ...records("people", { name: { full_name: { $contains: "{query}" } } }),
      map: {
        externalId: "id.record_id",
        name: "values.name.0.full_name",
        emails: { each: "values.email_addresses", value: "email_address" },
        createdAt: "created_at",
      },
    },
    deal: {
      list: { operation: "query", path: { object: "deals" }, body: { limit: 2 }, items: "data" },
      custom: { from: "values", typed: { by: "attribute_type", current: "active_until" } },
      map: {
        externalId: "id.record_id",
        title: "values.name.0.value",
        pipeline: { value: "deals" },
        stage: "values.stage.0.status.id.status_id",
        amount: "values.value.0.currency_value",
        currency: "values.value.0.currency_code",
        createdAt: "created_at",
      },
    },
  },
  pipelines: {
    deal: {
      call: { operation: "statuses", path: { object: "deals", attribute: "stage" }, items: "data" },
      map: { externalId: { value: "deals" }, name: { value: "Deals" } },
      stages: {
        each: ".",
        map: { externalId: "id.status_id", name: "title" },
        outcome: { path: "celebration_enabled", won: ["true"] },
      },
    },
  },
  fields: { organization: attributes("companies"), person: attributes("people"), deal: attributes("deals") },
}

const hooks: CrmManifestHooks = {
  pipelines: { deal: { outcome: (stage, _, found) => (stage.title === "Lost" ? "lost" : found) } },
}

describe("crmManifestContract over Attio's shapes", () => {
  for (const { name, run } of crmManifestContract(MANIFEST, { api, definitions, hooks })) it(name, run)
})

const deal = MANIFEST.entities.deal as NonNullable<CrmManifest["entities"]["deal"]>
const LINKED: CrmManifest = {
  ...MANIFEST,
  entities: {
    organization: {
      ...(MANIFEST.entities.organization as object),
      linked: true,
    } as CrmManifest["entities"]["organization"],
    person: { ...(MANIFEST.entities.person as object), linked: true } as CrmManifest["entities"]["person"],
    deal: {
      ...deal,
      map: {
        ...deal.map,
        organization: "values.associated_company.0.target_record_id",
        people: { each: "values.associated_people", id: "target_record_id" },
      },
    },
  },
}

describe("crmManifestContract over Attio's shapes, contacts and companies copied as a deal names them", () => {
  for (const { name, run } of crmManifestContract(LINKED, { api, definitions, hooks })) it(name, run)
})

const current = { active_until: null }
const replaced = { active_until: "2026-01-01T00:00:00Z" }

/** A source over a stub that answers each operation from `answers` and records what was asked. */
const stubbed = (answers: Record<string, (body: CrmRaw) => unknown>, manifest: CrmManifest = MANIFEST) => {
  const asked: { operation: string; body: CrmRaw }[] = []
  const source = crmSourceFromManifest(manifest, {
    api,
    hooks,
    call: async (operation, request) => {
      const body = (request.body ? JSON.parse(request.body) : {}) as CrmRaw
      asked.push({ operation, body })
      const answer = answers[operation]
      if (!answer) throw new Error(`no answer for ${operation}`)
      return answer(body)
    },
  })
  return { source, asked }
}

describe("Attio's shapes", () => {
  it("passes the path checks: stages read from each row, a search read like the list", () => {
    expect(crmManifestProblems(MANIFEST, api, definitions)).toEqual([])
  })

  it("reads one pipeline from a flat list of stages, won by a flag and lost by the hook", async () => {
    const { source } = stubbed({
      statuses: () => ({
        data: [
          { id: { status_id: "s1" }, title: "Lead", celebration_enabled: false },
          { id: { status_id: "s2" }, title: "Won", celebration_enabled: true },
          { id: { status_id: "s3" }, title: "Lost", celebration_enabled: false },
        ],
      }),
    })
    expect(await source.pipelines("deal")).toEqual([
      {
        externalId: "deals",
        name: "Deals",
        stages: [
          { externalId: "s1", name: "Lead", position: 0, outcome: "open" },
          { externalId: "s2", name: "Won", position: 1, outcome: "won" },
          { externalId: "s3", name: "Lost", position: 2, outcome: "lost" },
        ],
      },
    ])
  })

  it("groups a flat list of stages by the pipeline each names", async () => {
    const manifest: CrmManifest = {
      ...MANIFEST,
      pipelines: {
        deal: {
          call: { operation: "statuses", path: { object: "deals", attribute: "stage" }, items: "data" },
          map: { externalId: "pipeline", name: "pipeline" },
          stages: {
            each: ".",
            pipeline: "pipeline",
            map: { externalId: "id", name: "title" },
            outcome: { value: "open" },
          },
        },
      },
    }
    const { source } = stubbed(
      {
        statuses: () => ({
          data: [
            { id: "a1", title: "New", pipeline: "A" },
            { id: "b1", title: "New", pipeline: "B" },
            { id: "a2", title: "Talks", pipeline: "A" },
          ],
        }),
      },
      manifest,
    )
    const found = await source.pipelines("deal")
    expect(found.map(({ externalId, stages }) => [externalId, stages.map((one) => one.externalId)])).toEqual([
      ["A", ["a1", "a2"]],
      ["B", ["b1"]],
    ])
  })

  it("keeps the current entries of each own attribute, a list for a multi-select or several, and skips built-in ones", async () => {
    const deal = {
      id: { record_id: "d1" },
      values: {
        name: [{ ...current, attribute_type: "text", value: "Kitchen" }],
        priority: [
          { ...replaced, attribute_type: "select", option: { title: "Low" } },
          { ...current, attribute_type: "select", option: { title: "High" } },
        ],
        tags: [
          { ...current, attribute_type: "select", option: { title: "A" } },
          { ...replaced, attribute_type: "select", option: { title: "B" } },
        ],
        regions: [
          { ...current, attribute_type: "select", option: { title: "EU" } },
          { ...current, attribute_type: "select", option: { title: "US" } },
        ],
        budget: [{ ...current, attribute_type: "currency", currency_value: 900 }],
      },
    }
    const { source } = stubbed({
      attributes: () => ({
        data: [
          { api_slug: "name", title: "Name", type: "text", is_system_attribute: true },
          { api_slug: "priority", title: "Priority", type: "select", is_system_attribute: false },
          { api_slug: "tags", title: "Tags", type: "select", is_system_attribute: false, is_multiselect: true },
          { api_slug: "regions", title: "Regions", type: "select", is_system_attribute: false },
          { api_slug: "budget", title: "Budget", type: "currency", is_system_attribute: false },
        ],
      }),
      query: () => ({ data: [deal] }),
    })
    const page = await source.changes("deal", null)
    const [item] = "items" in page ? page.items : []
    expect(item?.metadata).toEqual({
      priority: { label: "Priority", value: "High" },
      tags: { label: "Tags", value: ["A"] },
      regions: { label: "Regions", value: ["EU", "US"] },
      budget: { label: "Budget", value: 900 },
    })
  })

  it("lists people live: words through search, none through the list, and refuses a filter it cannot send", async () => {
    const ann = { id: { record_id: "p1" }, values: { name: [{ ...current, full_name: "Ann Lee" }] } }
    const { source, asked } = stubbed({
      attributes: () => ({ data: [] }),
      query: (body) => ({ data: body.offset ? [] : [ann] }),
    })
    const found = await source.list?.("person", { conditions: [], text: "ann", limit: 1 })
    expect(found?.items.map(({ name }) => name)).toEqual(["Ann Lee"])
    await source.list?.("person", { conditions: [], limit: 5, page: 2 })
    expect(asked.filter(({ operation }) => operation === "query").map(({ body }) => body)).toEqual([
      { limit: 2, filter: { name: { full_name: { $contains: "ann" } } }, offset: 0 },
      { limit: 1, filter: { name: { full_name: { $contains: "ann" } } }, offset: 1 },
      { limit: 6, offset: 5 },
    ])
    const refused = await source
      .list?.("person", { conditions: [{ field: "created_at", op: ">", value: 1 }], limit: 1 })
      .catch((error: unknown) => error)
    expect(isCliError(refused) && refused.code).toBe("validation_error")
  })

  it("refuses a search without {query}, one on a deal, one that pages by cursor, and a stage group without a flat list", () => {
    const person = MANIFEST.entities.person as NonNullable<CrmManifest["entities"]["person"]>
    const refused = (manifest: unknown) => {
      try {
        parseCrmManifest(manifest, api)
        return ""
      } catch (error) {
        return error instanceof Error ? error.message : String(error)
      }
    }
    expect(
      refused({
        ...MANIFEST,
        entities: { ...MANIFEST.entities, person: { ...person, search: { ...person.search, body: { limit: 2 } } } },
      }),
    ).toContain('entities.person.search: no "{query}"')
    const deal = MANIFEST.entities.deal as NonNullable<CrmManifest["entities"]["deal"]>
    expect(
      refused({ ...MANIFEST, entities: { ...MANIFEST.entities, deal: { ...deal, search: person.search } } }),
    ).toContain("only contacts and companies are read live")
    const pipeline = MANIFEST.pipelines?.deal as NonNullable<NonNullable<CrmManifest["pipelines"]>["deal"]>
    expect(
      refused({
        ...MANIFEST,
        pipelines: { deal: { ...pipeline, stages: { ...pipeline.stages, each: "data", pipeline: "pipeline" } } },
      }),
    ).toContain("groups stages only when the call answers them")
    expect(
      refused({
        ...MANIFEST,
        entities: {
          ...MANIFEST.entities,
          person: { ...person, search: { ...person.search, operation: "scroll" } },
        },
      }),
    ).toContain("a live list pages by offset or not at all, not by cursor")
  })

  it("hands extend the service call, so a hook can read what the manifest does not", async () => {
    const manifest = parseCrmManifest(MANIFEST, api)
    const source = crmSourceFromManifest(manifest, {
      api,
      call: async (operation) => ({ operation }),
      hooks: {
        extend: (_, { call }) => ({
          self: async () =>
            ((await call("get", { path: {}, query: {}, headers: {}, fields: {} })) as CrmRaw).operation as string,
        }),
      },
    })
    expect(await source.self?.()).toBe("get")
  })
})
