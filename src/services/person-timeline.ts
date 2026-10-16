import { CliError } from "@wirecat/cli-base"
import { formatLocator } from "../domain/locator.js"
import type { Provider } from "../domain/models.js"
import { pickPerson } from "../resolve.js"
import type { AccountKey, MessageStore } from "../store/store.js"

export const TIMELINE_ITEMS = 50
export const TIMELINE_MAX = 500
export const SCOPES = ["personal", "work"] as const
export type Scope = (typeof SCOPES)[number]

export interface TimelineItem {
  at: string
  subject: string
  /** The store's own key for the subject; a locator, where there is one, is what other commands take. */
  subjectId: number
  role: string
  scope: string
  provider: Provider | null
  account: string | null
  chatId: string | null
  locator: string | null
  projectId: number | null
}

export interface PersonTimeline {
  person: { uid: string; name: string | null }
  items: TimelineItem[]
  limits: { items: number }
  hasMore: boolean
  /** Where the next page starts; set when `hasMore`. */
  cursor?: string
  /** Changes a large write left queued; the items leave them out until the next write recomputes them. */
  pending: number
}

export interface TimelineOptions {
  scope?: Scope
  /** ms, inclusive. */
  since?: number
  /** ms, inclusive. */
  until?: number
  limit?: number
  /** What a previous answer's `cursor` said; the filters are the caller's to repeat. */
  cursor?: string
}

/** `before:<ms>:<row id>` — the last item's time and the store's row id, which breaks ties between equal times. */
const cursorOf = (row: { occurredAt: number; id: number }) => `before:${row.occurredAt}:${row.id}`

const boundOf = (cursor: string): { at: number; id: number } => {
  const [way, at, id, ...rest] = cursor.split(":")
  const bound = { at: Number(at), id: Number(id) }
  if (way !== "before" || rest.length > 0 || !Number.isSafeInteger(bound.at) || !Number.isSafeInteger(bound.id))
    throw new CliError("validation_error", `--cursor takes what page.next gave, before:<time>:<id> — not "${cursor}"`)
  return bound
}

/**
 * Everything one person took part in, across every identity linked to them, newest first. The index
 * is derived and nothing else keeps it current, so it is rebuilt for this one person first.
 */
export const personTimeline = async (
  store: MessageStore,
  asked: AccountKey,
  reference: string,
  { scope, since, until, cursor, limit = TIMELINE_ITEMS }: TimelineOptions = {},
): Promise<PersonTimeline> => {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > TIMELINE_MAX)
    throw new CliError("validation_error", `the limit takes 1–${TIMELINE_MAX}`)
  if (since !== undefined && until !== undefined && since > until)
    throw new CliError("validation_error", "the start of the range is after its end")
  const found = pickPerson(reference, await store.people.people(asked.provider, { account: asked.account }))
  const record = await store.people.personOf({ provider: asked.provider, id: found.id })
  if (!record) throw new CliError("not_found", `no person ${found.id} in the store`)
  const personId = Number(record.uid)
  const pending = store.involvements.pending()
  const rows = store.involvements.forPerson(personId, {
    ...(scope === undefined ? {} : { scope }),
    ...(since === undefined ? {} : { since }),
    ...(until === undefined ? {} : { until }),
    only: asked,
    ...(cursor === undefined ? {} : { before: boundOf(cursor) }),
    limit: limit + 1,
  })
  const shown = rows.slice(0, limit)
  const last = shown.at(-1)
  const hasMore = rows.length > limit
  return {
    person: { uid: record.uid, name: record.name },
    items: shown.map((row) => ({
      at: new Date(row.occurredAt).toISOString(),
      subject: row.subjectType,
      subjectId: row.subjectId,
      role: row.role,
      scope: row.scope,
      provider: row.provider,
      account: row.account,
      chatId: row.chat,
      locator:
        row.provider && row.account && row.chat && row.message
          ? formatLocator({ provider: row.provider, account: row.account, chat: row.chat, message: row.message })
          : null,
      projectId: row.projectId,
    })),
    limits: { items: limit },
    hasMore,
    ...(hasMore && last ? { cursor: cursorOf(last) } : {}),
    pending,
  }
}
