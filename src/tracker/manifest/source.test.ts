import {
  type GraphqlFakeCall,
  graphqlFake,
  type ManifestOperation,
  type SchemaNode,
  type Selection,
} from "@wirecat/cli-base/codegen"
import { describe, expect, it } from "vitest"
import { serviceApiCall } from "../../cli/service-api-call.js"
import type { ServiceApiManifest } from "../../cli/service-api-manifest.js"
import type { TrackerKind } from "../../domain/tracker.js"
import { trackerSourceContract } from "../testing/index.js"
import type { TrackerManifest } from "./manifest.js"
import { parseTrackerManifest } from "./manifest.js"
import { trackerSourceFromManifest } from "./source.js"

const URL = "https://api.example-tracker.test/graphql"
const KEY = "lin_api_fake"

const text: SchemaNode = { type: "string", nullable: true }
const ref = (name: string, nullable = true): SchemaNode => ({
  type: "ref",
  ref: name,
  ...(nullable ? { nullable } : {}),
})
const object = (properties: Record<string, SchemaNode>): SchemaNode => ({ type: "object", properties, required: [] })
const times = { createdAt: text, updatedAt: text, archivedAt: text }
const node = (properties: Record<string, SchemaNode>) => object({ id: { type: "string" }, ...times, ...properties })
const connection = (of: string) =>
  object({ nodes: { type: "array", items: ref(of, false) }, pageInfo: ref("PageInfo", false) })

const definitions: Record<string, SchemaNode> = {
  PageInfo: object({ hasNextPage: { type: "boolean" }, endCursor: text }),
  ListRequest: {
    type: "object",
    properties: {
      first: { type: "integer", nullable: true },
      after: text,
      includeArchived: { type: "boolean", nullable: true },
      filter: {
        type: "object",
        properties: {},
        required: [],
        additionalProperties: { type: "unknown" },
        nullable: true,
      },
    },
    required: [],
  },
  Team: node({ name: text, key: text }),
  User: node({ name: text, email: text, active: { type: "boolean", nullable: true } }),
  WorkflowState: node({ name: text, type: text, position: { type: "number", nullable: true }, team: ref("Team") }),
  IssueLabel: node({ name: text, team: ref("Team") }),
  Project: node({
    name: text,
    description: text,
    state: text,
    lead: ref("User"),
    teams: ref("TeamConnection", false),
    targetDate: text,
    url: text,
  }),
  Issue: node({
    identifier: text,
    title: text,
    description: text,
    state: ref("WorkflowState"),
    team: ref("Team"),
    project: ref("Project"),
    assignee: ref("User"),
    creator: ref("User"),
    labels: ref("IssueLabelConnection", false),
    parent: ref("Issue"),
    priority: { type: "number", nullable: true },
    dueDate: text,
    completedAt: text,
    canceledAt: text,
    url: text,
  }),
  Comment: node({ body: text, issue: ref("Issue"), user: ref("User"), url: text }),
}
for (const name of ["Team", "User", "WorkflowState", "IssueLabel", "Project", "Issue", "Comment"])
  definitions[`${name}Connection`] = connection(name)

const FIELDS: Record<TrackerKind, [field: string, type: string]> = {
  team: ["teams", "Team"],
  user: ["users", "User"],
  state: ["workflowStates", "WorkflowState"],
  label: ["issueLabels", "IssueLabel"],
  project: ["projects", "Project"],
  issue: ["issues", "Issue"],
  comment: ["comments", "Comment"],
}

