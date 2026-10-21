import { CliError, singleLine } from "@wirecat/cli-base"
import type { AdminOptions, AdminReport, Answerer } from "../domain/admin-statistics.js"
import { parseLocator } from "../domain/locator.js"
import { isId, pickPerson } from "../resolve.js"
import type { QueryExecution } from "../search/lucene/resolved.js"
import type { AdminStoreResult, MessageStore } from "../store/store.js"
import type { ServiceDeps } from "./deps.js"
import type { SearchQuery } from "./messages.js"
import { prepareLucene, stemExecution } from "./messages-search.js"
import { momentOf } from "./moment.js"
import { type RankingSelection, rankingSelection, readRankingSelection } from "./rankings-selection.js"
import { searchRecordOf } from "./search-record.js"

export type AdminQuery = SearchQuery & {
  answerers?: string[]
  olderThan?: string
  within?: string
  sinceTime?: string
  untilTime?: string
  minViews?: number
  maxReplies?: number
  saved?: string
}
export interface AdminSelection {
  kind: "admin-statistics"
  version: 1
  base: RankingSelection
  options: AdminOptions
  entity: { account: { provider: string; account: string }; id: string }
}
export interface AdminFound extends AdminStoreResult {
  report: AdminReport
  detectorVersion: 1
  items: (AdminStoreResult["items"][number] & {
    drilldown: {
      command: string
      arguments: { person?: string; message?: string; component: "report"; selection: AdminSelection }
    }
  })[]
}
export interface AdminEvidenceFound extends Omit<AdminStoreResult, "items" | "evidence"> {
  items: NonNullable<AdminStoreResult["evidence"]>
  component: "report"
}
export interface AdminStatisticsService {
  report(report: AdminReport, query: AdminQuery): Promise<AdminFound>
  evidence(
    target: "messages" | "contacts",
    reference: string,
    selection: unknown,
    options: { component: string; limit: number; cursor?: string; signal?: AbortSignal },
  ): Promise<AdminEvidenceFound>
}
function invalid(message: string): never {
  throw new CliError("validation_error", message)
}
const duration = (text: string, flag: string): number => {
  if (!/^\d+(?:\.\d+)?[smhdw]$/.test(text)) invalid(`${flag} takes a positive duration such as 4h or 7d`)
  const units: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }
  const value = Number(text.slice(0, -1)) * (units[text.slice(-1)] ?? 0)
  if (!Number.isSafeInteger(value) || value <= 0) invalid(`${flag} takes a positive finite duration`)
  return value
}
const count = (value: number, flag: string): number => {
  if (!Number.isSafeInteger(value) || value < 0) invalid(`${flag} takes a nonnegative integer`)
  return value
}
const answerers = async (
  store: MessageStore,
  refs: string[],
  accounts: QueryExecution["accounts"],
): Promise<Answerer[]> => {
  if (!refs.length) return []
  const lookups = await Promise.all(
    accounts.map(async (account) => ({
      account,
      people: await store.people.people(account.provider, { account: account.account }),
    })),
  )
  const found = refs.map((reference) => {
    const ref = reference.trim()
    if (!ref || ref.length > 256) invalid("answerer requires a nonempty reference of at most 256 characters")
    if (ref.startsWith("person:")) {
      const parts = ref.slice(7).split("/")
      if (parts.length !== 3 || parts.some((part) => !part)) invalid("answerer needs person:<provider>/<account>/<id>")
      let decoded: string[]
      try {
        decoded = parts.map(decodeURIComponent)
      } catch {
        return invalid("invalid answerer encoding")
      }
      const [provider, account, id] = decoded as [string, string, string]
      if (!accounts.some((one) => one.provider === provider && one.account === account))
        invalid("answerer account is outside this query")
      return { provider, account, id }
    }
    if (isId(ref)) {
      if (accounts.length !== 1)
        invalid("bare answerer ids require one scoped account; use person:<provider>/<account>/<id>")
      return { ...(accounts[0] as QueryExecution["accounts"][number]), id: ref }
    }
    const candidates: (Answerer & { name?: string | null; username?: string | null })[] = []
    for (const { account, people } of lookups) {
      try {
        const person = pickPerson(ref, people)
        candidates.push({ ...account, id: person.id, name: person.name, username: person.username })
      } catch (error) {
        if (!(error instanceof CliError)) throw error
        if (error.code === "not_found") continue
        if (error.code !== "validation_error") throw error
        const matches = error.details?.candidates as
          | { id: string; name?: string | null; username?: string | null }[]
          | undefined
        if (!matches) throw error
        candidates.push(...matches.map((person) => ({ ...account, ...person })))
      }
    }
    if (candidates.length === 1) {
      const person = candidates[0] as Answerer
      return { provider: person.provider, account: person.account, id: person.id }
    }
    const recovery =
      "Find the person with contacts show/list or stats contacts top; choose a scoped person:provider/account/id. Never guess an ambiguous identity."
    if (!candidates.length)
      throw new CliError("not_found", `no stored answering identity matches "${singleLine(ref)}". ${recovery}`, {
        reference: ref,
        recovery,
      })
    throw new CliError(
      "validation_error",
      `answerer "${singleLine(ref)}" matches ${candidates.length} identities; choose one by its scoped ID`,
      {
        reference: ref,
        candidates: candidates.slice(0, 100).map((person) => ({
          ...person,
          reference: `person:${[person.provider, person.account, person.id].map(encodeURIComponent).join("/")}`,
        })),
        total: candidates.length,
        recovery,
      },
    )
  })
  return [...new Map(found.map((one) => [JSON.stringify(one), one])).values()]
}
export const isAdminSelection = (selection: unknown): boolean => {
  let raw = selection
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw)
    } catch {
      return false
    }
  }
  return !!raw && typeof raw === "object" && "kind" in raw && raw.kind === "admin-statistics"
}
export const readAdminSelection = async (store: MessageStore, input: unknown) => {
  const encoded = typeof input === "string" ? input : JSON.stringify(input)
  if (!encoded || Buffer.byteLength(encoded) > 64 * 1024) invalid("report selection must fit within 64 KiB")
  let raw: AdminSelection
  try {
    raw = JSON.parse(encoded)
  } catch {
    return invalid("invalid report selection")
  }
  if (
    !raw ||
    typeof raw !== "object" ||
    raw.kind !== "admin-statistics" ||
    raw.version !== 1 ||
    !raw.options ||
    !raw.entity
  )
    invalid("invalid report selection version")
  const base = await readRankingSelection(store, raw.base)
  const o = raw.options
  if (!["unanswered", "responses", "newcomers", "discussion"].includes(o.report) || !Array.isArray(o.answerers))
    invalid("invalid report options")
  for (const key of ["cutoff", "olderThan", "within", "joinSince", "joinUntil", "minViews", "maxReplies"] as const)
    if (
      !Number.isSafeInteger(o[key]) ||
      (["cutoff", "olderThan", "within", "minViews", "maxReplies"].includes(key) && o[key] < 0)
    )
      invalid("invalid report numeric options")
  if (o.within <= 0 || o.olderThan <= 0 || o.joinSince > o.joinUntil || o.cutoff > Date.now())
    invalid("invalid report cutoff or window")
  for (const person of o.answerers) {
    if (
      !person ||
      typeof person.id !== "string" ||
      !person.id ||
      !base.execution.accounts.some((one) => one.provider === person.provider && one.account === person.account)
    )
      invalid("answerer is outside report scope")
  }
  const entity = raw.entity
  if (
    !entity.account ||
    typeof entity.id !== "string" ||
    !base.execution.accounts.some(
      (one) => one.provider === entity.account.provider && one.account === entity.account.account,
    )
  )
    invalid("evidence entity is outside report scope")
  if ((o.report === "responses" && !o.answerers.length) || (o.report === "newcomers" && !base.execution.chat))
    invalid("invalid report scope")
  return { base, options: o, entity }
}

