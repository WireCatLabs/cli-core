import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ManifestOperation, SchemaNode } from "@wirecat/cli-base/codegen"
import { Command } from "commander"
import { afterEach, describe, expect, it } from "vitest"
import { provide } from "../../cli/context.js"
import { serviceApiCall } from "../../cli/service-api-call.js"
import type { ServiceApiManifest } from "../../cli/service-api-manifest.js"
import { CRM_OPENS } from "../../domain/providers.js"
import type { AppIdentity } from "../../ports/app.js"
import { SendJournal, sendsPathFor } from "../../sends/journal.js"
import type { Level } from "../../sends/permissions.js"
import { type MessageStore, openStore } from "../../store/store.js"
import { addCrmCommands } from "../cli/index.js"
import {
  crmManifestFake,
  crmManifestWriteContract,
  crmManifestWriteFixture,
  FAKE_MANIFEST_TOKEN,
} from "../testing/manifest-fake.js"
import { type CrmManifest, type CrmManifestHooks, parseCrmManifest } from "./manifest.js"
import { type CrmManifestSource, crmSourceFromManifest } from "./source.js"
import {
  crmManifestWriteCapabilities,
  crmManifestWriteKeys,
  crmManifestWrites,
  crmWriterFromManifest,
} from "./writer.js"

// A trimmed copy of Attio's API with its record writes: a create and a replace whose values sit under
// `data.values`, each attribute a list of entries, and a delete. The currency is the attribute's, read from it.

const str: SchemaNode = { type: "string" }
const num: SchemaNode = { type: "number" }
const bool: SchemaNode = { type: "boolean" }
const obj = (properties: Record<string, SchemaNode>, required: string[] = []): SchemaNode => ({
  type: "object",
  properties,
  required,
})
const open = (values: SchemaNode): SchemaNode => ({
  type: "object",
  properties: {},
  required: [],
  additionalProperties: values,
})
const list = (items: SchemaNode): SchemaNode => ({ type: "array", items })
const ref = (name: string): SchemaNode => ({ type: "ref", ref: name })

const definitions: Record<string, SchemaNode> = {
  Entry: obj({
    attribute_type: str,
    active_until: { ...str, nullable: true },
    value: str,
    full_name: str,
    first_name: str,
    last_name: str,
    email_address: str,
    phone_number: str,
    target_record_id: str,
    referenced_actor_id: str,
    currency_value: num,
    currency_code: str,
    status: obj({ id: obj({ status_id: str }), title: str }),
  }),
  Row: obj({ id: obj({ record_id: str }, ["record_id"]), created_at: str, values: open(list(ref("Entry"))) }, [
    "id",
    "values",
  ]),
  Records: obj({ data: list(ref("Row")) }, ["data"]),
  One: obj({ data: ref("Row") }, ["data"]),
  Query: obj({ filter: open({ type: "unknown" }), limit: { type: "integer" }, offset: { type: "integer" } }),
  Write: obj({ data: obj({ values: open(list({ type: "unknown" })) }, ["values"]) }, ["data"]),
  Empty: obj({}),
  Statuses: obj({ data: list(obj({ id: obj({ status_id: str }), title: str, celebration_enabled: bool })) }, ["data"]),
  Attribute: obj({ data: obj({ config: obj({ currency: obj({ default_currency_code: str }) }) }) }, ["data"]),
  Attributes: obj({ data: list(obj({ api_slug: str, title: str, type: str, is_system_attribute: bool })) }, ["data"]),
}

const path = (name: string) => ({ name, in: "path", required: true, schema: str }) as const

const op = (
  id: string,
  method: "GET" | "POST" | "PUT" | "DELETE",
  url: string,
  extra: Partial<ManifestOperation>,
): ManifestOperation => ({
  id,
  command: id,
  binding: { kind: "http", method, path: url },
  effect: method === "GET" ? "read" : method === "DELETE" ? "destructive" : "write",
  tags: [],
  parameters: [],
  ...extra,
})

const RECORDS = "/v2/objects/{object}/records"
const ONE = `${RECORDS}/{record_id}`
const written = { request: { required: true, confidence: "contract", schema: "Write" } } as const
const answered = (schema: string) => ({ response: { confidence: "contract", schema } }) as const