const listOperation = (field: string, type: string): ManifestOperation => ({
  id: field,
  command: field.toLowerCase(),
  binding: {
    kind: "graphql",
    operation: "query",
    field,
    variables: { first: "Int", after: "String", filter: `${type}Filter`, includeArchived: "Boolean" },
    selection: "nodes { id } pageInfo { hasNextPage endCursor }",
  },
  effect: "read",
  tags: ["query"],
  parameters: ["first", "after", "filter", "includeArchived"].map((name) => ({
    name,
    in: "body" as const,
    required: false,
    schema: (definitions.ListRequest as { properties: Record<string, SchemaNode> }).properties[name] as SchemaNode,
  })),
  request: { required: false, confidence: "contract", schema: "ListRequest" },
  response: { confidence: "contract", schema: `${type}Connection` },
  pagination: {
    style: "cursor",
    cursor: { in: "body", name: "after" },
    next: "pageInfo.endCursor",
    items: "nodes",
    hasMore: "pageInfo.hasNextPage",
    limit: { in: "body", name: "first" },
  },
})

const api: ServiceApiManifest = {
  servers: [{ url: URL }],
  securitySchemes: { key: { type: "apiKey", in: "header", name: "Authorization" } },
  security: [{ key: [] }],
  operations: [
    ...Object.values(FIELDS).map(([field, type]) => listOperation(field, type)),
    {
      id: "viewer",
      command: "viewer",
      binding: { kind: "graphql", operation: "query", field: "viewer", variables: {}, selection: "id" },
      effect: "read",
      tags: ["query"],
      parameters: [],
      response: { confidence: "contract", schema: "User" },
    },
  ],
}

const PAGE_INFO = "pageInfo { hasNextPage endCursor }"
const TIMES = "id createdAt updatedAt archivedAt"
const SELECTIONS: Record<TrackerKind, string> = {
  team: `nodes { ${TIMES} name key } ${PAGE_INFO}`,
  user: `nodes { ${TIMES} name email active } ${PAGE_INFO}`,
  state: `nodes { ${TIMES} name type position team { id } } ${PAGE_INFO}`,
  label: `nodes { ${TIMES} name team { id } } ${PAGE_INFO}`,
  project: `nodes { ${TIMES} name description state lead { id } teams { nodes { id } } targetDate url } ${PAGE_INFO}`,
  issue:
    `nodes { ${TIMES} identifier title description state { id } team { id } project { id } assignee { id } ` +
    `creator { id } labels { nodes { id } } parent { id } priority dueDate completedAt canceledAt url } ${PAGE_INFO}`,
  comment: `nodes { ${TIMES} body issue { id } user { id } url } ${PAGE_INFO}`,
}
const TIME_MAP = { externalId: "id", createdAt: "createdAt", updatedAt: "updatedAt", archivedAt: "archivedAt" }
const MAPS: { [K in TrackerKind]: Record<string, unknown> } = {
  team: { ...TIME_MAP, name: "name", key: "key" },
  user: { ...TIME_MAP, name: "name", email: "email", active: "active" },
  state: { ...TIME_MAP, name: "name", type: "type", position: "position", team: "team.id" },
  label: { ...TIME_MAP, name: "name", team: "team.id" },
  project: {
    ...TIME_MAP,
    name: "name",
    description: "description",
    status: "state",
    lead: "lead.id",
    teams: { each: "teams.nodes", value: "id" },
    targetDate: "targetDate",
    url: "url",
  },
  issue: {
    ...TIME_MAP,
    key: "identifier",
    title: "title",
    description: "description",
    state: "state.id",
    team: "team.id",
    project: "project.id",
    assignee: "assignee.id",
    creator: "creator.id",
    labels: { each: "labels.nodes", value: "id" },
    parent: "parent.id",
    priority: "priority",
    dueDate: "dueDate",
    completedAt: "completedAt",
    canceledAt: "canceledAt",
    url: "url",
  },
  comment: { ...TIME_MAP, body: "body", issue: "issue.id", author: "user.id", url: "url" },
}

