import { CliError } from "@wirecat/cli-base"
import { mayDecide, type Refusal } from "../../store/decisions.js"
import type { MessageStore } from "../../store/store.js"
import { actionKind } from "./kinds/action.js"
import { factKind } from "./kinds/fact.js"
import { invoiceKind, paymentKind } from "./kinds/finance.js"
import { findingsKind } from "./kinds/findings.js"
import { keyDocumentKind } from "./kinds/key-document.js"
import { mailFindingsKind } from "./kinds/mail-findings.js"
import { meetingFindingsKind } from "./kinds/meeting-findings.js"
import { memoryKind } from "./kinds/memory.js"
import { orderKind } from "./kinds/orders.js"
import { relationshipKind } from "./kinds/relationship.js"
import { relationshipUpdateKind } from "./kinds/relationship-update.js"
import { taskCloseKind } from "./kinds/task-close.js"
import type { Decided, ProposalFilter, ProposalKind, ProposalRegistry, ProposalRow } from "./types.js"

const PREFIX = /^([a-z][a-z_]*):/

const marked = (kind: ProposalKind, row: ProposalRow): ProposalRow =>
  kind.ownerOnly ? { ...row, ownerOnly: true } : row

const refusalOf = (id: string, error: unknown): Refusal => {
  if (!(error instanceof CliError)) throw error
  const code = error.code === "not_found" || error.code === "permission_error" ? error.code : "validation_error"
  const reason = (error.details as { reason?: unknown } | undefined)?.reason
  return { id, code, reason: typeof reason === "string" ? reason : code, message: error.message }
}

/** An empty registry: the host registers its kinds. `proposalRegistry` is this with the core kinds. */
export const emptyProposalRegistry = (
  store: Pick<MessageStore, "proposedActions" | "decisionPolicy">,
): ProposalRegistry & { claimed(): string[] } => {
  const policy = store.decisionPolicy
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
      const rows = (
        await Promise.all(asked.map(async (kind) => (await kind.list(wide)).map((row) => marked(kind, row))))
      ).flat()
      rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
      const page = rows.slice(filter.offset, filter.offset + filter.limit + 1)
      return { items: page.slice(0, filter.limit), hasMore: page.length > filter.limit }
    },
    get: async (id) => {
      const kind = await kindOf(id)
      return marked(kind, await kind.get(id))
    },
    decide: async (ids, decision) => {
      const parts = new Map<string, string[]>()
      const whole = new Set<string>()
      const order: string[] = []
      for (const id of ids) {
        const [batch, part] = id.split("/")
        if (!batch) continue
        if (!parts.has(batch)) {
          parts.set(batch, [])
          order.push(batch)
        }
        if (part === undefined) whole.add(batch)
        else parts.get(batch)?.push(part)
      }
      const decided: Decided[] = []
      const refused: Refusal[] = []
      const refuseIds = (id: string, message: string) =>
        refused.push({ id, code: "validation_error", reason: "proposal.ids", message })
      for (const id of order) {
        const chosen = parts.get(id) ?? []
        if (chosen.length && whole.has(id)) {
          refuseIds(id, `name ${id} or some of its parts (${id}/${chosen[0]}), not both`)
          continue
        }
        try {
          const kind = await kindOf(id)
          if (chosen.length && !kind.parts) {
            refuseIds(id, `a ${kind.kind} proposal has no parts; name ${id} alone`)
            continue
          }
          const row = marked(kind, await kind.get(id))
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
/** The policy is the store's, set when it was opened, so the registry and the store methods never disagree. */
export const proposalRegistry = (store: MessageStore): ProposalRegistry => {
  const registry = emptyProposalRegistry(store)
  for (const kind of [
    relationshipKind(store),
    relationshipUpdateKind(store),
    keyDocumentKind(store),
    factKind(store),
    invoiceKind(store),
    paymentKind(store),
    orderKind(store),
    memoryKind(store),
    findingsKind(store),
    mailFindingsKind(store),
    meetingFindingsKind(store),
    taskCloseKind(store),
  ])
    registry.register(kind)
  registry.register(actionKind(store, registry.claimed))
  return registry
}