const api: ServiceApiManifest = {
  operations: [
    op("query", "POST", `${RECORDS}/query`, {
      effect: "read",
      parameters: [path("object")],
      request: { required: false, confidence: "contract", schema: "Query" },
      ...answered("Records"),
      pagination: {
        style: "offset",
        offset: { in: "body", name: "offset" },
        limit: { in: "body", name: "limit" },
        items: "data",
      },
    }),
    op("get", "GET", ONE, { parameters: [path("object"), path("record_id")], ...answered("One") }),
    op("create", "POST", RECORDS, { parameters: [path("object")], ...written, ...answered("One") }),
    op("replace", "PUT", ONE, { parameters: [path("object"), path("record_id")], ...written, ...answered("One") }),
    op("delete", "DELETE", ONE, {
      parameters: [path("object"), path("record_id")],
      ...answered("Empty"),
      permissions: [{ key: "records.delete" }],
    }),
    op("statuses", "GET", "/v2/objects/{object}/attributes/{attribute}/statuses", {
      parameters: [path("object"), path("attribute")],
      ...answered("Statuses"),
    }),
    op("attributes", "GET", "/v2/objects/{object}/attributes", {
      parameters: [path("object")],
      ...answered("Attributes"),
    }),
    op("attribute", "GET", "/v2/objects/{object}/attributes/{attribute}", {
      parameters: [path("object"), path("attribute")],
      ...answered("Attribute"),
    }),
  ],
  servers: [{ url: "https://api.attio.test" }],
  securitySchemes: { token: { type: "http", scheme: "bearer" } },
  security: [{ token: [] }],
}

const records = (object: string) => ({
  list: { operation: "query", path: { object }, body: { limit: 2 }, items: "data" },
  get: { operation: "get", path: { object, record_id: "{id}" }, items: "data" },
})

const VALUES = { data: { values: "{values}" } }
const writesOf = (object: string) => ({
  create: { operation: "create", path: { object }, body: VALUES },
  update: { operation: "replace", path: { object, record_id: "{id}" }, body: VALUES },
  id: "data.id.record_id",
  clear: [],
  custom: { list: true as const },
})
const reference = (object: string) => ({ target_object: object, target_record_id: "{value}" })

