// A hand-made introspection result shaped like Linear's: Relay connections, an input object, an enum, a custom
// scalar, wrapped types, and Delete, Archive and Unarchive mutations. Not Linear's real schema.
type Ref = { kind: string; name: string | null; ofType: Ref | null }

const named = (kind: string, name: string): Ref => ({ kind, name, ofType: null })
const scalar = (name: string) => named("SCALAR", name)
const object = (name: string) => named("OBJECT", name)
const input = (name: string) => named("INPUT_OBJECT", name)
const nonNull = (of: Ref): Ref => ({ kind: "NON_NULL", name: null, ofType: of })
const list = (of: Ref): Ref => ({ kind: "LIST", name: null, ofType: of })

const arg = (name: string, type: Ref, defaultValue: string | null = null) => ({
  name,
  description: null,
  type,
  defaultValue,
})
const field = (name: string, type: Ref, args: ReturnType<typeof arg>[] = [], description: string | null = null) => ({
  name,
  description,
  args,
  type,
  isDeprecated: false,
})
const type = (kind: string, name: string, rest: Record<string, unknown> = {}) => ({
  kind,
  name,
  description: null,
  fields: null,
  inputFields: null,
  enumValues: null,
  possibleTypes: null,
  ...rest,
})
const page = [arg("first", scalar("Int"), "50"), arg("after", scalar("String"))]
const connection = (name: string, node: string) =>
  type("OBJECT", `${name}Connection`, {
    fields: [field("nodes", nonNull(list(nonNull(object(node))))), field("pageInfo", nonNull(object("PageInfo")))],
  })

export const trackerIntrospection = () => ({
  data: {
    __schema: {
      queryType: { name: "Query" },
      mutationType: { name: "Mutation" },
      types: [
        type("SCALAR", "String"),
        type("SCALAR", "ID"),
        type("SCALAR", "Int"),
        type("SCALAR", "Float"),
        type("SCALAR", "Boolean"),
        type("SCALAR", "DateTime"),
        type("OBJECT", "Query", {
          fields: [
            field(
              "issues",
              nonNull(object("IssueConnection")),
              [
                ...page,
                arg("filter", input("IssueFilter")),
                arg("includeArchived", scalar("Boolean")),
                arg("orderBy", named("ENUM", "PaginationOrderBy")),
              ],
              "All issues.\nPaged.",
            ),
            field("issue", nonNull(object("Issue")), [arg("id", nonNull(scalar("String")))], "One issue by its id."),
            field("teams", nonNull(object("TeamConnection")), page),
            field("users", nonNull(object("UserConnection")), [...page, arg("includeArchived", scalar("Boolean"))]),
            field("workflowStates", nonNull(object("WorkflowStateConnection")), page),
            field("viewer", nonNull(object("User"))),
            field("maybeIssue", object("Issue"), [arg("id", nonNull(scalar("String")))]),
            field("recentIssues", nonNull(list(nonNull(object("Issue")))), [
              arg("limit", nonNull(scalar("Int")), "10"),
            ]),
            field("search", nonNull(list(nonNull(named("UNION", "SearchResult")))), [
              arg("term", nonNull(scalar("String"))),
            ]),
          ],
        }),
        type("OBJECT", "Mutation", {
          fields: [
            field("issueCreate", nonNull(object("IssuePayload")), [arg("input", nonNull(input("IssueCreateInput")))]),
            field("issueDelete", nonNull(object("DeletePayload")), [arg("id", nonNull(scalar("String")))]),
            field("issueArchive", nonNull(object("ArchivePayload")), [arg("id", nonNull(scalar("String")))]),
            field("issueUnarchive", nonNull(object("ArchivePayload")), [arg("id", nonNull(scalar("String")))]),
          ],
        }),
        type("OBJECT", "Issue", {
          fields: [
            field("id", nonNull(scalar("ID"))),
            field("identifier", nonNull(scalar("String"))),
            field("title", nonNull(scalar("String"))),
            field("description", scalar("String")),
            field("priority", nonNull(scalar("Float"))),
            field("createdAt", nonNull(scalar("DateTime"))),
            field("updatedAt", nonNull(scalar("DateTime"))),
            field("archivedAt", scalar("DateTime")),
            field("state", nonNull(object("WorkflowState"))),
            field("team", nonNull(object("Team"))),
            field("assignee", object("User")),
            field("labels", nonNull(object("IssueLabelConnection")), page),
            field("history", nonNull(object("IssueLabelConnection")), [arg("since", nonNull(scalar("DateTime")))]),
            { ...field("legacyKey", scalar("String")), isDeprecated: true },
          ],
        }),
        type("OBJECT", "WorkflowState", {
          fields: [
            field("id", nonNull(scalar("ID"))),
            field("name", nonNull(scalar("String"))),
            field("type", nonNull(scalar("String"))),
            field("team", nonNull(object("Team"))),
          ],
        }),
        type("OBJECT", "Team", {
          fields: [
            field("id", nonNull(scalar("ID"))),
            field("key", nonNull(scalar("String"))),
            field("name", nonNull(scalar("String"))),
          ],
        }),
        type("OBJECT", "User", {
          fields: [
            field("id", nonNull(scalar("ID"))),
            field("name", nonNull(scalar("String"))),
            field("email", nonNull(scalar("String"))),
            field("active", nonNull(scalar("Boolean"))),
          ],
        }),
        type("OBJECT", "IssueLabel", {
          fields: [field("id", nonNull(scalar("ID"))), field("name", nonNull(scalar("String")))],
        }),
        type("OBJECT", "PageInfo", {
          fields: [field("hasNextPage", nonNull(scalar("Boolean"))), field("endCursor", scalar("String"))],
        }),
        connection("Issue", "Issue"),
        connection("Team", "Team"),
        connection("User", "User"),
        connection("WorkflowState", "WorkflowState"),
        connection("IssueLabel", "IssueLabel"),
        type("OBJECT", "IssuePayload", {
          fields: [field("success", nonNull(scalar("Boolean"))), field("issue", object("Issue"))],
        }),
        type("OBJECT", "DeletePayload", { fields: [field("success", nonNull(scalar("Boolean")))] }),
        type("OBJECT", "ArchivePayload", { fields: [field("success", nonNull(scalar("Boolean")))] }),
        type("UNION", "SearchResult", { possibleTypes: [{ name: "Issue" }, { name: "Team" }] }),
        type("ENUM", "PaginationOrderBy", { enumValues: [{ name: "createdAt" }, { name: "updatedAt" }] }),
        type("INPUT_OBJECT", "IssueFilter", {
          inputFields: [arg("updatedAt", input("DateComparator"))],
        }),
        type("INPUT_OBJECT", "DateComparator", {
          inputFields: [arg("gt", scalar("DateTime")), arg("gte", scalar("DateTime"))],
        }),
        type("INPUT_OBJECT", "IssueCreateInput", {
          inputFields: [
            arg("title", nonNull(scalar("String"))),
            arg("teamId", nonNull(scalar("String"))),
            arg("description", scalar("String")),
            arg("priority", nonNull(scalar("Int")), "0"),
          ],
        }),
        type("OBJECT", "__Schema", { fields: [] }),
      ],
    },
  },
})
