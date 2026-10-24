import { googleDocumentId } from "../domain/google-documents.js"
import { findMentions } from "../domain/mentions.js"
import type { MeetingChatLinesInput, MeetingHitSearchRequest, MeetingLink } from "../meetings/index.js"
import type { MessageStore } from "../store/store.js"
import { resolveMeetingSelection } from "./meeting-hit-search.js"

export type { MeetingLink }

export type MeetingLinksRequest = Omit<MeetingHitSearchRequest, "limit" | "after" | "maxReadBytes"> &
  Pick<MeetingChatLinesInput, "maxMessages"> & { url?: string }

/** Links shared in the chat of the selected meetings, most shared first; found when read, not stored. */
export const readMeetingLinks = async (
  store: Pick<MessageStore, "meetings"> & { knowledge?: MessageStore["knowledge"] },
  request: MeetingLinksRequest,
) => {
  const { maxMessages, url, ...selecting } = request
  const { input, selection } = await resolveMeetingSelection(store, selecting)
  const lines = await store.meetings.meetingChatLines({
    ...input,
    ...(maxMessages === undefined ? {} : { maxMessages }),
  })
  const links = new Map<string, MeetingLink>()
  for (const line of lines)
    for (const found of findMentions(line.text)) {
      if (found.kind !== "url" || (url !== undefined && found.value !== url)) continue
      const link = links.get(found.value) ?? {
        url: found.value,
        domain: found.domain,
        documentId: googleDocumentId(found.value),
        count: 0,
        firstAt: line.sentAt,
        lastAt: line.sentAt,
        senders: [],
        meetings: [],
      }
      link.count += 1
      link.lastAt = line.sentAt
      if (line.sender !== null && !link.senders.includes(line.sender)) link.senders.push(line.sender)
      if (!link.meetings.some((one) => one.meetingId === line.meetingId))
        link.meetings.push({ meetingId: line.meetingId, accountId: line.accountId, title: line.title })
      links.set(found.value, link)
    }
  return {
    items: [...links.values()].sort((a, b) => b.count - a.count || b.lastAt - a.lastAt),
    messages: lines.length,
    meetings: new Set(lines.map((line) => line.meetingId)).size,
    selection,
  }
}