const ATTIO: CrmManifest = {
  provider: "attio",
  kinds: ["organization", "person", "deal"],
  entities: {
    organization: {
      ...records("companies"),
      map: { externalId: "id.record_id", name: "values.name.0.value", createdAt: "created_at" },
    },
    person: {
      ...records("people"),
      map: {
        externalId: "id.record_id",
        name: "values.name.0.full_name",
        firstName: "values.name.0.first_name",
        lastName: "values.name.0.last_name",
        emails: { each: "values.email_addresses", value: "email_address" },
        phones: { each: "values.phone_numbers", value: "phone_number" },
        position: "values.job_title.0.value",
        createdAt: "created_at",
      },
    },
    deal: {
      ...records("deals"),
      map: {
        externalId: "id.record_id",
        title: "values.name.0.value",
        pipeline: { value: "deals" },
        stage: "values.stage.0.status.id.status_id",
        organization: "values.associated_company.0.target_record_id",
        people: { each: "values.associated_people", id: "target_record_id" },
        assignee: "values.owner.0.referenced_actor_id",
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
  fields: {
    deal: {
      call: { operation: "attributes", path: { object: "deals" }, items: "data" },
      map: { code: "api_slug", label: "title", type: "type" },
      keep: { path: "is_system_attribute", is: false },
    },
  },
  writes: {
    deal: {
      ...writesOf("deals"),
      remove: { operation: "delete", path: { object: "deals", record_id: "{id}" } },
      fields: {
        title: { to: "name", list: true },
        pipeline: "implied",
        stage: { to: "stage", list: true },
        owner: {
          to: "owner",
          list: true,
          each: { referenced_actor_type: "workspace-member", referenced_actor_id: "{value}" },
        },
        amount: { to: "value", list: true, number: true, decimals: 4, each: { currency_value: "{value}" } },
        currency: {
          fixed: { operation: "attribute", path: { object: "deals", attribute: "value" } },
          at: "data.config.currency.default_currency_code",
        },
        organization: { to: "associated_company", list: true, each: reference("companies") },
        people: { to: "associated_people", list: true, each: reference("people") },
      },
    },
    person: {
      ...writesOf("people"),
      fields: {
        name: { to: "name", list: true, each: { full_name: "{value}" } },
        firstName: { to: "name", list: true, each: { first_name: "{value}" } },
        lastName: { to: "name", list: true, each: { last_name: "{value}" } },
        position: { to: "job_title", list: true },
        emails: { to: "email_addresses", list: true },
        phones: { to: "phone_numbers", list: true, each: { original_phone_number: "{value}" } },
      },
    },
  },
}

const hooks: CrmManifestHooks = {
  pipelines: { deal: { outcome: (stage, _, found) => (stage.title === "Lost" ? "lost" : found) } },
}

describe("crmManifestWriteContract over Attio's shapes", () => {
  for (const { name, run } of crmManifestWriteContract(ATTIO, { api, definitions, hooks })) it(name, run)
})

// A flat shape, HubSpot's: each field one property under `properties`, cleared by an empty string, a PATCH.

const flatDefinitions: Record<string, SchemaNode> = {
  Row: obj({ id: str, properties: open({ ...str, nullable: true }) }, ["id", "properties"]),
  Rows: obj({ results: list(ref("Row")) }, ["results"]),
  Properties: obj({ properties: open(str) }, ["properties"]),
  Pipelines: obj({
    results: list(obj({ id: str, label: str, stages: list(obj({ id: str, label: str, won: str })) })),
  }),
  Empty: obj({}),
}

const flatApi: ServiceApiManifest = {
  operations: [
    op("list", "GET", "/objects/{type}", { parameters: [path("type")], ...answered("Rows") }),
    op("read", "GET", "/objects/{type}/{id}", { parameters: [path("type"), path("id")], ...answered("Row") }),
    op("make", "POST", "/objects/{type}", {
      parameters: [path("type")],
      request: { required: true, confidence: "contract", schema: "Properties" },
      ...answered("Row"),
    }),
    {
      ...op("patch", "POST", "/objects/{type}/{id}", {
        parameters: [path("type"), path("id")],
        request: { required: true, confidence: "contract", schema: "Properties" },
        ...answered("Row"),
      }),
      binding: { kind: "http", method: "PATCH", path: "/objects/{type}/{id}" },
    },
    op("archive", "DELETE", "/objects/{type}/{id}", { parameters: [path("type"), path("id")], ...answered("Empty") }),
    op("pipelines", "GET", "/pipelines/deals", { ...answered("Pipelines") }),
  ],
  servers: [{ url: "https://api.flat.test" }],
  securitySchemes: { token: { type: "http", scheme: "bearer" } },
  security: [{ token: [] }],
}

const flatEntity = (type: string) => ({
  list: { operation: "list", path: { type }, items: "results" },
  get: { operation: "read", path: { type, id: "{id}" } },
})
const flatWrites = (type: string) => ({
  create: { operation: "make", path: { type }, body: { properties: "{values}" } },
  update: { operation: "patch", path: { type, id: "{id}" }, body: { properties: "{values}" } },
  id: "id",
  clear: "",
  custom: {},
})

const FLAT: CrmManifest = {
  provider: "flat",
  kinds: ["organization", "person", "deal"],
  entities: {
    organization: {
      ...flatEntity("companies"),
      map: {
        externalId: "id",
        name: "properties.name",
        phones: { all: ["properties.phone"] },
        emails: { all: ["properties.email"] },
      },
    },
    person: {
      ...flatEntity("contacts"),
      map: {
        externalId: "id",
        name: { join: ["properties.firstname", "properties.lastname"] },
        firstName: "properties.firstname",
        lastName: "properties.lastname",
        emails: { all: ["properties.email"] },
        position: "properties.jobtitle",
      },
    },
    deal: {
      ...flatEntity("deals"),
      map: {
        externalId: "id",
        title: "properties.dealname",
        pipeline: "properties.pipeline",
        stage: "properties.dealstage",
        amount: "properties.amount",
        currency: "properties.deal_currency_code",
        closeDate: "properties.closedate",
        assignee: "properties.hubspot_owner_id",
      },
    },
  },
  pipelines: {
    deal: {
      call: { operation: "pipelines", items: "results" },
      map: { externalId: "id", name: "label" },
      stages: { each: "stages", map: { externalId: "id", name: "label" }, outcome: { path: "won", won: ["yes"] } },
    },
  },
  writes: {
    organization: {
      ...flatWrites("companies"),
      fields: { name: { to: "name" }, phones: { to: "phone" }, emails: { to: "email" } },
    },
    person: {
      ...flatWrites("contacts"),
      fields: {
        firstName: { to: "firstname" },
        lastName: { to: "lastname" },
        emails: { to: "email" },
        position: { to: "jobtitle" },
      },
    },
    deal: {
      ...flatWrites("deals"),
      remove: { operation: "archive", path: { type: "deals", id: "{id}" } },
      fields: {
        title: { to: "dealname" },
        pipeline: { to: "pipeline" },
        stage: { to: "dealstage" },
        amount: { to: "amount" },
        currency: { to: "deal_currency_code" },
        closeDate: { to: "closedate" },
        owner: { to: "hubspot_owner_id" },
        reason: { to: "closed_reason" },
      },
    },
  },
}

describe("crmManifestWriteContract over a flat shape", () => {
  for (const { name, run } of crmManifestWriteContract(FLAT, { api: flatApi, definitions: flatDefinitions }))
    it(name, run)
})

const OPERATION = { operationId: "op-1" }

const attio = () => crmManifestWriteFixture(ATTIO, { api, definitions, hooks })
const bodyOf = (fixture: Awaited<ReturnType<typeof attio>>, operation: string) =>
  fixture.fake.calls.filter((call) => call.operation === operation).at(-1)?.body

describe("crmWriterFromManifest", () => {
  it("sends each field in the shape its rule gives, merged where rules share a key", async () => {
    const fixture = await attio()
    const stage = fixture.pipeline.stages[0]?.externalId as string
    await fixture.writer.create(
      "deal",
      { title: "Example kitchen", stage, amount: "1500.50", currency: "EUR", owner: "7001", people: [] },
      OPERATION,
    )
    expect(bodyOf(fixture, "create")).toEqual({
      data: {
        values: {
          name: ["Example kitchen"],
          stage: [stage],
          value: [{ currency_value: 1500.5 }],
          owner: [{ referenced_actor_type: "workspace-member", referenced_actor_id: "7001" }],
          associated_people: [],
        },
      },
    })
    await fixture.writer.create("person", { firstName: "Anna", lastName: "Example" }, OPERATION)
    expect(bodyOf(fixture, "create")).toEqual({
      data: { values: { name: [{ first_name: "Anna", last_name: "Example", full_name: "Anna Example" }] } },
    })
    expect(fixture.fake.refusals).toEqual([])
  })

  it("refuses a field with no rule before anything is sent, naming the field and the service", async () => {
    const fixture = await attio()
    const stage = fixture.pipeline.stages[0]?.externalId as string
    const made = await fixture.writer.create("deal", { title: "Example", stage }, OPERATION)
    const before = fixture.requests()
    await expect(
      fixture.writer.update("deal", made.externalId, { closeDate: "2026-12-01" }, OPERATION),
    ).rejects.toMatchObject({
      code: "validation_error",
      message: expect.stringMatching(/attio.*closeDate/),
      details: { sent: false },
    })
    await expect(
      fixture.writer.close("deal", made.externalId, "won", { ...OPERATION, reason: "price" }),
    ).rejects.toMatchObject({ code: "validation_error", details: { param: "--reason", sent: false } })
    expect(fixture.requests()).toBe(before)
  })

  it("refuses an amount in another currency than the service keeps, and clears a field with the service's value", async () => {
    const fixture = await attio()
    const stage = fixture.pipeline.stages[0]?.externalId as string
    const before = fixture.requests()
    await expect(
      fixture.writer.create("deal", { title: "Example", stage, amount: "10", currency: "USD" }, OPERATION),
    ).rejects.toMatchObject({
      code: "validation_error",
      message: expect.stringContaining("EUR"),
      details: { sent: false },
    })
    expect(fixture.requests()).toBe(before)
    const made = await fixture.writer.create("deal", { title: "Example", stage, owner: "7001" }, OPERATION)
    const cleared = await fixture.writer.update("deal", made.externalId, { owner: null }, OPERATION)
    expect(bodyOf(fixture, "replace")).toEqual({ data: { values: { owner: [] } } })
    expect(cleared.assignee ?? null).toBeNull()
  })

  it("a write the service made whose record cannot be read back is invalid_response with sent: true", async () => {
    const fixture = await attio()
    const stage = fixture.pipeline.stages[0]?.externalId as string
    const made = await fixture.writer.create("deal", { title: "Example", stage }, OPERATION)
    fixture.fake.deny("deal", made.externalId, 500)
    await expect(
      fixture.writer.update("deal", made.externalId, { title: "Example renamed" }, OPERATION),
    ).rejects.toMatchObject({
      code: "invalid_response",
      details: { sent: true, operation_id: "op-1", external_id: made.externalId },
    })
  })

  it("refuses a --field code the service does not define, such as an attribute's id, with nothing sent", async () => {
    const fixture = await attio()
    const [open, won] = [fixture.pipeline.stages[0], fixture.pipeline.stages.find((one) => one.outcome === "won")]
    const made = await fixture.writer.create("deal", { title: "Example", stage: open?.externalId as string }, OPERATION)
    const before = fixture.requests()
    const attributeId = "e3b0c442-98fc-1c14-9afb-4c8996fb9242"
    for (const code of [attributeId, "Stage"])
      await expect(
        fixture.writer.update("deal", made.externalId, { custom: { [code]: won?.externalId as string } }, OPERATION),
      ).rejects.toMatchObject({ code: "validation_error", details: { param: "--field", sent: false } })
    expect(fixture.requests()).toBe(before)
    await fixture.writer.update("deal", made.externalId, { custom: { deal_field_1: "Example" } }, OPERATION)
    expect(bodyOf(fixture, "replace")).toEqual({ data: { values: { deal_field_1: ["Example"] } } })
    expect(fixture.fake.refusals).toEqual([])
  })

  it("an update of one part of a value written whole sends the other parts as the service holds them", async () => {
    const fixture = await attio()
    const made = await fixture.writer.create("person", { firstName: "Anna", lastName: "Example" }, OPERATION)
    const changed = await fixture.writer.update("person", made.externalId, { firstName: "Ann" }, OPERATION)
    expect(bodyOf(fixture, "replace")).toEqual({
      data: { values: { name: [{ first_name: "Ann", last_name: "Example", full_name: "Ann Example" }] } },
    })
    expect(changed).toMatchObject({ firstName: "Ann", lastName: "Example", name: "Ann Example" })
    await fixture.writer.update("person", made.externalId, { name: "Ann Lee" }, OPERATION)
    expect(bodyOf(fixture, "replace")).toEqual({
      data: { values: { name: [{ full_name: "Ann Lee", first_name: "Ann", last_name: "Lee" }] } },
    })
  })

  it("refuses an amount with more decimal places than the service keeps", async () => {
    const fixture = await attio()
    const stage = fixture.pipeline.stages[0]?.externalId as string
    await expect(
      fixture.writer.create("deal", { title: "Example", stage, amount: "1.12345", currency: "EUR" }, OPERATION),
    ).rejects.toMatchObject({ code: "validation_error", details: { param: "amount", sent: false } })
    expect(fixture.requests()).toBe(0)
  })

  it("closes as lost to the lost stage of the item's own pipeline", async () => {
    const lostHooks: CrmManifestHooks = {
      pipelines: { deal: { outcome: (stage, _, found) => (stage.title === "name 3" ? "lost" : found) } },
    }
    const fixture = await crmManifestWriteFixture(ATTIO, { api, definitions, hooks: lostHooks })
    const stage = fixture.pipeline.stages[0]?.externalId as string
    const made = await fixture.writer.create("deal", { title: "Example", stage }, OPERATION)
    const closed = await fixture.writer.close("deal", made.externalId, "lost", OPERATION)
    expect(closed.stage).toBe(fixture.pipeline.stages.find((one) => one.outcome === "lost")?.externalId)
    // Two pipelines: the item stands in the second, whose won stage is not the first one's.
    const sent: unknown[] = []
    const source = {
      record: async () => ({ externalId: "d1", pipeline: "p2", stage: "a" }),
      pipelines: async () => [
        { externalId: "p1", name: "One", stages: [{ externalId: "w1", name: "Won", position: 0, outcome: "won" }] },
        { externalId: "p2", name: "Two", stages: [{ externalId: "w2", name: "Won", position: 0, outcome: "won" }] },
      ],
    } as unknown as CrmManifestSource
    const writer = crmWriterFromManifest(ATTIO, {
      api,
      service: "attio",
      send: async (_operation, input) => sent.push(JSON.parse(input.body ?? "null")),
      source: () => source,
    })
    await writer.close("deal", "d1", "won", OPERATION)
    expect(sent).toEqual([{ data: { values: { stage: ["w2"] } } }])
  })

  it("a flat shape clears a field with an empty string", async () => {
    const fixture = await crmManifestWriteFixture(FLAT, { api: flatApi, definitions: flatDefinitions })
    const stage = fixture.pipeline.stages[0]?.externalId as string
    const made = await fixture.writer.create("deal", { title: "Example", stage, closeDate: "2026-12-01" }, OPERATION)
    expect(made.closeDate).toBe("2026-12-01")
    const cleared = await fixture.writer.update("deal", made.externalId, { closeDate: null }, OPERATION)
    expect(fixture.fake.calls.filter((call) => call.operation === "patch").at(-1)?.body).toEqual({
      properties: { closedate: "" },
    })
    expect(cleared.closeDate ?? null).toBeNull()
  })

  it("takes what the manifest describes, and checks each operation's api keys", () => {
    expect(crmManifestWriteCapabilities(ATTIO, api)).toEqual({
      kinds: ["person", "deal"],
      verbs: ["create", "update", "move", "close", "remove"],
      idempotent: false,
    })
    const { writes: _, ...reads } = ATTIO
    expect(crmManifestWriteCapabilities(reads, api)).toBeUndefined()
    const keys = crmManifestWriteKeys(ATTIO, api)
    expect(keys("deal", "close")).toEqual(["api.replace"])
    expect(keys("deal", "remove")).toEqual(["api.delete", "records.delete"])
    expect(keys("organization", "create")).toEqual([])
  })
})

describe("parseCrmManifest of writes", () => {
  const deal = ATTIO.writes?.deal as NonNullable<NonNullable<CrmManifest["writes"]>["deal"]>
  const refused = (writes: unknown, message: string) =>
    expect(() => parseCrmManifest({ ...ATTIO, writes }, api)).toThrow(message)

  it("names what is wrong and where", () => {
    refused(
      { deal: { ...deal, fields: { titel: { to: "name" } } } },
      "writes.deal.fields.titel: a deal writes no such field; did you mean title?",
    )
    refused(
      { deal: { ...deal, update: { ...deal.update, operation: "get" } } },
      "writes.deal.update.operation: get is a read",
    )
    refused({ deal: { ...deal, update: { operation: "replace", body: VALUES } } }, 'writes.deal.update: no "{id}"')
    refused(
      { deal: { ...deal, create: { operation: "create", path: { object: "deals" } } } },
      'writes.deal.create: no "{values}"',
    )
    refused(
      { person: { ...ATTIO.writes?.person, remove: deal.remove } },
      "writes.person.remove: only a deal or a lead is removed",
    )
    refused({ lead: deal }, "writes.lead: lead is not in kinds")
    const { get: _, ...unread } = ATTIO.entities.deal as NonNullable<CrmManifest["entities"]["deal"]>
    expect(() => parseCrmManifest({ ...ATTIO, entities: { ...ATTIO.entities, deal: unread } }, api)).toThrow(
      "writes.deal: each write is read back by entities.deal.get",
    )
    refused(
      { deal: { ...deal, fields: { stage: "implied" } } },
      "writes.deal.fields.stage: only a pipeline follows from the stage",
    )
    refused(
      { deal: { ...deal, fields: { title: { to: "name" }, stage: { to: "name" } } } },
      "writes.deal.fields: title, stage share name",
    )
  })
})

const APP: AppIdentity = {
  command: "attio",
  appName: "example-attio-cli",
  envPrefix: "ATTIO",
  description: "synthetic",
  version: "1.0.0",
}

const opened: MessageStore[] = []
afterEach(async () => {
  for (const store of opened.splice(0)) await store.close()
})

describe("CRM write commands over a manifest's writes", () => {
  const setup = async (permissions: Record<string, Level> = {}) => {
    const fake = crmManifestFake(ATTIO, { api, definitions })
    const sending = { manifest: api, service: "Attio", fetch: fake.fetch, token: () => FAKE_MANIFEST_TOKEN }
    const source = crmSourceFromManifest(ATTIO, { api, call: serviceApiCall(sending), hooks })
    const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "crm-manifest-")), "store.db") })
    opened.push(store)
    await store.accounts.registerProvider({
      name: "attio",
      kind: "crm",
      aliases: [],
      command: "attio",
      opens: CRM_OPENS,
    })
    const home = mkdtempSync(join(tmpdir(), "crm-manifest-writes-"))
    const env = { HOME: home, XDG_DATA_HOME: home, XDG_STATE_HOME: home, ATTIO_STATE_DIR: home }
    const run = {
      profile: "work",
      account: { provider: "attio", account: "workspace" },
      user: null,
      store,
      source: () => source,
      writes: () =>
        crmManifestWrites(ATTIO, {
          ...sending,
          source: () => source,
          app: APP,
          env,
          settings: () => ({ profile: "work", permissions, permissionSources: {} }),
        }),
    }
    let data = ""
    const cli = async (...args: string[]) => {
      const root = new Command("attio")
        .exitOverride()
        .configureOutput({ writeErr: () => undefined, writeOut: () => undefined })
        .option("--json")
        .option("--yes")
        .option("--dry-run")
      addCrmCommands(root, {
        app: APP,
        open: async () => run,
        writes: crmManifestWriteCapabilities(ATTIO, api),
      })
      provide(root, { streams: { data: (text: string) => (data += text), diagnostic: () => undefined } } as never)
      data = ""
      await root.parseAsync([...args, "--json"], { from: "user" })
      return JSON.parse(data) as { item: Record<string, unknown> }
    }
    await cli("sync")
    const journal = () => new SendJournal(sendsPathFor(APP, "work", env)).entries()
    return { fake, cli, journal }
  }

  it("deals create sends the manifest's create once, stores the answer and journals it", async () => {
    const { fake, cli, journal } = await setup()
    const made = await cli("deals", "create", "--title", "Example kitchen", "--stage", "name 1")
    expect(made.item).toMatchObject({ deal: { title: "Example kitchen", stage: "name 1" } })
    expect(fake.requests()).toBe(1)
    expect(journal()).toEqual([expect.objectContaining({ outcome: "sent", key: "deals.create" })])
    expect(fake.refusals).toEqual([])
  })

  it("a deny on the operation's api key stops the write before anything is sent", async () => {
    const { fake, cli } = await setup({ "api.create": "deny" })
    await expect(cli("deals", "create", "--title", "Example kitchen", "--stage", "name 1")).rejects.toMatchObject({
      code: "permission_error",
    })
    expect(fake.requests()).toBe(0)
  })
})

// serviceApiSend is the writer's own door; serviceApiCall stays a reader.
describe("serviceApiCall", () => {
  it("still refuses a write", async () => {
    const fake = crmManifestFake(ATTIO, { api, definitions })
    const sending = { manifest: api, service: "Attio", fetch: fake.fetch, token: () => FAKE_MANIFEST_TOKEN }
    const input = { path: { object: "deals" }, query: {}, headers: {}, fields: {}, body: "{}" }
    await expect(serviceApiCall(sending)("create", input)).rejects.toMatchObject({ code: "configuration_error" })
    expect(fake.requests()).toBe(0)
  })
})
