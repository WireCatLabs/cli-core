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
const object = (properties: Record<string, SchemaNode>, required: string[] = []): SchemaNode => ({
  type: "object",
  properties,
  required,
})
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
  ProjectStatus: object({ type: { type: "string", enum: ["backlog", "planned", "started", "completed"] } }),
  Project: node({
    name: text,
    description: text,
    state: text,
    status: ref("ProjectStatus", false),
    lead: ref("User"),
    teams: ref("TeamConnection", false),
    targetDate: text,
    url: text,
  }),
  Cycle: node({
    name: text,
    number: { type: "number", nullable: true },
    description: text,
    team: ref("Team"),
    startsAt: text,
    endsAt: text,
    completedAt: text,
  }),
  Issue: node({
    identifier: text,
    title: text,
    description: text,
    state: ref("WorkflowState"),
    team: ref("Team"),
    project: ref("Project"),
    cycle: ref("Cycle"),
    assignee: ref("User"),
    creator: ref("User"),
    labels: ref("IssueLabelConnection", false),
    parent: ref("Issue"),
    priority: { type: "number", nullable: true },
    dueDate: text,
    completedAt: text,
    canceledAt: text,
    trashed: { type: "boolean", nullable: true },
    url: text,
  }),
  Comment: node({ body: text, issue: ref("Issue"), user: ref("User"), url: text }),
}
for (const name of ["Team", "User", "WorkflowState", "IssueLabel", "Project", "Cycle", "Issue", "Comment"])
  definitions[`${name}Connection`] = connection(name)

const ids: SchemaNode = { type: "array", items: { type: "string" }, nullable: true }
const issueInput = {
  title: text,
  description: text,
  teamId: text,
  stateId: text,
  assigneeId: text,
  priority: { type: "integer", nullable: true },
  labelIds: ids,
  projectId: text,
  parentId: text,
} satisfies Record<string, SchemaNode>
Object.assign(definitions, {
  IssueCreateInput: object(issueInput, ["teamId"]),
  IssueUpdateInput: object(issueInput),
  CommentCreateInput: object({ issueId: text, body: text }),
  IssueCreateRequest: object({ input: ref("IssueCreateInput", false) }, ["input"]),
  IssueUpdateRequest: object({ id: { type: "string" }, input: ref("IssueUpdateInput", false) }, ["id", "input"]),
  CommentCreateRequest: object({ input: ref("CommentCreateInput", false) }, ["input"]),
  IssuePayload: object({ success: { type: "boolean" }, issue: ref("Issue") }),
  CommentPayload: object({ success: { type: "boolean" }, comment: ref("Comment") }),
} satisfies Record<string, SchemaNode>)

const mutation = (field: string, variables: Record<string, string>, payload: string): ManifestOperation => ({
  id: field,
  command: field.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`),
  binding: { kind: "graphql", operation: "mutation", field, variables, selection: "success" },
  effect: "write",
  tags: ["mutation"],
  parameters: Object.keys(variables).map((name) => ({
    name,
    in: "body" as const,
    required: true,
    schema: { type: "unknown" },
  })),
  request: { required: true, confidence: "contract", schema: `${field[0]?.toUpperCase()}${field.slice(1)}Request` },
  response: { confidence: "contract", schema: payload },
})

export const FIELDS: Record<TrackerKind, [field: string, type: string]> = {
  team: ["teams", "Team"],
  user: ["users", "User"],
  state: ["workflowStates", "WorkflowState"],
  label: ["issueLabels", "IssueLabel"],
  project: ["projects", "Project"],
  sprint: ["cycles", "Cycle"],
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
    mutation("issueCreate", { input: "IssueCreateInput!" }, "IssuePayload"),
    mutation("issueUpdate", { input: "IssueUpdateInput!", id: "String!" }, "IssuePayload"),
    mutation("commentCreate", { input: "CommentCreateInput!" }, "CommentPayload"),
  ],
}

export const PAGE_INFO = "pageInfo { hasNextPage endCursor }"
const TIMES = "id createdAt updatedAt archivedAt"
const ISSUE_ROW =
  `${TIMES} identifier title description state { id } team { id } project { id } assignee { id } ` +
  "creator { id } labels { nodes { id } } parent { id } cycle { id } priority dueDate completedAt canceledAt " +
  "trashed url"
const COMMENT_ROW = `${TIMES} body issue { id } user { id } url`
const SELECTIONS: Record<TrackerKind, string> = {
  team: `nodes { ${TIMES} name key } ${PAGE_INFO}`,
  user: `nodes { ${TIMES} name email active } ${PAGE_INFO}`,
  state: `nodes { ${TIMES} name type position team { id } } ${PAGE_INFO}`,
  label: `nodes { ${TIMES} name team { id } } ${PAGE_INFO}`,
  project: `nodes { ${TIMES} name description state lead { id } teams { nodes { id } } targetDate url } ${PAGE_INFO}`,
  sprint: `nodes { ${TIMES} name number description team { id } startsAt endsAt completedAt } ${PAGE_INFO}`,
  issue: `nodes { ${ISSUE_ROW} } ${PAGE_INFO}`,
  comment: `nodes { ${COMMENT_ROW} } ${PAGE_INFO}`,
}
const TIME_MAP = { externalId: "id", createdAt: "createdAt", updatedAt: "updatedAt", archivedAt: "archivedAt" }
// A literal after `key:` reads as a permission key to src/cli/permission-keys.test.ts.
const TEAM_KEY = "key"
const ISSUE_KEY = "identifier"
const MAPS: { [K in TrackerKind]: Record<string, unknown> } = {
  team: { ...TIME_MAP, name: "name", key: TEAM_KEY },
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
  sprint: {
    ...TIME_MAP,
    name: "name",
    number: "number",
    description: "description",
    team: "team.id",
    startsAt: "startsAt",
    endsAt: "endsAt",
    completedAt: "completedAt",
  },
  issue: {
    ...TIME_MAP,
    deleted: "trashed",
    key: ISSUE_KEY,
    title: "title",
    description: "description",
    state: "state.id",
    team: "team.id",
    project: "project.id",
    sprint: "cycle.id",
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
  kinds: ["team", "user", "state", "label", "project", "sprint", "issue", "comment"],
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
          ids: {
            operation,
            variables: ALL,
            selection: kind === "issue" ? `nodes { id trashed } ${PAGE_INFO}` : `nodes { id } ${PAGE_INFO}`,
          },
          map: MAPS[kind],
        },
      ]
    }),
  ),
  self: { call: { operation: "viewer" }, path: "id" },
  writes: {
    issue: {
      create: {
        operation: "issueCreate",
        variables: { input: "{values}" },
        selection: `success issue { ${ISSUE_ROW} }`,
        items: "issue",
      },
      update: {
        operation: "issueUpdate",
        variables: { id: "{id}", input: "{values}" },
        selection: `success issue { ${ISSUE_ROW} }`,
        items: "issue",
      },
      fields: {
        title: { to: "title" },
        description: { to: "description" },
        team: { to: "teamId" },
        state: { to: "stateId" },
        assignee: { to: "assigneeId" },
        priority: { to: "priority" },
        labels: { to: "labelIds" },
        project: { to: "projectId" },
        parent: { to: "parentId" },
      },
    },
    comment: {
      create: {
        operation: "commentCreate",
        variables: { input: "{values}" },
        selection: `success comment { ${COMMENT_ROW} }`,
        items: "comment",
      },
      fields: { issue: { to: "issueId" }, body: { to: "body" } },
    },
  },
} as unknown as TrackerManifest
