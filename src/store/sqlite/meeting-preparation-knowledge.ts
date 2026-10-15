import { CliError } from "@wirecat/cli-base"
import { type MeetingPreparationKnowledgeStore, validateMeetingRelatedHistory } from "../../meetings/index.js"
import type { StoreContext } from "./open.js"
import { preparationSubjects } from "./preparation-subjects.js"
import { read } from "./transaction.js"

export const meetingPreparationKnowledgeOver = ({
  database,
}: Pick<StoreContext, "database">): MeetingPreparationKnowledgeStore => ({
  async preparationKnowledge(original) {
    const { accountId, seriesId, anchorIds, after, before, limit, maxReadBytes, signal } =
      validateMeetingRelatedHistory(original)
    if (!anchorIds.length) return { items: [], hasMore: false }
    return read(database, () => {
      const selection = `${preparationSubjects(anchorIds.length)}, candidates AS (
        SELECT f.id,f.type,f.statement,f.subject_type,f.subject_id,f.project_id,f.updated_at,
        (f.subject_type='person' AND f.subject_id IN (SELECT id FROM people)) AS shared_person,
        ((f.subject_type='project' AND f.subject_id IN (SELECT id FROM projects))
          OR f.project_id IN (SELECT id FROM projects)) AS shared_project
        FROM facts f WHERE f.status='accepted' AND f.deleted_at IS NULL AND f.updated_at<=?
        AND (f.subject_type IS NULL OR f.subject_type='person' OR
          (f.subject_type='project' AND EXISTS(SELECT 1 FROM main.projects p
            WHERE p.id=f.subject_id AND p.account_id IS NULL AND p.deleted_at IS NULL)))
        AND (f.project_id IS NULL OR EXISTS(
          SELECT 1 FROM main.projects p WHERE p.id=f.project_id AND p.account_id IS NULL AND p.deleted_at IS NULL))
      ) SELECT * FROM candidates WHERE shared_person OR shared_project ORDER BY updated_at DESC,id DESC LIMIT ?`
      const params = [...anchorIds, accountId, accountId, seriesId, after, before, before, limit + 1]
      const probe = database
        .prepare(`SELECT coalesce(sum(read_bytes),0) AS read_bytes FROM (
          SELECT length(CAST(type AS BLOB))+length(CAST(statement AS BLOB)) AS read_bytes FROM (${selection}))`)
        .get(...params)
      const bytes = Number(probe?.read_bytes)
      if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > maxReadBytes)
        throw new CliError("validation_error", "Preparation knowledge exceeds the stored text byte budget")
      signal?.throwIfAborted()
      const rows = database.prepare(selection).all(...params)
      signal?.throwIfAborted()
      return {
        items: rows.slice(0, limit).map((row) => ({
          ref: `fact:${row.id}`,
          type: String(row.type),
          statement: String(row.statement),
          subject: row.subject_type == null ? null : `${row.subject_type}:${row.subject_id}`,
          project: row.project_id == null ? null : `project:${row.project_id}`,
          updatedAt: Number(row.updated_at),
          sharedPerson: Boolean(row.shared_person),
          sharedProject: Boolean(row.shared_project),
        })),
        hasMore: rows.length > limit,
      }
    })
  },
})