const ALL = { first: 50, includeArchived: true }
const MANIFEST = {
  provider: "example-tracker",
  kinds: ["team", "user", "state", "label", "project", "issue", "comment"],
  entities: Object.fromEntries(
    (Object.keys(FIELDS) as TrackerKind[]).map((kind) => {
      const [operation] = FIELDS[kind]
      return [
        kind,
        {
          list: { operation, variables: ALL, selection: SELECTIONS[kind] },
          changes: {
            operation,
            variables: { ...ALL, filter: { updatedAt: { gte: "{since}" } } },
            selection: SELECTIONS[kind],
            since: "iso",
          },
          ids: { operation, variables: ALL, selection: `nodes { id } ${PAGE_INFO}` },
          map: MAPS[kind],
        },
      ]
    }),
  ),
  self: { call: { operation: "viewer" }, path: "id" },
} as unknown as TrackerManifest

type Row = Record<string, unknown>

const project = (value: unknown, selection: Selection | true): unknown => {
  if (selection === true || value === null || value === undefined) return value ?? null
  if (Array.isArray(value)) return value.map((one) => project(one, selection))
  return Object.fromEntries(
    Object.entries(selection).map(([field, inner]) => [field, project((value as Row)[field], inner)]),
  )
}

const at = (ms: number) => new Date(ms).toISOString()
const SEEDED = Date.UTC(2026, 10, 1)
const ref1 = (id: string | null) => (id === null ? null : { id })

const seed = (): Record<TrackerKind, Row[]> => {
  const times = (n: number) => ({ createdAt: at(SEEDED), updatedAt: at(SEEDED + n * 1000), archivedAt: null })
  return {
    team: [
      { id: "t1", name: "Engineering", key: "ENG", ...times(1) },
      { id: "t2", name: "Design", key: "DES", ...times(2) },
      { id: "t3", name: "Support", key: "SUP", ...times(3) },
    ],
    user: [
      { id: "u1", name: "Ada", email: "ada@example.com", active: true, ...times(1) },
      { id: "u2", name: "Bob", email: "bob@example.com", active: true, ...times(2) },
      { id: "u3", name: "Cy", email: "cy@example.com", active: false, ...times(3) },
    ],
    state: [
      { id: "s1", name: "Todo", type: "unstarted", position: 1, team: ref1("t1"), ...times(1) },
      { id: "s2", name: "Doing", type: "started", position: 2, team: ref1("t1"), ...times(2) },
      { id: "s3", name: "Done", type: "completed", position: 3, team: ref1("t1"), ...times(3) },
    ],
    label: [
      { id: "l1", name: "Bug", team: ref1("t1"), ...times(1) },
      { id: "l2", name: "Feature", team: null, ...times(2) },
      { id: "l3", name: "Chore", team: ref1("t2"), ...times(3) },
    ],
    project: [1, 2, 3].map((n) => ({
      id: `p${n}`,
      name: `Project ${n}`,
      description: null,
      state: "started",
      lead: ref1("u1"),
      teams: { nodes: [{ id: "t1" }] },
      targetDate: "2026-12-31",
      url: `https://tracker.example/p${n}`,
      ...times(n),
    })),
    issue: [1, 2, 3].map((n) => ({
      id: `i${n}`,
      identifier: `ENG-${n}`,
      title: `Issue ${n}`,
      description: null,
      state: ref1("s1"),
      team: ref1("t1"),
      project: n === 3 ? null : ref1("p1"),
      assignee: n === 2 ? null : ref1("u1"),
      creator: ref1("u2"),
      labels: { nodes: n === 1 ? [{ id: "l1" }] : [] },
      parent: null,
      priority: n,
      dueDate: null,
      completedAt: null,
      canceledAt: null,
      url: `https://tracker.example/ENG-${n}`,
      ...times(n),
    })),
    comment: [1, 2, 3].map((n) => ({
      id: `c${n}`,
      body: `Comment ${n}`,
      issue: ref1("i1"),
      user: ref1("u2"),
      url: null,
      ...times(n),
    })),
  }
}

