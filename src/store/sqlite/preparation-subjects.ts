import { linkKind } from "./link-kinds.js"

/** Parameters: anchor IDs, account twice, series, history start and preparation start. */
export const preparationSubjects = (anchors: number) => `WITH anchors AS (
  SELECT m.id FROM meetings m JOIN meeting_series s ON s.id=m.meeting_series_id
  WHERE m.id IN (${Array.from({ length: anchors }, () => "?").join(",")}) AND m.account_id=? AND s.account_id=?
  AND s.id=? AND m.started_at>=? AND m.started_at<? AND m.deleted_at IS NULL AND s.deleted_at IS NULL
), people AS (
  SELECT DISTINCT l.person_id AS id FROM anchors a JOIN meeting_participants p ON p.meeting_id=a.id
  JOIN identity_links l ON l.identity_id=p.identity_id JOIN persons person ON person.id=l.person_id
), projects AS (
  SELECT DISTINCT p.id FROM anchors a JOIN links l ON l.from_type='meeting' AND l.from_id=a.id
  AND l.to_type='project' AND l.kind=${linkKind("member-of")} AND l.confirmed=1
  JOIN main.projects p ON p.id=l.to_id WHERE p.account_id IS NULL AND p.deleted_at IS NULL
)`
