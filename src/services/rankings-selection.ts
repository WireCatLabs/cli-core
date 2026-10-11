import { CliError } from "@wirecat/cli-base"
import { type RankingInput, type RankingTarget, rankingOptions } from "../domain/rankings-options.js"
import { timezoneOf } from "../search/lucene/dates.js"
import { FIELD_VERSION, validateAst } from "../search/lucene/registry.js"
import type { QueryExecution, ResolvedNode } from "../search/lucene/resolved.js"
import type { QueryNode } from "../search/lucene/types.js"
import type { AccountKey, MessageStore } from "../store/store.js"

export interface RankingEntity {
  account: AccountKey
  id: string
  chatId?: string
}
export interface RankingSelection {
  version: 1
  fieldsVersion: number
  target: RankingTarget
  options: RankingInput
  timezone: string
  execution: Pick<QueryExecution, "root" | "accounts" | "chat">
  contextChat?: QueryExecution["chat"]
  entity: RankingEntity
}
export const RANKING_SELECTION_BYTES = 64 * 1024
const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
function invalid(message = "ranking selection is invalid — obtain a new drilldown from stats top"): never {
  throw new CliError("validation_error", message, { reason: "invalid_selection" })
}
const id = (value: unknown): string =>
  typeof value === "string" && value.length > 0 && value.length <= 256 ? value : invalid()
const accountOf = (value: unknown): AccountKey => {
  const fields = object(value)
  return { provider: id(fields?.provider), account: id(fields?.account) }
}
const same = (a: AccountKey, b: AccountKey) => a.provider === b.provider && a.account === b.account
const finiteTime = (value: unknown): number | undefined =>
  value === undefined
    ? undefined
    : typeof value === "number" && Number.isSafeInteger(value) && Math.abs(value) <= 8.64e15
      ? value
      : invalid()

/** Drop transient signal/stemmer objects; the entity is bound to the exact resolved query scope. */
export const rankingSelection = (
  target: RankingTarget,
  options: RankingInput,
  timezone: string,
  execution: QueryExecution,
  entity: RankingEntity,
  contextChat?: QueryExecution["chat"],
): RankingSelection => {
  const selection: RankingSelection = {
    version: 1,
    fieldsVersion: FIELD_VERSION,
    target,
    options,
    timezone,
    execution: {
      root: execution.root,
      accounts: execution.accounts,
      ...(execution.chat ? { chat: execution.chat } : {}),
    },
    entity,
    ...(contextChat ? { contextChat } : {}),
  }
  if (Buffer.byteLength(JSON.stringify(selection)) > RANKING_SELECTION_BYTES)
    invalid("resolved ranking selection exceeds 64 KiB — use fewer query selectors")
  return selection
}