/** A tracker that pages by two, filters by `updatedAt.gte`, leaves archived rows out unless asked, and stamps changes. */
const tracker = (answers: Readonly<Record<string, (call: GraphqlFakeCall) => unknown>> = {}) => {
  const rows = seed()
  let tick = 0
  const clock = () => Date.now() + tick++ * 1000
  const list = (kind: TrackerKind) => (call: GraphqlFakeCall) => {
    const { first, after, filter, includeArchived } = call.variables as {
      first?: number
      after?: string | null
      filter?: { updatedAt?: { gte?: string } }
      includeArchived?: boolean
    }
    const since = filter?.updatedAt?.gte === undefined ? null : Date.parse(filter.updatedAt.gte)
    const listed = rows[kind]
      .filter((row) => includeArchived || row.archivedAt === null)
      .filter((row) => since === null || Date.parse(String(row.updatedAt)) >= since)
      .sort(
        (a, b) => String(a.updatedAt).localeCompare(String(b.updatedAt)) || String(a.id).localeCompare(String(b.id)),
      )
    const offset = after ? Number(after.slice(2)) : 0
    const size = Math.min(first ?? 50, 2)
    const more = offset + size < listed.length
    return {
      data: project(
        {
          nodes: listed.slice(offset, offset + size),
          pageInfo: { hasNextPage: more, endCursor: more ? `o:${offset + size}` : null },
        },
        call.selection ?? true,
      ),
    }
  }
  const fake = graphqlFake({
    operations: api.operations,
    definitions,
    url: URL,
    auth: { header: "authorization", value: KEY },
    answers: {
      ...Object.fromEntries((Object.keys(FIELDS) as TrackerKind[]).map((kind) => [FIELDS[kind][0], list(kind)])),
      viewer: () => ({ data: { id: "u1" } }),
      ...answers,
    },
  })
  const find = (kind: TrackerKind, id: string) => {
    const row = rows[kind].find((one) => one.id === id)
    if (!row) throw new Error(`no ${kind} ${id}`)
    return row
  }
  const call = serviceApiCall({ manifest: api, service: "Tracker", fetch: fake.fetch, token: () => KEY })
  const sourceAt = (skew = 0) => trackerSourceFromManifest(MANIFEST, { api, call, now: () => clock() + skew })
  return {
    rows,
    fake,
    sourceAt,
    touch(kind: TrackerKind, id: string) {
      find(kind, id).updatedAt = at(clock())
    },
    archive(kind: TrackerKind, id: string) {
      const row = find(kind, id)
      row.archivedAt = at(clock())
      row.updatedAt = row.archivedAt
    },
    remove(kind: TrackerKind, id: string) {
      rows[kind].splice(rows[kind].indexOf(find(kind, id)), 1)
    },
  }
}

describe("trackerSourceFromManifest over a Linear-shaped GraphQL fake", () => {
  for (const c of trackerSourceContract(() => {
    const one = tracker()
    return {
      source: one.sourceAt(),
      held: Object.fromEntries(
        (Object.keys(FIELDS) as TrackerKind[]).map((kind) => [kind, one.rows[kind].map((row) => String(row.id))]),
      ),
      deadCursor: { kind: "issue", cursor: "not a time" },
      faults: {
        skewed: (ms) => one.sourceAt(ms),
        change: () => {
          one.touch("issue", "i2")
          return { kind: "issue", id: "i2" }
        },
        archive: () => {
          one.archive("issue", "i3")
          return { kind: "issue", id: "i3" }
        },
        remove: () => {
          one.remove("issue", "i3")
          return { kind: "issue", id: "i3" }
        },
      },
    }
  }))
    it(c.name, async () => {
      await c.run()
    })

  it("maps a row onto the tracker domain, reading a null object as none, and names the signed-in user", async () => {
    const one = tracker()
    const source = one.sourceAt()
    const page = await source.changes("issue", null)
    if ("reset" in page) throw new Error("a full list is never a reset")
    expect(page.items[0]).toEqual({
      externalId: "i1",
      createdAt: SEEDED,
      updatedAt: SEEDED + 1000,
      archivedAt: null,
      key: "ENG-1",
      title: "Issue 1",
      description: null,
      state: "s1",
      team: "t1",
      project: "p1",
      assignee: "u1",
      creator: "u2",
      labels: ["l1"],
      parent: null,
      priority: 1,
      dueDate: null,
      completedAt: null,
      canceledAt: null,
      url: "https://tracker.example/ENG-1",
    })
    expect(page.items[1]).toMatchObject({ externalId: "i2", assignee: null, labels: [] })
    expect(await source.self?.()).toBe("u1")
    expect(one.fake.refusals).toEqual([])
  })
})