export const adminStatisticsService = (deps: ServiceDeps): AdminStatisticsService => ({
  report: async (report, query) => {
    if (!["unanswered", "responses", "newcomers", "discussion"].includes(report))
      invalid("unknown administrator report")
    if (query.syncFirst || query.newest || query.context)
      invalid("administrator reports read stored strict Lucene selections without sync/newest/context")
    if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > 100) invalid("report limit must be 1–100")
    const cutoff = Date.now(),
      store = await deps.store(),
      account = await deps.account()
    if (report === "newcomers" && (!query.chat || query.text || query.ast))
      invalid("newcomers requires one stored chat and join-date options, without a message query")
    const saved = query.saved === undefined ? undefined : await store.searches.storedSearch(query.saved)
    if (query.saved !== undefined && !saved) invalid("saved administrator report not found")
    if (saved && saved.params.adminReport !== report) invalid("saved report belongs to another report kind")
    const pinned = saved ? await readAdminSelection(store, saved.params.selection) : undefined
    const prepared = pinned
      ? {
          execution: {
            ...pinned.base.execution,
            limit: query.limit,
            ...(query.signal ? { signal: query.signal } : {}),
          } as QueryExecution,
          timezone: pinned.base.timezone,
          selectedChat: pinned.base.contextChat ?? pinned.base.execution.chat,
        }
      : await prepareLucene(store, account, query, deps.messenger)
    if (pinned) await stemExecution(prepared.execution, store)
    if (pinned && query.text?.trim()) {
      const extra = await prepareLucene(
        store,
        account,
        {
          text: query.text,
          accounts: prepared.execution.accounts,
          timezone: prepared.timezone,
          limit: query.limit,
        },
        deps.messenger,
      )
      prepared.execution.root = {
        kind: "boolean",
        span: { start: 0, end: 0 },
        clauses: [
          { occur: "must", node: prepared.execution.root },
          { occur: "must", node: extra.execution.root },
        ],
      }
    }
    if (pinned && query.chat) {
      const explicit = await prepareLucene(
        store,
        account,
        { chat: query.chat, accounts: prepared.execution.accounts, limit: query.limit },
        deps.messenger,
      )
      if (JSON.stringify(explicit.selectedChat) !== JSON.stringify(prepared.selectedChat))
        invalid("a saved report keeps its resolved chat scope")
    }
    if (
      pinned &&
      (query.source || query.ast || query.exact || (query.timezone && query.timezone !== prepared.timezone))
    )
      invalid("a saved report keeps its resolved query, accounts and timezone")
    const options: AdminOptions = {
      report,
      cutoff,
      olderThan:
        query.olderThan === undefined && pinned
          ? pinned.options.olderThan
          : duration(query.olderThan ?? "24h", "--older-than"),
      within: query.within === undefined && pinned ? pinned.options.within : duration(query.within ?? "7d", "--within"),
      joinSince: query.sinceTime
        ? momentOf(query.sinceTime, "--since-time", cutoff, { zone: prepared.timezone })
        : (pinned?.options.joinSince ?? cutoff - 30 * 86_400_000),
      joinUntil: query.untilTime
        ? momentOf(query.untilTime, "--until-time", cutoff, { zone: prepared.timezone, end: true })
        : (pinned?.options.joinUntil ?? cutoff),
      minViews: count(query.minViews ?? pinned?.options.minViews ?? 1, "--min-views"),
      maxReplies: count(query.maxReplies ?? pinned?.options.maxReplies ?? 0, "--max-replies"),
      answerers:
        query.answerers === undefined && pinned
          ? pinned.options.answerers
          : await answerers(store, query.answerers ?? [], prepared.execution.accounts),
    }
    if (!Number.isSafeInteger(options.joinSince) || !Number.isSafeInteger(options.joinUntil))
      invalid("invalid join dates")
    if (options.joinSince > options.joinUntil) invalid("join dates are reversed")
    if (report === "responses" && !options.answerers.length)
      invalid("responses requires at least one --answerer identity")
    const result = await store.queries.adminStatisticsQuery(prepared.execution, { options })
    const known = new Set<string>()
    if (report === "responses")
      for (const person of options.answerers) {
        const people = await store.people.people(person.provider, { account: person.account })
        if (people.get(person.id)) known.add(JSON.stringify([person.provider, person.account, person.id]))
      }
    const firstAccount = prepared.execution.accounts[0]
    if (deps.history !== false && firstAccount) {
      const entity = { account: firstAccount, id: "report" }
      const base = rankingSelection(
        "contacts",
        { measure: "messages" },
        prepared.timezone,
        prepared.execution,
        entity,
        prepared.selectedChat,
      )
      const selection: AdminSelection = { kind: "admin-statistics", version: 1, base, options, entity }
      await store.searches.recordSearch(
        searchRecordOf("admin-statistics", {
          adminReport: report,
          selection,
          timezone: prepared.timezone,
        }),
        saved ? { saved: saved.id } : {},
      )
    }
    return {
      ...result,
      report,
      detectorVersion: 1,
      items: result.items.map((original) => {
        const identityKnown = known.has(
          JSON.stringify([original.account.provider, original.account.account, original.id]),
        )
        const row =
          report === "responses"
            ? { ...original, identityKnown, status: identityKnown ? original.status : ("unknown" as const) }
            : original
        const target = row.message ? "messages" : "contacts"
        const base = rankingSelection(
          target,
          { measure: target === "messages" ? "views" : "messages" },
          prepared.timezone,
          prepared.execution,
          {
            account: row.account,
            id: row.message ? parseLocator(row.message).message : row.id,
            ...(row.chatId ? { chatId: row.chatId } : {}),
          },
          prepared.selectedChat,
        )
        const selection: AdminSelection = {
          kind: "admin-statistics",
          version: 1,
          base,
          options,
          entity: { account: row.account, id: row.id },
        }
        if (Buffer.byteLength(JSON.stringify(selection)) > 64 * 1024)
          invalid("report evidence selection exceeds 64 KiB — narrow query selectors")
        return {
          ...row,
          drilldown: {
            command: `stats ${target} evidence`,
            arguments: {
              ...(row.message ? { message: row.message } : { person: row.id }),
              component: "report" as const,
              selection,
            },
          },
        }
      }),
    }
  },
  evidence: async (target, reference, input, request) => {
    if (request.component !== "report") invalid("administrator evidence component must be report")
    if (!Number.isInteger(request.limit) || request.limit < 1 || request.limit > 100)
      invalid("evidence limit must be 1–100")
    const store = await deps.store()
    const { base, options: o, entity } = await readAdminSelection(store, input)
    if (base.target !== target) invalid("report selection belongs to another evidence target")
    if (
      reference !== entity.id ||
      entity.account.provider !== base.entity.account.provider ||
      entity.account.account !== base.entity.account.account ||
      (target === "contacts" && entity.id !== base.entity.id)
    )
      invalid("report reference does not match its selection")
    if (target === "messages") {
      const locator = parseLocator(reference)
      if (
        locator.provider !== entity.account.provider ||
        locator.account !== entity.account.account ||
        locator.message !== base.entity.id ||
        locator.chat !== base.entity.chatId
      )
        invalid("message reference does not match report scope")
    }
    const execution: QueryExecution = {
      ...base.execution,
      limit: request.limit,
      ...(request.signal ? { signal: request.signal } : {}),
    }
    await stemExecution(execution, store)
    const result = await store.queries.adminStatisticsQuery(execution, {
      options: o,
      evidence: { entity, ...(request.cursor ? { cursor: request.cursor } : {}) },
    })
    const { evidence, ...found } = result
    return { ...found, items: evidence ?? [], component: "report" }
  },
})