/** Revalidate syntax, scoped resolutions and held accounts; a selector is never authority. */
export const readRankingSelection = async (store: MessageStore, input: unknown): Promise<RankingSelection> => {
  let raw: unknown = input
  const serialized = typeof input === "string" ? input : JSON.stringify(input)
  if (serialized === undefined || Buffer.byteLength(serialized) > RANKING_SELECTION_BYTES)
    invalid("ranking selection must fit within 64 KiB")
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw)
    } catch {
      invalid()
    }
  }
  const fields = object(raw)
  if (
    fields?.version !== 1 ||
    fields.fieldsVersion !== FIELD_VERSION ||
    typeof fields.target !== "string" ||
    !["messages", "contacts"].includes(fields.target)
  )
    invalid()
  const execution = object(fields.execution)
  if (!execution || !Array.isArray(execution.accounts) || execution.accounts.length === 0) invalid()
  const accounts = execution.accounts.map(accountOf)
  const held = await store.accounts()
  if (accounts.some((account) => !held.some((candidate) => same(candidate, account))))
    throw new CliError("permission_error", "ranking selection names an account not held in this store", {
      reason: "selection_scope",
    })
  const scopedChat = (value: unknown): NonNullable<QueryExecution["chat"]> => {
    const chat = object(value)
    const account = accountOf(chat?.account)
    if (!accounts.some((candidate) => same(candidate, account))) invalid()
    return { account, chatId: id(chat?.chatId) }
  }
  const checkShape = (value: unknown, depth = 0): void => {
    if (depth > 32) invalid()
    const node = object(value)
    if (!node) invalid()
    if (node.kind === "boolean") {
      if (!Array.isArray(node.clauses)) invalid()
      for (const clause of node.clauses) {
        const fields = object(clause)
        if (!fields || typeof fields.occur !== "string") invalid()
        checkShape(fields.node, depth + 1)
      }
    } else if (typeof node.operator !== "string") invalid()
  }
  checkShape(execution.root)
  const ast = validateAst({ version: 1, language: "lucene-v1", root: execution.root })
  const bind = (node: QueryNode, value: unknown): ResolvedNode => {
    const rawNode = object(value)
    if (node.kind === "boolean") {
      const clauses = rawNode?.clauses
      if (!Array.isArray(clauses)) invalid()
      return {
        ...node,
        clauses: node.clauses.map((clause, index) => ({
          ...clause,
          node: bind(clause.node, object(clauses[index])?.node),
        })),
      }
    }
    const resolution = object(rawNode?.resolution)
    if (node.field === "chat") return { ...node, resolution: { chat: scopedChat(resolution?.chat) } }
    if (node.field === "from") {
      if (resolution?.outgoing === true) return { ...node, resolution: { outgoing: true } }
      const sender = object(resolution?.sender)
      const provider = id(sender?.provider)
      if (!accounts.some((account) => account.provider === provider)) invalid()
      return { ...node, resolution: { sender: { provider, id: id(sender?.id) } } }
    }
    if (node.field === "date") {
      const range = object(resolution?.date)
      if (!range || typeof range.lowerInclusive !== "boolean" || typeof range.upperInclusive !== "boolean") invalid()
      const lower = finiteTime(range.lower),
        upper = finiteTime(range.upper)
      return {
        ...node,
        resolution: {
          date: {
            lowerInclusive: range.lowerInclusive,
            upperInclusive: range.upperInclusive,
            ...(lower === undefined ? {} : { lower }),
            ...(upper === undefined ? {} : { upper }),
          },
        },
      }
    }
    return node
  }
  const entity = object(fields.entity)
  const entityAccount = accountOf(entity?.account)
  if (!accounts.some((account) => same(account, entityAccount))) invalid()
  const target = fields.target as RankingTarget
  const supplied = object(fields.options)
  if (
    !supplied ||
    Object.keys(supplied).some((key) => !["measure", "score", "weights", "minMessages", "messageKind"].includes(key))
  )
    invalid()
  if (
    ["measure", "score", "messageKind"].some((key) => supplied[key] !== undefined && typeof supplied[key] !== "string")
  )
    invalid()
  if (supplied.minMessages !== undefined && typeof supplied.minMessages !== "number") invalid()
  const options: RankingInput = {
    ...(supplied.measure === undefined ? {} : { measure: supplied.measure as string }),
    ...(supplied.score === undefined ? {} : { score: supplied.score as string }),
    ...(supplied.weights === undefined ? {} : { weights: supplied.weights }),
    ...(supplied.minMessages === undefined ? {} : { minMessages: supplied.minMessages as number }),
    ...(supplied.messageKind === undefined ? {} : { messageKind: supplied.messageKind as string }),
  }
  rankingOptions(target, options)
  return {
    version: 1,
    fieldsVersion: FIELD_VERSION,
    target,
    options,
    timezone: timezoneOf(id(fields.timezone)),
    execution: {
      root: bind(ast.root, execution.root),
      accounts,
      ...(execution.chat === undefined ? {} : { chat: scopedChat(execution.chat) }),
    },
    ...(fields.contextChat === undefined ? {} : { contextChat: scopedChat(fields.contextChat) }),
    entity: {
      account: entityAccount,
      id: id(entity?.id),
      ...(target === "messages" ? { chatId: id(entity?.chatId) } : {}),
    },
  }
}
