import { CliError } from "@wirecat/cli-base"
import type { EventStore } from "../meetings/index.js"
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
