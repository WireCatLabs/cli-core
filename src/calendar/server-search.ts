import { CliError } from "@wirecat/cli-base"
import type { EventStore } from "../meetings/index.js"
import type { EventsFound, FoundEvent } from "../services/events-search.js"
import type { AccountKey } from "../store/store.js"
import type { CalendarSource } from "./source.js"

const iso = (at: number | null | undefined) => (at == null ? null : new Date(at).toISOString())

/**
 * The provider's own search over the calendars the account syncs, earliest first, stored nowhere. A calendar the owner
 * does not sync stays out: he chose which calendars the CLI reads.
 */
export const serverSearchAnswer = async (
  source: CalendarSource,
  store: EventStore,
  { accountId, account, query, limit }: { accountId: number; account: AccountKey; query: string; limit: number },
) => {
  if (!source.search) throw new CliError("configuration_error", "this calendar provider has no search of its own")
  const calendars = (await store.calendars(accountId)).filter(({ synced, deletedAt }) => synced && deletedAt === null)
  if (calendars.length === 0)
    throw new CliError("validation_error", "no calendar syncs yet; run sync, or calendars sync <calendar>", {
      reason: "search.no-calendars",
    })
  const hits = []
  let more = false
  for (const calendar of calendars) {
    const page = await source.search(calendar, { query, limit })
    more ||= page.more
    for (const entry of page.entries) {
      if (entry.status === "cancelled") continue
      hits.push({
        provider: source.provider,
        account: account.account,
        calendar: calendar.externalId,
        external_id: entry.externalId,
        title: entry.title ?? null,
        starts_at: iso(entry.startsAt),
        ends_at: iso(entry.endsAt),
        all_day: entry.allDay === true,
        status: entry.status,
        location: entry.location ?? null,
        ...(entry.url ? { url: entry.url } : {}),
        found_by: ["server" as const],
      })
    }
  }
  hits.sort((a, b) => (a.starts_at ?? "").localeCompare(b.starts_at ?? ""))
  return { query, by: "server" as const, hits: hits.slice(0, limit), has_more: more || hits.length > limit }
}

type FoundBy = FoundEvent["found_by"][number] | "server"
type ServerFound = Awaited<ReturnType<typeof serverSearchAnswer>>

/**
 * `--backend both`: the stored search's hits in its own order, each one the provider also found marked `server`, then
 * what only the provider found, earliest first. One page and no cursor: the two sides rank and page differently.
 * A provider hit is matched by its stored copy, so an occurrence the store keeps under another id shows twice.
 */
export const bothSearchAnswer = async (
  store: EventStore,
  accountId: number,
  archived: EventsFound,
  served: ServerFound,
  limit: number,
) => {
  const calendars = new Map((await store.calendars(accountId)).map((calendar) => [calendar.externalId, calendar]))
  const hits: (Omit<FoundEvent, "found_by"> & { found_by: FoundBy[] })[] = archived.hits.map((hit) => ({ ...hit }))
  const byRef = new Map(hits.map((hit) => [hit.ref, hit]))
  const onlyServer: ServerFound["hits"] = []
  for (const hit of served.hits) {
    const calendar = calendars.get(hit.calendar)
    const entry = calendar ? await store.entry(calendar.id, hit.external_id) : null
    const held = entry?.eventId == null ? undefined : byRef.get(`event:${entry.eventId}`)
    if (held) held.found_by = [...held.found_by, "server"]
    else onlyServer.push(hit)
  }
  const merged = [...hits, ...onlyServer]
  return {
    query: archived.query,
    by: "both" as const,
    ...(archived.meaning_skipped === undefined ? {} : { meaning_skipped: archived.meaning_skipped }),
    hits: merged.slice(0, limit),
    has_more: archived.has_more || served.has_more || merged.length > limit,
  }
}
