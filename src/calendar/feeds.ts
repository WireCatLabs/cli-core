import { createHash, randomBytes } from "node:crypto"
import { CliError, isCliError } from "@wirecat/cli-base"
import { zonedMoment } from "@wirecat/cli-base/query"
import { runBudget } from "../background/budget.js"
import type { CalendarInput, EntryInput, EventStore, StoredCalendar } from "../meetings/index.js"
import { calendarText, joinUrlWithoutQuery } from "../meetings/index.js"
import { expandSeries, unexpandable } from "./expand.js"
import { type IcsEvent, type IcsOverride, readIcs } from "./ics.js"
import type { CalendarExpander, CalendarSource, SyncWindow } from "./source.js"
import { type CalendarSyncOptions, type CalendarSyncReport, syncCalendars } from "./sync.js"

/** A feed's calendar id: `ics:` and a random id, never the address or anything made from it. */
export const FEED_PREFIX = "ics:"

export const isFeedCalendar = (calendar: Pick<StoredCalendar, "externalId">): boolean =>
  calendar.externalId.startsWith(FEED_PREFIX)

/** One feed the profile follows. `url` may hold a private token: it is a secret, kept as one and never printed. */
export interface FeedRecord {
  id: string
  url: string
  /** The owner's `--title`, or the feed's own name when he gave none. */
  title: string | null
}

/** Where the profile's feeds are kept: the keyring, or a 0600 file, as the CLI keeps its other secrets. */
export interface FeedRegistry {
  read(): Promise<FeedRecord[]>
  write(feeds: FeedRecord[]): Promise<void>
}

export interface FeedLimits {
  /** Decoded bytes, so a compressed answer cannot grow past it. */
  maxBytes: number
  timeoutMs: number
  redirects: number
}

export const FEED_LIMITS: FeedLimits = { maxBytes: 10 * 1024 * 1024, timeoutMs: 30_000, redirects: 5 }

export interface FeedSyncStats {
  calendarId: number
  events: number
  skipped: number
}

/** The profile's iCalendar feeds: a source the engine expands locally, and how one is added and forgotten. */
export interface CalendarFeeds {
  readonly source: CalendarSource
  readonly expand: CalendarExpander
  /** Reads the feed once to check it, then keeps its address. */
  add(url: string, options?: { title?: string }): Promise<{ calendar: CalendarInput; events: number }>
  /** Forgets the feed's address; its stored events are the caller's to drop. */
  remove(externalId: string): Promise<void>
  /** What the last sync read from each feed, and how many of its events it could not take. */
  stats(): FeedSyncStats[]
}

const invalidAddress = (why: string) =>
  new CliError("validation_error", `the feed address ${why}`, { reason: "feed.address-invalid" })

/** `webcal://` is `https://`: calendar apps write it so a click opens them, and the feed itself is served over https. */
export const feedAddress = (text: string): URL => {
  let url: URL
  try {
    url = new URL(text.trim().replace(/^webcals?:\/\//iu, "https://"))
  } catch {
    throw invalidAddress("is not a URL; give the feed's https:// or webcal:// address")
  }
  if (url.protocol !== "https:" && url.protocol !== "http:")
    throw invalidAddress("must start with https://, http:// or webcal://")
  if (url.username || url.password) throw invalidAddress("must not hold a user name or a password")
  return url
}

const sameAddress = (a: string, b: string) => feedAddress(a).href === feedAddress(b).href

export interface FetchFeedOptions {
  /** Names the feed in errors; the address never appears in one. */
  name: string
  fetch?: typeof fetch
  signal?: AbortSignal
  limits?: FeedLimits
}

const readBody = async (response: Response, name: string, maxBytes: number) => {
  const reader = response.body?.getReader()
  if (!reader) return ""
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > maxBytes) {
      await reader.cancel()
      throw new CliError("validation_error", `${name} is larger than ${Math.round(maxBytes / 1024 / 1024)} MB`, {
        reason: "feed.too-large",
      })
    }
    chunks.push(value)
  }
  return new TextDecoder("utf-8").decode(Buffer.concat(chunks))
}

