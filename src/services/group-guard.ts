import { CliError } from "@wirecat/cli-base"
import { INTERNAL_NOTES } from "../domain/providers.js"
import type { AppIdentity } from "../ports/app.js"
import { inGroupOf } from "../search/groups.js"
import type { MessageStore } from "../store/store.js"
import type { ProposalRegistry, ProposalRow } from "./proposals/types.js"
import { groupLockOf, listContextOf } from "./search-kind.js"

/** What a run locked to a group may show of things that came through accounts (WC-ACCT-13). */
export interface GroupGuard {
  group: string
  /** Every part of the thing is in the group; the owner's own things, and references the store lacks, pass. */
  visible(ref: string): Promise<boolean>
  /** The references a locked run may show, in order, and how many it may not. */
  keep(refs: readonly (string | null)[]): Promise<{ kept: (string | null)[]; out_of_scope: number }>
  /** A copy with every outside reference taken out of each `evidence` array, at any depth, and their count. */
  strip<T>(value: T): Promise<{ value: T; out_of_scope: number }>
  /** A proposal is its subject's, its object's and, when stored, its action's: all in the group. */
  proposal(row: ProposalRow): Promise<boolean>
}

const refOf = (item: unknown): string | null | undefined =>
  typeof item === "string"
    ? item
    : typeof item === "object" && item !== null && "ref" in item
      ? (item as { ref: string | null }).ref
      : undefined

/** `undefined` without `<PREFIX>_GROUP_LOCK`: an unlocked run shows everything. */
export const groupGuardOf = async (
  store: MessageStore,
  app: AppIdentity,
  env: NodeJS.ProcessEnv,
): Promise<GroupGuard | undefined> => {
  const group = groupLockOf(app, env)
  if (group === undefined) return undefined
  const inGroup = inGroupOf(
    await listContextOf(store, { provider: "notes", account: INTERNAL_NOTES }, app, undefined, env),
    group,
  )
  const visible = async (ref: string) => {
    const ends = await store.refs.ends(ref)
    return ends === undefined || ends.every((end) => end.length === 0 || end.some(inGroup))
  }
  const keep = async (refs: readonly (string | null)[]) => {
    const kept: (string | null)[] = []
    for (const ref of refs) if (ref === null || (await visible(ref))) kept.push(ref)
    return { kept, out_of_scope: refs.length - kept.length }
  }
  const strip = async <T>(value: T): Promise<{ value: T; out_of_scope: number }> => {
    let dropped = 0
    // Only plain objects and arrays are rebuilt, and only where something under them was dropped: a Date or any
    // other value keeps its identity, so a strict answer schema still reads it.
    const plain = (node: object) => {
      const prototype = Object.getPrototypeOf(node)
      return prototype === Object.prototype || prototype === null
    }
    const walk = async (node: unknown, key?: string): Promise<unknown> => {
      if (Array.isArray(node)) {
        const items = await Promise.all(node.map((one) => walk(one)))
        let changed = items.some((one, at) => one !== node[at])
        let shown: unknown[] = items
        if (key === "evidence" || key === "sources") {
          shown = []
          for (const item of items) {
            const ref = refOf(item)
            if (typeof ref === "string" && !(await visible(ref))) {
              dropped += 1
              changed = true
            } else shown.push(item)
          }
        }
        return changed ? shown : node
      }
      if (typeof node !== "object" || node === null || !plain(node)) return node
      let changed = false
      const entries = await Promise.all(
        Object.entries(node).map(async ([name, one]) => {
          const walkedOne = await walk(one, name)
          if (walkedOne !== one) changed = true
          return [name, walkedOne] as const
        }),
      )
      return changed ? { ...node, ...Object.fromEntries(entries) } : node
    }
    const walked = (await walk(value)) as T
    return { value: walked, out_of_scope: dropped }
  }
  const proposal = async (row: ProposalRow) => {
    const stored = /^([1-9]\d*)(\/|$)/.exec(row.id)?.[1]
    const parts = [
      row.subject,
      ...(row.object === null ? [] : [row.object]),
      ...(stored
        ? [`action:${stored}`]
        : row.id.startsWith("link:")
          ? [row.id]
          : row.id.startsWith("key:")
            ? [`link:${row.id.slice(4)}`]
            : []),
    ]
    for (const part of parts) if (!(await visible(part))) return false
    return true
  }
  return { group, visible, keep, strip, proposal }
}

const outside = (guard: GroupGuard, id: string) =>
  new CliError("permission_error", `this process is locked to group ${guard.group} — proposal ${id} is outside it`, {
    group: guard.group,
    reason: "group.outside",
  })

/**
 * The registry a locked run decides through: a proposal outside the group is not listed, not shown and not decided,
 * and the evidence of one it shows keeps only the group's references.
 */
export const lockedRegistry = (registry: ProposalRegistry, guard: GroupGuard): ProposalRegistry => {
  const shown = async (row: ProposalRow): Promise<ProposalRow> => ({
    ...row,
    evidence: (await guard.keep(row.evidence)).kept.filter((ref): ref is string => ref !== null),
  })
  return {
    register: (kind) => registry.register(kind),
    list: async (filter) => {
      const { items, hasMore } = await registry.list(filter)
      const kept: ProposalRow[] = []
      for (const row of items) if (await guard.proposal(row)) kept.push(await shown(row))
      return { items: kept, hasMore }
    },
    get: async (id) => {
      const row = await registry.get(id)
      if (!(await guard.proposal(row))) throw outside(guard, id)
      return shown(row)
    },
    decide: async (ids, decision) => {
      const allowed: string[] = []
      const refused: { id: string; code: "permission_error"; reason: string; message: string }[] = []
      for (const id of ids) {
        const row = await registry.get(id.split("/")[0] as string).catch(() => undefined)
        if (row && !(await guard.proposal(row)))
          refused.push({ id, code: "permission_error", reason: "group.outside", message: outside(guard, id).message })
        else allowed.push(id)
      }
      const decided = allowed.length ? await registry.decide(allowed, decision) : { decided: [], refused: [] }
      return { decided: decided.decided, refused: [...refused, ...decided.refused] }
    },
  }
}
