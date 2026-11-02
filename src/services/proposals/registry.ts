import { CliError } from "@wirecat/cli-base"
import { type DecisionPolicy, mayDecide, type Refusal } from "../../store/decisions.js"
import type { MessageStore } from "../../store/store.js"
import { actionKind } from "./kinds/action.js"
import { factKind } from "./kinds/fact.js"
import { findingsKind } from "./kinds/findings.js"
import { keyDocumentKind } from "./kinds/key-document.js"
import { memoryKind } from "./kinds/memory.js"
import { relationshipKind } from "./kinds/relationship.js"
import type { Decided, ProposalFilter, ProposalKind, ProposalRegistry, ProposalRow } from "./types.js"

const PREFIX = /^([a-z][a-z_]*):/

const refusalOf = (id: string, error: unknown): Refusal => {
  if (!(error instanceof CliError)) throw error
  const code = error.code === "not_found" || error.code === "permission_error" ? error.code : "validation_error"
  const reason = (error.details as { reason?: unknown } | undefined)?.reason
  return { id, code, reason: typeof reason === "string" ? reason : code, message: error.message }
}

/** An empty registry: the host registers its kinds. `proposalRegistry` is this with the core kinds. */
export const emptyProposalRegistry = (
  store: Pick<MessageStore, "proposedActions">,
  policy: DecisionPolicy,
): ProposalRegistry & { claimed(): string[] } => {
  const kinds: ProposalKind[] = []
  const claimed = () => kinds.flatMap((kind) => kind.stored ?? [])

  const kindOf = async (id: string): Promise<ProposalKind> => {
    const prefix = PREFIX.exec(id)?.[1]
    const found =
      prefix !== undefined
        ? kinds.find((kind) => kind.prefix === prefix)
        : await (async () => {
            const stored = (await store.proposedActions.get(id)).kind
            return (
              kinds.find((kind) => kind.stored?.includes(stored)) ??
              kinds.find((kind) => kind.prefix === undefined && kind.stored === undefined)
            )
          })()
    if (!found) throw new CliError("not_found", `no proposal ${id}`, { reason: "proposal.unknown-kind" })
    return found
  }

  const registry: ProposalRegistry & { claimed(): string[] } = {
    claimed,
    register: (kind) => {
      if (kinds.some((one) => one.kind === kind.kind))
        throw new CliError("configuration_error", `proposal kind ${kind.kind} is registered twice`)
      if (kind.prefix !== undefined && kinds.some((one) => one.prefix === kind.prefix))
        throw new CliError("configuration_error", `proposal prefix ${kind.prefix} is registered twice`)
      kinds.push(kind)
    },
    list: async (filter) => {
      if (!Number.isSafeInteger(filter.limit) || filter.limit < 1 || filter.limit > 50)
        throw new CliError("validation_error", "a proposal list takes 1–50 items")
      if (!Number.isSafeInteger(filter.offset) || filter.offset < 0)
        throw new CliError("validation_error", "a proposal list takes a nonnegative offset")
      const asked = filter.kinds === undefined ? kinds : kinds.filter((kind) => filter.kinds?.includes(kind.kind))
      const wide: ProposalFilter = { ...filter, offset: 0, limit: filter.offset + filter.limit + 1 }
      const rows = (await Promise.all(asked.map((kind) => kind.list(wide)))).flat()
      rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
      const page = rows.slice(filter.offset, filter.offset + filter.limit + 1)
      return { items: page.slice(0, filter.limit), hasMore: page.length > filter.limit }
    },
    get: async (id) => (await kindOf(id)).get(id),
    decide: async (ids, decision) => {
      const parts = new Map<string, string[]>()
      const order: string[] = []
      for (const id of ids) {
        const [batch, part] = id.split("/")
        if (!batch) continue
        if (!parts.has(batch)) {
          parts.set(batch, [])
          order.push(batch)
        }
        if (part !== undefined) parts.get(batch)?.push(part)
      }
      const decided: Decided[] = []
      const refused: Refusal[] = []
      for (const id of order) {
        try {
          const kind = await kindOf(id)
          const row: ProposalRow = await kind.get(id)
          if (row.status !== "proposed") {
            refused.push({
              id,
              code: "validation_error",
              reason: "proposal.wrong-state",
              message: `${id} is already ${row.status}`,
            })
            continue
          }
          const refusal = mayDecide(row, decision.by, policy)
          if (refusal) {
            refused.push(refusal)
            continue
          }
          const chosen = parts.get(id) ?? []
          decided.push(await kind.decide(id, chosen.length ? { ...decision, parts: chosen } : decision))
        } catch (error) {
          refused.push(refusalOf(id, error))
        }
      }
      return { decided, refused }
    },
  }
  return registry
}

/** Every proposal kind core knows, behind one check of who may decide. */
export const proposalRegistry = (store: MessageStore, policy: DecisionPolicy): ProposalRegistry => {
  const registry = emptyProposalRegistry(store, policy)
  for (const kind of [
    relationshipKind(store),
    keyDocumentKind(store),
    factKind(store),
    memoryKind(store),
    findingsKind(store),
  ])
    registry.register(kind)
  registry.register(actionKind(store, registry.claimed))
  return registry
}
