import { CliError } from "@wirecat/cli-base"
import { type MeetingPreparationNotesStore, validateMeetingRelatedHistory } from "../../meetings/index.js"
import { linkKind } from "./link-kinds.js"
import type { StoreContext } from "./open.js"
import { preparationSubjects } from "./preparation-subjects.js"
import { read } from "./transaction.js"

export const meetingPreparationNotesOver = ({
  database,
}: Pick<StoreContext, "database">): MeetingPreparationNotesStore => ({
  async preparationNotes(original) {
    const { accountId, seriesId, anchorIds, after, before, limit, maxReadBytes, signal } =
      validateMeetingRelatedHistory(original)
    if (!anchorIds.length) return { items: [], hasMore: false }
    return read(database, () => {
      const association = (type: "person" | "project", table: "people" | "projects") =>
        `(SELECT min(t.id) FROM ${table} t WHERE (n.notable_type='${type}' AND n.notable_id=t.id)
        OR EXISTS(SELECT 1 FROM links l WHERE l.from_type='note' AND l.from_id=n.id
          AND l.to_type='${type}' AND l.to_id=t.id AND l.kind=${linkKind("about")} AND l.confirmed=1))`
      const selection = `${preparationSubjects(anchorIds.length)}, candidates AS (
        SELECT n.id,n.title,n.body,n.revision,n.updated_at,
          ${association("person", "people")} AS person_id, ${association("project", "projects")} AS project_id
        FROM notes n JOIN persons owner ON n.author_type='person' AND n.author_id=owner.id AND owner.owner=1
        WHERE n.deleted_at IS NULL AND n.updated_at<=? AND (
          (n.notable_type='person' AND EXISTS(SELECT 1 FROM persons p WHERE p.id=n.notable_id)) OR
          (n.notable_type='project' AND EXISTS(SELECT 1 FROM main.projects p WHERE p.id=n.notable_id
            AND p.account_id IS NULL AND p.deleted_at IS NULL)))
      ) SELECT * FROM candidates WHERE person_id IS NOT NULL OR project_id IS NOT NULL
        ORDER BY updated_at DESC,id DESC LIMIT ?`
      const params = [...anchorIds, accountId, accountId, seriesId, after, before, before, limit + 1]
      const probe = database
        .prepare(`SELECT coalesce(sum(length(CAST(coalesce(title,'') AS BLOB))+
        length(CAST(body AS BLOB))),0) AS read_bytes FROM (${selection})`)
        .get(...params)
      const bytes = Number(probe?.read_bytes)
      if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > maxReadBytes)
        throw new CliError("validation_error", "Preparation notes exceed the stored text byte budget")
      signal?.throwIfAborted()
      const rows = database.prepare(selection).all(...params)
      signal?.throwIfAborted()
      return {
        items: rows.slice(0, limit).map((row) => ({
          ref: `note:${row.id}`,
          title: row.title == null ? null : String(row.title),
          text: String(row.body),
          revision: Number(row.revision),
          updatedAt: Number(row.updated_at),
          person: row.person_id == null ? null : `person:${row.person_id}`,
          project: row.project_id == null ? null : `project:${row.project_id}`,
        })),
        hasMore: rows.length > limit,
      }
    })
  },
})