const STATUS_ERRORS: Record<number, [code: "authentication_error" | "permission_error" | "not_found", reason: string]> =
  {
    401: ["authentication_error", "feed.refused"],
    403: ["permission_error", "feed.refused"],
    404: ["not_found", "feed.gone"],
    410: ["not_found", "feed.gone"],
  }

/**
 * The feed's text: http or https, each redirect followed by hand and only to https, the body cut off at its limit and
 * the request at its time. Errors name the feed and the status, never the address, which may hold a token.
 */
export const fetchFeed = async (address: string, options: FetchFeedOptions): Promise<string> => {
  const { name, limits = FEED_LIMITS } = options
  const run = options.fetch ?? fetch
  const timeout = AbortSignal.timeout(limits.timeoutMs)
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
  let url = feedAddress(address)
  try {
    for (let hop = 0; ; hop++) {
      const response = await run(url, {
        redirect: "manual",
        signal,
        headers: { accept: "text/calendar, text/plain;q=0.5, */*;q=0.1" },
      })
      const location = response.headers.get("location")
      if (response.status >= 300 && response.status < 400 && location) {
        await response.body?.cancel()
        if (hop >= limits.redirects)
          throw new CliError("provider_error", `${name} sent the request on more than ${limits.redirects} times`, {
            reason: "feed.refused",
          })
        const next = new URL(location, url)
        if (next.protocol !== "https:")
          throw new CliError("validation_error", `${name} sent the request on to an address that is not https`, {
            reason: "feed.redirect-refused",
          })
        url = next
        continue
      }
      if (!response.ok) {
        await response.body?.cancel()
        const [code, reason] = STATUS_ERRORS[response.status] ?? ["provider_error", "feed.refused"]
        throw new CliError(code, `${name} answered HTTP ${response.status}`, {
          reason,
          status: response.status,
          retryable: response.status >= 500 || response.status === 429,
        })
      }
      return await readBody(response, name, limits.maxBytes)
    }
  } catch (error) {
    if (isCliError(error)) throw error
    if (options.signal?.aborted) throw new CliError("cancelled", `reading ${name} was cancelled`)
    if (timeout.aborted)
      throw new CliError("timeout", `${name} did not answer within ${Math.round(limits.timeoutMs / 1000)} s`, {
        reason: "feed.timeout",
        retryable: true,
      })
    // The cause's code only: a fetch error's message may quote the address.
    const cause = (error as { cause?: { code?: unknown } }).cause?.code
    throw new CliError(
      "network_error",
      `${name} could not be reached${typeof cause === "string" ? ` (${cause})` : ""}`,
      {
        reason: "feed.unreachable",
        retryable: true,
      },
    )
  }
}

const SPAN = { start: 0, end: 0 }

