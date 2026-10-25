import { type QueryAst, walkQuery } from "@wirecat/cli-base/query"
import type { MessageStore, Where } from "../store/store.js"

export const taskTagFilters = async (store: MessageStore, query: QueryAst | undefined): Promise<Map<string, Where>> => {
  const tags = new Map<string, Where>()
  for (const node of query ? walkQuery(query.root) : [])
    if (node.field === "tag" && !tags.has(node.value)) tags.set(node.value, await store.tasks.tagWhere(node.value))
  return tags
}
