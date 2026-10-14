import { CliError } from "@wirecat/cli-base"
import { timezoneOf } from "@wirecat/cli-base/query"
import type { RetentionOptions } from "../domain/retention.js"
import type { ServiceDeps } from "./deps.js"
import { storedChatId } from "./message-resolution.js"
import { momentOf } from "./moment.js"

export interface RetentionQuery {
  sinceTime?: string
  untilTime?: string
  checkpoints?: string
  within?: string
  by?: "day" | "week"
  timezone?: string
  limit?: number
}
export const observationDuration = (text: string, flag: string): number => {
  const match = /^(\d+(?:\.\d+)?)([smhdw])$/.exec(text)
  const units: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }
  const value = match ? Number(match[1]) * (units[match[2] ?? ""] ?? 0) : 0
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new CliError("validation_error", `${flag} takes a positive duration such as 24h or 7d`)
  return value
}
export const retentionService = (deps: ServiceDeps) => ({
  report: async (chat: string, query: RetentionQuery = {}) => {
    const cutoff = Date.now()
    const options: RetentionOptions = {
      since: query.sinceTime === undefined ? cutoff - 90 * 86_400_000 : momentOf(query.sinceTime, "--since-time"),
      until: query.untilTime === undefined ? cutoff : momentOf(query.untilTime, "--until-time"),
      cutoff,
      checkpoints: (query.checkpoints ?? "1d,7d,30d")
        .split(",")
        .map((one) => observationDuration(one.trim(), "--checkpoints")),
      within: observationDuration(query.within ?? "7d", "--within"),
      by: query.by ?? "week",
      timezone: timezoneOf(query.timezone),
      limit: query.limit ?? 20,
    }
    const store = await deps.store(),
      account = await deps.account()
    if (!store.retention) throw new CliError("validation_error", "retention requires a newer messaging store")
    const chatId = await storedChatId(deps.messenger, chat, store, account)
    const result = await store.retention(account, chatId, options)
    return {
      ...result,
      items: result.items.map((item) => ({
        ...item,
        drilldown: {
          command: "stats messages evidence",
          arguments: {
            message: item.cohort,
            component: "report",
            selection: { kind: "retention", version: 1, account, chatId, cohort: item.cohort, options },
          },
        },
      })),
      account,
      report: "retention" as const,
    }
  },
  evidence: async (
    target: "messages" | "contacts",
    reference: string,
    selection: unknown,
    query: { component: string; limit: number; cursor?: string; signal?: AbortSignal },
  ) => {
    if (target !== "messages" || query.component !== "report")
      throw new CliError("validation_error", "retention evidence uses stats messages evidence --component report")
    const serialized = typeof selection === "string" ? selection : JSON.stringify(selection)
    if (!serialized || Buffer.byteLength(serialized) > 64 * 1024)
      throw new CliError("validation_error", "retention selection must fit within 64 KiB")
    let raw: {
      kind: string
      version: number
      account: { provider: string; account: string }
      chatId: string
      cohort: string
      options: RetentionOptions
    }
    try {
      raw = JSON.parse(serialized)
    } catch {
      throw new CliError("validation_error", "invalid retention selection")
    }
    const account = await deps.account(),
      store = await deps.store()
    if (
      raw?.kind !== "retention" ||
      raw.version !== 1 ||
      raw.account?.provider !== account.provider ||
      raw.account?.account !== account.account ||
      typeof raw.chatId !== "string" ||
      !raw.chatId ||
      raw.chatId.length > 256 ||
      raw.cohort !== reference ||
      !/^\d{4}-\d{2}-\d{2}$/.test(raw.cohort) ||
      !raw.options ||
      !store.retention
    )
      throw new CliError("validation_error", "invalid or out-of-scope retention selection")
    query.signal?.throwIfAborted()
    const found = await store.retention(
      account,
      raw.chatId,
      { ...raw.options, limit: query.limit },
      { cohort: raw.cohort, ...(query.cursor ? { cursor: query.cursor } : {}) },
    )
    return {
      ...found,
      account,
      items: found.evidence,
      total: found.evidenceTotal,
      included: found.evidence.length,
      hasMore: found.nextCursor !== null,
      component: "report" as const,
    }
  },
})
export type RetentionService = ReturnType<typeof retentionService>

export const isRetentionSelection = (selection: unknown): boolean => {
  try {
    const raw = typeof selection === "string" ? JSON.parse(selection) : selection
    return !!raw && typeof raw === "object" && "kind" in raw && raw.kind === "retention"
  } catch {
    return false
  }
}
