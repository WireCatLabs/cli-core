import { defineQuery, type QueryAst, validateQuery } from "@wirecat/cli-base/query"
import { normalizeTag } from "../../domain/tags.js"
import type { CacheDatabase } from "../driver.js"
import type { Note } from "./notes.js"
import { type ColumnMap, queryFilter, type Where } from "./query-filter.js"
import { canonicalTagNamed } from "./tags.js"
import { thingOf } from "./things.js"

/** `documents list [query...]`: one account's imported documents, narrowed by the store. */
export const IMPORTED_DOCUMENT_QUERY = defineQuery({
  entity: "document",
  backend: "sql",
  fields: [
    { name: "tag", type: "kw", operators: ["term", "phrase"], example: "tag:budget", relation: "a local owner tag" },
    {
      name: "person",
      type: "kw",
      operators: ["term", "phrase"],
      example: "person:PERSON_UID",
      relation: "a person the document is linked to, by uid or person:<uid>",
    },
  ],
})

export interface ImportedDocuments {
  /**
   * The documents imported into one notes folder, in import order: a catalog-only entry (a folder, a file not
   * read) is not one. `query` is parsed against `IMPORTED_DOCUMENT_QUERY`.
   */
  importedDocuments(
    folderId: string,
    query: QueryAst | undefined,
    page: { limit: number; offset: number },
  ): Promise<{ items: Note[]; hasMore: boolean }>
}

/** The `WHERE` an `IMPORTED_DOCUMENT_QUERY` compiles to, over `documents d`. */
export const importedDocumentWhere = (database: CacheDatabase, query: QueryAst): Where => {
  const tag = (name: string) => canonicalTagNamed(database, name)?.name ?? normalizeTag(name)
  const person = (value: string) => {
    try {
      return thingOf(database, value.startsWith("person:") ? value : `person:${value}`)
    } catch {
      return undefined
    }
  }
  const columns: ColumnMap = {
    tag: {
      where: (node) => ({
        sql:
          "EXISTS (SELECT 1 FROM taggings g JOIN tags t ON t.id = g.tag_id " +
          "WHERE g.taggable_type = 'document' AND g.taggable_id = d.id AND t.name = ?)",
        params: [tag(node.value)],
      }),
    },
    person: {
      where: (node) => {
        const found = person(node.value)
        if (!found) return { sql: "0", params: [] }
        return {
          sql:
            "EXISTS (SELECT 1 FROM links l WHERE l.from_type = 'document' AND l.from_id = d.id " +
            "AND l.to_type = ? AND l.to_id = ?)",
          params: [found.type, found.id],
        }
      },
    },
  }
  return queryFilter(validateQuery(query, IMPORTED_DOCUMENT_QUERY), columns)
}