describe("an optional kind", () => {
  const refused = () => ({ errors: [{ message: "Forbidden", extensions: { code: "FORBIDDEN" } }] })
  const optional = {
    ...MANIFEST,
    entities: { ...MANIFEST.entities, comment: { ...MANIFEST.entities.comment, optional: { message: "no comments" } } },
  } as TrackerManifest

  it("is a gap when the tracker refuses it in errors[], for its changes and its ids, and the others still read", async () => {
    const one = tracker({ [FIELDS.comment[0]]: refused })
    const call = serviceApiCall({ manifest: api, service: "Tracker", fetch: one.fake.fetch, token: () => KEY })
    const source = trackerSourceFromManifest(optional, { api, call })
    const gaps: unknown[] = []
    const context = { spend: () => undefined, gap: (gap: unknown) => gaps.push(gap) }
    expect(await source.changes("comment", null, undefined, context)).toEqual({
      items: [],
      hasMore: false,
      cursor: null,
    })
    expect(await source.ids("comment", undefined, context)).toEqual({ items: [], hasMore: false })
    expect(gaps).toEqual([
      { kind: "comment", message: "no comments" },
      { kind: "comment", message: "no comments" },
    ])
    const issues = await source.changes("issue", null, undefined, context)
    expect("items" in issues && issues.items.length).toBe(2)
  })

  it("is an error when the kind is not optional", async () => {
    const one = tracker({ [FIELDS.comment[0]]: refused })
    await expect(one.sourceAt().changes("comment", null)).rejects.toMatchObject({ code: "permission_error" })
  })
})

describe("parseTrackerManifest", () => {
  const broken = (change: (manifest: Row) => void) => {
    const copy = structuredClone({ ...MANIFEST }) as unknown as Row
    change(copy)
    return () => parseTrackerManifest(copy, api)
  }
  const issue = (manifest: Row) => (manifest.entities as Record<string, Row>).issue as Row

  it("refuses a map path the selection leaves out", () => {
    expect(
      broken((manifest) => {
        ;(issue(manifest).list as Row).selection = `nodes { id title } ${PAGE_INFO}`
      }),
    ).toThrow(/entities\.issue\.list\.selection: map\.createdAt reads createdAt, which the selection leaves out/)
  })

  it("refuses a selection GraphQL could not send", () => {
    expect(
      broken((manifest) => {
        ;(issue(manifest).list as Row).selection = "nodes { id title(first: 2) }"
      }),
    ).toThrow(/entities\.issue\.list\.selection/)
  })

  it("names a mistyped operation and field, and a change call without {since}", () => {
    expect(
      broken((manifest) => {
        ;(issue(manifest).list as Row).operation = "isues"
      }),
    ).toThrow(/no operation isues in the API; did you mean issues\?/)
    expect(
      broken((manifest) => {
        ;(issue(manifest).map as Row).titel = "title"
      }),
    ).toThrow(/issue has no such field; did you mean title\?/)
    expect(
      broken((manifest) => {
        ;(issue(manifest).changes as Row).variables = ALL
      }),
    ).toThrow(/no "\{since\}"/)
  })

  it("checks the signed-in user's path against the selection", () => {
    expect(
      broken((manifest) => {
        ;(manifest.self as Row).path = "viewer.id"
      }),
    ).toThrow(/self\.call\.selection: map\.self reads viewer\.id/)
  })

  it("refuses kinds out of order", () => {
    expect(
      broken((manifest) => {
        manifest.kinds = ["issue", "team"]
      }),
    ).toThrow(/in this order/)
  })
})
