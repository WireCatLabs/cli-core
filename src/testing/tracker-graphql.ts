import type { ManifestOperation, SchemaNode } from "@wirecat/cli-base/codegen"
import type { ServiceApiManifest } from "../cli/service-api-manifest.js"
import type { TrackerKind } from "../domain/tracker.js"
import type { TrackerManifest } from "../tracker/manifest/manifest.js"

export const URL = "https://api.example-tracker.test/graphql"
export const KEY = "lin_api_fake"

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

export const definitions: Record<string, SchemaNode> = {
  PageInfo: object({ hasNextPage: { type: "boolean" }, endCursor: text }),
  ListRequest: {
    type: "object",
    properties: {
      first: { type: "integer", nullable: true },
      after: text,
      includeArchived: { type: "boolean", nullable: true },
      orderBy: { type: "string", enum: ["createdAt", "updatedAt"], nullable: true },
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

export const FIELDS: Record<TrackerKind, [field: string, type: string]> = {
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
    variables: {
      first: "Int",
      after: "String",
      filter: `${type}Filter`,
      includeArchived: "Boolean",
      orderBy: "PaginationOrderBy",
    },
    selection: "nodes { id } pageInfo { hasNextPage endCursor }",
  },
  effect: "read",
  tags: ["query"],
  parameters: ["first", "after", "filter", "includeArchived", "orderBy"].map((name) => ({
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

export const api: ServiceApiManifest = {
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

export const PAGE_INFO = "pageInfo { hasNextPage endCursor }"
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
    labels: { each: "labels.nodes", id: "id" },
    parent: "parent.id",
    priority: "priority",
    dueDate: "dueDate",
    completedAt: "completedAt",
    canceledAt: "canceledAt",
    url: "url",
  },
  comment: { ...TIME_MAP, body: "body", issue: "issue.id", author: "user.id", url: "url" },
}

export const ALL = { first: 50, includeArchived: true }
export const MANIFEST = {
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
            variables: { ...ALL, orderBy: "updatedAt", filter: { updatedAt: { gte: "{since}" } } },
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