const firstLink = (text: string | null | undefined) => text?.match(/https?:\/\/[^\s<>"')\]]+/iu)?.[0]

/** One feed event in the neutral words, its text cleaned as an invitation's is: feed text is somebody else's. */
export const feedEntry = (event: IcsEvent, zone: string): EntryInput => {
  const allDay = event.startDate !== undefined
  const timezone = allDay ? zone : (event.timezone ?? null)
  const recurrence = event.recurrence?.length ? event.recurrence : null
  return {
    externalId: event.uid,
    kind: recurrence ? "series" : "single",
    icalUid: event.uid,
    status: event.status ?? "confirmed",
    title: calendarText(event.title, { dropSecretLines: false }),
    description: calendarText(event.description),
    location: calendarText(event.location),
    startsAt: allDay ? zonedMoment(event.startDate as string, zone, SPAN) : (event.startsAt ?? null),
    endsAt: allDay ? zonedMoment(event.endDate as string, zone, SPAN) : (event.endsAt ?? null),
    allDay,
    startDate: event.startDate ?? null,
    endDate: event.endDate ?? null,
    timezone,
    recurrence,
    eventType: "default",
    transparency: event.transparency ?? null,
    visibility: null,
    ownResponse: null,
    organizer: event.organizer ? { email: event.organizer.email, name: event.organizer.name ?? null } : null,
    participants: (event.attendees ?? []).map((one) => ({
      email: one.email,
      name: one.name ?? null,
      response: one.response ?? null,
      ...(one.optional ? { optional: true } : {}),
    })),
    joinUrl: joinUrlWithoutQuery(firstLink(event.location) ?? firstLink(event.description)),
    conference: null,
    url: event.url ?? null,
    sequence: null,
    // The engine keeps a series' slots as they are while its version stays the same.
    etag: createHash("sha256").update(JSON.stringify(event)).digest("hex").slice(0, 32),
    externalUpdatedAt: null,
    metadata: null,
    attachments: [],
  }
}

const inWindow = (entry: EntryInput, window: SyncWindow) =>
  entry.startsAt != null &&
  entry.startsAt < window.to &&
  (entry.kind === "series" || Math.max(entry.endsAt ?? entry.startsAt, entry.startsAt + 1) > window.from)

const zoneOk = (zone: string | undefined): zone is string => {
  if (!zone) return false
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone })
    return true
  } catch {
    return false
  }
}

/** `X-WR-TIMEZONE`: the zone a feed's floating times are written in, when it names one. */
const feedZone = (text: string) => /^X-WR-TIMEZONE:(.+)$/imu.exec(text)?.[1]?.trim()

export interface FeedRead {
  entries: EntryInput[]
  overrides: Map<string, (EntryInput & { originalStartsAt: number })[]>
  name: string | null
  timezone: string | null
  events: number
  skipped: number
}

/** A feed's events inside the window, its series with their overrides, and what it could not take. */
export const readFeed = (text: string, zone: string, window?: SyncWindow): FeedRead => {
  const named = feedZone(text)
  const where = zoneOk(named) ? named : zone
  const read = readIcs(text, where, { overrides: true })
  let skipped = read.skipped.length
  const entries: EntryInput[] = []
  for (const event of read.events) {
    const entry = feedEntry(event, where)
    if (entry.kind === "series" && unexpandable(entry.recurrence) !== null) {
      skipped++
      continue
    }
    if (!window || inWindow(entry, window)) entries.push(entry)
  }
  const series = new Set(entries.filter((one) => one.kind === "series").map((one) => one.externalId))
  const inFeed = new Set(read.events.map((one) => one.uid))
  const overrides = new Map<string, (EntryInput & { originalStartsAt: number })[]>()
  for (const override of read.overrides as IcsOverride[]) {
    if (!series.has(override.uid)) {
      if (!inFeed.has(override.uid)) skipped++
      continue
    }
    const entry = { ...feedEntry(override, where), originalStartsAt: override.recurrenceId }
    overrides.set(override.uid, [...(overrides.get(override.uid) ?? []), entry])
  }
  return {
    entries,
    overrides,
    name: calendarText(read.name, { dropSecretLines: false }),
    timezone: zoneOk(named) ? named : null,
    events: read.events.length + read.overrides.length,
    skipped,
  }
}

const calendarOf = (feed: FeedRecord, timezone: string | null = null): CalendarInput => ({
  externalId: `${FEED_PREFIX}${feed.id}`,
  title: feed.title,
  timezone,
  accessRole: "reader",
  primary: false,
  syncByDefault: true,
})

export interface IcsFeedsOptions {
  registry: FeedRegistry
  /** The zone a floating time is read in when the feed names none. */
  zone: string
  fetch?: typeof fetch
  signal?: AbortSignal
  limits?: FeedLimits
}

/**
 * The profile's feeds as one calendar source with `expands: "local"` and a full list on every sync: a feed has no
 * cursor. The expander a sync is given reads the overrides of the feed `changes()` just read.
 */
