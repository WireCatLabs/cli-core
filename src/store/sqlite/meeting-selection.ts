import type { MeetingSearchOptions } from "../../meetings/index.js"
import type { SqlValue } from "../driver.js"

export type MeetingSelection = Pick<
  MeetingSearchOptions,
  | "accountId"
  | "meetingId"
  | "eventId"
  | "meetingSeriesId"
  | "since"
  | "until"
  | "participantIdentityId"
  | "personId"
  | "projectId"
  | "tagId"
>

/** The meetings a search may read, over `meetings m`: the same filters for words and for meaning. */
export const meetingSelectionSql = (input: MeetingSelection): { clauses: string[]; params: SqlValue[] } => {
  const clauses = ["m.account_id=?", "m.deleted_at IS NULL"]
  const params: SqlValue[] = [input.accountId]
  if (input.meetingId !== undefined) {
    clauses.push("m.id=?")
    params.push(input.meetingId)
  }
  if (input.eventId !== undefined) {
    clauses.push("m.event_id=?")
    params.push(input.eventId)
  }
  if (input.meetingSeriesId !== undefined) {
    clauses.push("m.meeting_series_id=?")
    params.push(input.meetingSeriesId)
  }
  if (input.since !== undefined) {
    clauses.push("m.started_at>=?")
    params.push(input.since)
  }
  if (input.until !== undefined) {
    clauses.push("m.started_at<=?")
    params.push(input.until)
  }
  if (input.participantIdentityId !== undefined) {
    clauses.push("EXISTS (SELECT 1 FROM meeting_participants p WHERE p.meeting_id=m.id AND p.identity_id=?)")
    params.push(input.participantIdentityId)
  }
  if (input.personId !== undefined) {
    clauses.push(
      "EXISTS (SELECT 1 FROM meeting_participants p JOIN identity_links i ON i.identity_id=p.identity_id JOIN persons person ON person.id=i.person_id WHERE p.meeting_id=m.id AND person.id=?)",
    )
    params.push(input.personId)
  }
  if (input.projectId !== undefined) {
    clauses.push(
      "EXISTS (SELECT 1 FROM links l JOIN projects p ON p.id=l.to_id WHERE l.from_type='meeting' AND l.from_id=m.id AND l.to_type='project' AND l.kind='member-of' AND l.anchor IS NULL AND l.confirmed=1 AND p.id=? AND p.account_id IS NULL AND p.deleted_at IS NULL)",
    )
    params.push(input.projectId)
  }
  if (input.tagId !== undefined) {
    clauses.push(
      "EXISTS (SELECT 1 FROM taggings g JOIN tags t ON t.id=g.tag_id WHERE g.taggable_type='meeting' AND g.taggable_id=m.id AND t.id=?)",
    )
    params.push(input.tagId)
  }
  return { clauses, params }
}
