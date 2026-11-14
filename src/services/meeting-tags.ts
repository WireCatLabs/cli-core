import { CliError } from "@wirecat/cli-base"
import { normalizeTag } from "../domain/tags.js"
import type { MeetingTagChange, MeetingTagged } from "../meetings/index.js"
import type { AccountKey, MessageStore } from "../store/store.js"
import { searchMeetingHits } from "./meeting-hit-search.js"

/** The meetings a tag change acts on: these store ids, or every meeting with a hit of a `search meetings` query. */
export type MeetingTagTarget = { meetings: number[] } | { matching: string }

export interface MeetingTags {
  add(target: MeetingTagTarget, tags: string[], signal?: AbortSignal): Promise<MeetingTagChange>
  remove(target: MeetingTagTarget, tags: string[], signal?: AbortSignal): Promise<MeetingTagChange>
  list(request: { tag?: string; limit: number; offset: number }): Promise<{ items: MeetingTagged[]; hasMore: boolean }>
}

type Store = Pick<MessageStore, "meetings" | "knowledge">

const keyOf = async (store: Store, accountId: number): Promise<AccountKey> => {
  const owner = await store.meetings.account(accountId)
  if (!owner) throw new CliError("not_found", `meeting account ${accountId} is not in the store`)
  return { provider: owner.provider, account: owner.account }
}

const tagsOf = (given: string[]): string[] => {
  if (given.length === 0) throw new CliError("validation_error", "name at least one tag")
  return [...new Set(given.map(normalizeTag))]
}

/** Every page of the search, so a word said in a thousand calls marks all of them; hits come one per line. */
const matchedMeetings = async (store: Store, accountId: number, query: string, signal?: AbortSignal) => {
  const found = new Set<number>()
  let after: string | undefined
  for (;;) {
    const page = await searchMeetingHits(store, query, {
      accountId,
      limit: 1000,
      ...(after === undefined ? {} : { after }),
      ...(signal ? { signal } : {}),
    })
    for (const hit of page.items) found.add(hit.meetingId)
    if (!page.hasMore || page.nextCursor === null) return [...found]
    after = page.nextCursor
  }
}

const meetingsOf = async (store: Store, accountId: number, target: MeetingTagTarget, signal?: AbortSignal) => {
  if ("matching" in target) return matchedMeetings(store, accountId, target.matching, signal)
  const ids = [...new Set(target.meetings)]
  // A meeting of another account is not found, as if it were not stored.
  for (const meetingId of ids)
    await store.meetings.meetingMetadata({ accountId, meetingId, ...(signal ? { signal } : {}) })
  return ids
}

/**
 * The owner's labels on one account's meetings, kept in the store's taggings like every other tag, so `--tag` and
 * `tag:` in `search meetings` select them. A mark stays when a new transcript no longer says the words.
 */
export const meetingTags = (store: Store, accountId: number): MeetingTags => {
  const change =
    (operation: "addTags" | "removeTags") =>
    async (target: MeetingTagTarget, given: string[], signal?: AbortSignal): Promise<MeetingTagChange> => {
      const tags = tagsOf(given)
      const key = await keyOf(store, accountId)
      const meetings = await meetingsOf(store, accountId, target, signal)
      const changed: MeetingTagChange["changed"] = []
      for (const meetingId of meetings) {
        signal?.throwIfAborted()
        const done = await store.knowledge[operation](key, { type: "meeting", id: String(meetingId) }, tags)
        if (done.length > 0) changed.push({ meetingId, tags: done })
      }
      return { accountId, tags, matched: meetings.length, changed }
    }
  return {
    add: change("addTags"),
    remove: change("removeTags"),
    list: async ({ tag, limit, offset }) => {
      const key = await keyOf(store, accountId)
      const found = await store.knowledge.labelled(key, {
        type: "meeting",
        ...(tag === undefined ? {} : { tag: normalizeTag(tag) }),
        limit,
        offset,
      })
      const items: MeetingTagged[] = []
      for (const { target, tags } of found.items) {
        if (target.type !== "meeting") continue
        const meeting = await store.meetings.meetingMetadata({ accountId, meetingId: Number(target.id) })
        items.push({ accountId, meetingId: meeting.id, title: meeting.title, startedAt: meeting.startedAt, tags })
      }
      return { items, hasMore: found.hasMore }
    },
  }
}