export const icsFeeds = (options: IcsFeedsOptions): CalendarFeeds => {
  const overridesOf = new WeakMap<EntryInput, (EntryInput & { originalStartsAt: number })[]>()
  const stats = new Map<number, FeedSyncStats>()
  const feedOf = async (externalId: string) => {
    const feed = (await options.registry.read()).find((one) => `${FEED_PREFIX}${one.id}` === externalId)
    if (!feed)
      throw new CliError(
        "configuration_error",
        `the address of feed ${externalId} is no longer kept on this computer`,
        {
          reason: "feed.no-address",
        },
      )
    return feed
  }
  const read = (url: string, name: string) =>
    fetchFeed(url, {
      name,
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.limits ? { limits: options.limits } : {}),
    })

  const source: CalendarSource = {
    provider: "ics",
    traits: { expands: "local", cursorHoldsWindow: false, fullListOnly: true },
    async calendars() {
      return (await options.registry.read()).map((feed) => calendarOf(feed))
    },
    async changes(calendar, { window }) {
      const feed = await feedOf(calendar.externalId)
      const text = await read(feed.url, `feed ${calendar.id}`)
      const found = readFeed(text, calendar.timezone ?? options.zone, window)
      for (const entry of found.entries) {
        const changed = found.overrides.get(entry.externalId)
        if (changed) overridesOf.set(entry, changed)
      }
      stats.set(calendar.id, { calendarId: calendar.id, events: found.events, skipped: found.skipped })
      return { entries: found.entries, removed: [], cursor: null }
    },
  }

  return {
    source,
    expand: (series, window) => expandSeries(series, window, overridesOf.get(series) ?? []),
    async add(url, { title } = {}) {
      const address = feedAddress(url).href
      const feeds = await options.registry.read()
      if (feeds.some((one) => sameAddress(one.url, address)))
        throw new CliError("validation_error", "this profile follows a feed at this address already", {
          reason: "feed.duplicate",
        })
      const found = readFeed(await read(address, "the feed"), options.zone)
      const feed: FeedRecord = {
        id: randomBytes(6).toString("hex"),
        url: address,
        title: title?.trim() || found.name || new URL(address).hostname,
      }
      await options.registry.write([...feeds, feed])
      return { calendar: calendarOf(feed, found.timezone), events: found.events }
    },
    async remove(externalId) {
      const feeds = await options.registry.read()
      await options.registry.write(feeds.filter((one) => `${FEED_PREFIX}${one.id}` !== externalId))
    },
    stats: () => [...stats.values()],
  }
}

export type FeedsSyncReport = CalendarSyncReport & { feeds?: FeedSyncStats[] }

/**
 * The provider's calendars, then the profile's feeds, under one budget and in one report: the feeds are calendars of
 * the same account, synced by their own source because they expand their series here.
 */
export const syncWithFeeds = async (
  source: CalendarSource,
  feeds: CalendarFeeds | undefined,
  store: EventStore,
  options: CalendarSyncOptions,
): Promise<FeedsSyncReport> => {
  const budget = options.budget ?? runBudget()
  const first = await syncCalendars(source, store, { ...options, budget })
  if (!feeds) return first
  const second = await syncCalendars(feeds.source, store, { ...options, budget, expand: feeds.expand })
  if (second.calendars === 0) return first
  const complete = first.complete && second.complete
  const stopped = first.stopped ?? second.stopped
  const hint = first.hint ?? second.hint
  const sum = (field: keyof FeedsSyncReport["progress"]) => first.progress[field] + second.progress[field]
  return {
    ...first,
    calendars: first.calendars + second.calendars,
    synced: [...first.synced, ...second.synced],
    notSynced: [...first.notSynced, ...second.notSynced],
    complete,
    state: first.state === "complete" && second.state === "complete" ? "complete" : "partial",
    ...(stopped ? { stopped } : {}),
    progress: {
      calendars: sum("calendars"),
      calendarsDone: sum("calendarsDone"),
      requests: budget.used,
      saved: sum("saved"),
      steps: sum("steps"),
    },
    ...(hint ? { hint } : {}),
    feeds: feeds.stats(),
  }
}
