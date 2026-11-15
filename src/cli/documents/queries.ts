import {
  parseLucene,
  type QueryNode,
  type QueryRegistry,
  queryError,
  queryFieldsOf,
  validateQuery,
} from "@wirecat/cli-base/query"
import type { Command } from "commander"
import * as v from "valibot"
import { FACT_STATUSES, FACT_TYPES, MEMORY_KINDS, MEMORY_SCOPES, MEMORY_STATUSES } from "../../domain/knowledge.js"
import { note } from "../../entities/note.js"
import type { Fact, Memory } from "../../store/index.js"
import { answerEntity } from "../answer-entity.js"
import {
  LIST_QUERY_GUIDE,
  nativeField,
  type QueryWords,
  queryTerms,
  termField,
  typedQuery,
  withQuery,
} from "../list-query.js"

const registry = (
  entity: string,
  schema: v.GenericSchema,
  native: string[],
  examples: Record<string, string>,
): QueryRegistry => ({
  entity,
  backend: "native",
  fields: queryFieldsOf(schema, { native, examples }).map((field) =>
    field.native ? { ...field, operators: ["term", "phrase"] } : field,
  ),
})

export const folderRow = v.strictObject({ id: v.string() })
export const mirrorRow = v.strictObject({ id: v.string(), path: v.string(), folder: v.string() })
export const tagRow = v.strictObject({ tag: v.string() })
export const linkRow = v.looseObject({
  id: v.string(),
  from: v.string(),
  to: v.nullable(v.string()),
  kind: v.string(),
  role: v.nullable(v.string()),
  confirmed: v.boolean(),
  origin: v.picklist(["file", "owner", "suggested", "message"]),
})
/** Who a document names, in every documents CLI: the provider's id of the account, the provider, and the person. */
export const IDENTITY_ROLES = ["owner", "last-editor"] as const
export const identityRow = v.looseObject({
  remote_id: v.nullable(v.string()),
  provider: v.string(),
  role: v.picklist(IDENTITY_ROLES),
  person: v.nullable(v.record(v.string(), v.unknown())),
})

/** The list queries of the shared documents commands: the same entities in every documents CLI. */
export const documentQueries = () => {
  return {
    folders: registry("selected_folder", folderRow, ["id"], { id: "id:FOLDER_ID" }),
    mirrors: registry("mirror", mirrorRow, ["id", "path", "folder"], {
      id: "id:example",
      path: 'path:"/example/notes"',
      folder: "folder:FOLDER_ID",
    }),
    tags: registry("document_tag", tagRow, ["tag"], { tag: "tag:budget" }),
    notes: registry("note", note, ["text"], { text: "text:review" }),
    links: registry("document_relationship", linkRow, ["id", "role", "origin", "confirmed"], {
      id: "id:1",
      role: "role:reviewer",
      origin: "origin:owner",
      confirmed: "confirmed:true",
    }),
    identities: registry("document_identity", identityRow, ["remote_id", "role"], {
      remote_id: "remote_id:example",
      role: "role:owner",
    }),
  }
}

export const bindQuery = (command: Command, query: QueryRegistry, schema: v.GenericSchema) =>
  answerEntity(withQuery(command, query), query.entity, schema)

export const termsOf = (words: string[], query: QueryRegistry, command: string) =>
  Object.fromEntries(queryTerms(words, query, command))

export const FACT_QUERY = {
  entity: "fact",
  backend: "native",
  fields: [
    termField("kind", "enum", "kind:decision", { values: FACT_TYPES }),
    termField("status", "enum", "status:proposed", { values: FACT_STATUSES }),
  ],
} as const satisfies QueryRegistry

export const MEMORY_QUERY = {
  entity: "memory",
  backend: "native",
  fields: [
    termField("kind", "enum", "kind:preference", { values: MEMORY_KINDS }),
    termField("status", "enum", "status:proposed", { values: MEMORY_STATUSES }),
    termField("scope", "enum", "scope:work", { values: MEMORY_SCOPES }),
  ],
} as const satisfies QueryRegistry

export const MEMORY_SEARCH_QUERY = {
  entity: "memory",
  backend: "native",
  fields: [
    nativeField({
      name: "text",
      type: "txt",
      operators: ["term", "phrase"],
      example: "text:reviews",
      relation: "words of the memory; a bare word means the same",
    }),
    termField("scope", "enum", "scope:work", { values: MEMORY_SCOPES }),
  ],
} as const satisfies QueryRegistry

/** A fact as cli-core's `fact` entity. */
export const factItem = ({ type, statement, source, confirmedBy, ...fact }: Fact) => ({
  ref: fact.ref,
  id: fact.id,
  kind: type,
  text: statement,
  status: fact.status,
  project: fact.project,
  subject: fact.subject,
  occurred_at: fact.occurredAt,
  supersedes: fact.supersedes,
  author: fact.author,
  model: fact.model,
  confirmed_by: confirmedBy,
  scope: fact.scope,
  origin: source,
  evidence: fact.evidence,
  created_at: fact.createdAt,
  updated_at: fact.updatedAt,
})

/** A memory as cli-core's `memory` entity. */
export const memoryItem = ({ body, ...memory }: Memory) => ({
  ref: memory.ref,
  id: memory.id,
  kind: memory.kind,
  text: body,
  subject: memory.subject,
  author: memory.author,
  model: memory.model,
  confidence: memory.confidence,
  status: memory.status,
  scope: memory.scope,
  supersedes: memory.supersedes,
  evidence: memory.evidence,
  last_verified_at: memory.lastVerifiedAt,
  created_at: memory.createdAt,
  updated_at: memory.updatedAt,
})

/**
 * `memories search`'s words and its `scope:` term: the store searches the words and filters the scope in one
 * query. Bare words are text, so they may repeat; everything is joined by AND.
 */
export const memorySearch = (words: QueryWords): { text: string; scope?: Memory["scope"] } => {
  const command = "memories search"
  const context = { command, guide: LIST_QUERY_GUIDE }
  const ast = validateQuery(
    parseLucene(typedQuery(words), { defaultField: "text", ...context }),
    MEMORY_SEARCH_QUERY,
    context,
  )
  const text: string[] = []
  let scope: Memory["scope"] | undefined
  const add = (node: QueryNode) => {
    if (node.kind === "boolean") {
      for (const clause of node.clauses) {
        if (clause.occur !== "must")
          queryError("query.unsupported-placement", clause.node.span, "this search joins its terms by AND", context)
        add(clause.node)
      }
      return
    }
    if (node.field === "text") text.push(node.value)
    else if (scope !== undefined) queryError("query.unsupported-placement", node.span, "scope only once here", context)
    else scope = node.value.toLowerCase() as Memory["scope"]
  }
  add(ast.root)
  if (text.length === 0)
    queryError("query.missing-value", ast.root.span, "say which words to look for beside scope:", context)
  return { text: text.join(" "), ...(scope === undefined ? {} : { scope }) }
}
