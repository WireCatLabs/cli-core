import { formatMeetingReference } from "../meetings/index.js"
import type { MessageStore, StoredAccount } from "../store/store.js"

const SCAN = 1000

/** A recorded meeting or call some of the people took part in, as the meeting source stored it. */
export interface PersonMeeting {
  /** `meeting:<account>/<meeting>`: `meetings show <meeting>` and `meetings transcript <meeting>` of `account` open it. */
  ref: string
  /** The stored meeting id those commands take. */
  meetingId: number
  /** The account that holds it: its tool's profile opens it. */
  account: { provider: string; account: string }
  title: string | null
  startedAt: string | null
  durationMs: number | null
  hasTranscript: boolean
  /** `event:<id>` of the calendar event it was held for, when the store knows it. */
  event: string | null
  /** `person:<uid>` of each one asked about who took part. */
  people: string[]
}

/**
 * The newest recorded meetings of these people in `accounts`, each once, newest first, and how many there are;
 * `hasMore` when there are more than `limit`, or a person took part in more than `SCAN`. A meeting reaches
 * a person through the identity it was saved under, and through every identity linked to them since, such as a
 * call's number matched to a CRM contact.
 */
export const personMeetings = async (
  store: Pick<MessageStore, "involvements" | "meetings">,
  people: readonly string[],
  accounts: readonly StoredAccount[],
  { limit = 10, since, until }: { limit?: number; since?: number; until?: number } = {},
): Promise<{ items: PersonMeeting[]; total: number; hasMore: boolean }> => {
  const byId = new Map(accounts.map((one) => [one.id, one]))
  let cut = false
  const found = new Map<string, { accountId: number; meetingId: number; at: number; people: string[] }>()
  for (const uid of people) {
    const rows = store.involvements.forPerson(Number(uid), {
      limit: SCAN,
      subjectTypes: ["meeting"],
      ...(since === undefined ? {} : { since }),
      ...(until === undefined ? {} : { until }),
    })
    cut ||= rows.length === SCAN
    for (const row of rows) {
      if (row.subjectType !== "meeting" || row.accountId === null || !byId.has(row.accountId)) continue
      const key = `${row.accountId}/${row.subjectId}`
      const held = found.get(key) ?? {
        accountId: row.accountId,
        meetingId: row.subjectId,
        at: row.occurredAt,
        people: [],
      }
      if (!held.people.includes(`person:${uid}`)) held.people.push(`person:${uid}`)
      found.set(key, held)
    }
  }
  const newest = [...found.values()].sort((a, b) => b.at - a.at || b.meetingId - a.meetingId)
  const items: PersonMeeting[] = []
  for (const { accountId, meetingId, people: who } of newest.slice(0, limit)) {
    const meeting = await store.meetings.meetingMetadata({ accountId, meetingId }).catch(() => undefined)
    if (meeting === undefined || meeting.deletedAt !== null) continue
    const transcripts = await store.meetings.transcripts({ accountId, meetingId, limit: 1 })
    const account = byId.get(accountId) as StoredAccount
    items.push({
      ref: formatMeetingReference({ type: "meeting", accountId, meetingId }),
      meetingId,
      account: { provider: account.provider, account: account.account },
      title: meeting.title,
      startedAt: meeting.startedAt === null ? null : new Date(meeting.startedAt).toISOString(),
      durationMs: meeting.durationMs,
      hasTranscript: transcripts.items.length > 0,
      event: meeting.eventId === null ? null : `event:${meeting.eventId}`,
      people: who,
    })
  }
  return { items, total: newest.length, hasMore: cut || newest.length > limit }
}
