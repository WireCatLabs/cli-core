import { CliError } from "@wirecat/cli-base"
import type { CacheDatabase, SqlValue } from "../../driver.js"
import { MIGRATIONS } from "../../migrations.js"
import { decodeProjectAnnotationSnapshot } from "../../project-transfer/snapshot-model.js"
import { read } from "../transaction.js"
import type { SnapshotBudget } from "./budget.js"
import { ProjectSnapshotSources } from "./sources.js"

const unsupported = (): never => {
  throw new CliError("configuration_error", "project snapshot has unsupported metadata, deletion or account scope")
}
const nullableText = (value: unknown) => (value === null ? null : String(value))
const flag = (value: unknown) => {
  if (value !== 0 && value !== 1) return unsupported()
  return value === 1
}
const provenance = (raw: unknown) => {
  if (raw === null) return null
  let value: unknown
  try {
    value = JSON.parse(String(raw))
  } catch {
    return unsupported()
  }
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => key !== "provenance")
  )
    return unsupported()
  const text = (value as { provenance?: unknown }).provenance
  if (text !== undefined && text !== null && typeof text !== "string") return unsupported()
  return text ?? null
}

export const projectAnnotationSnapshot = (database: CacheDatabase, projectId: number, budget: SnapshotBudget) =>
  read(database, () => {
    if (
      database.prepare("SELECT max(version) AS version FROM schema_migrations").get()?.version !==
      MIGRATIONS.at(-1)?.version
    )
      throw new CliError(
        "configuration_error",
        "project snapshots require the SDK's current store schema without source migration",
      )
    const sources = new ProjectSnapshotSources(database, budget)
    const rows = (from: string, fields: string[], params: SqlValue[]) => {
      budget.rows(database, from, fields, params)
      return database.prepare(`SELECT ${fields.join(",")} ${from} LIMIT 1001`).all(...params)
    }
    const descriptor = database.prepare("SELECT account_id,deleted_at FROM projects WHERE id=?").get(projectId)
    if (!descriptor) throw new CliError("not_found", "the source project does not exist")
    if (descriptor.account_id !== null || descriptor.deleted_at !== null) return unsupported()
    const project = rows(
      "FROM projects WHERE id=?",
      [
        "id",
        "key",
        "name",
        "description",
        "type",
        "scope",
        "organization_id",
        "owner_type",
        "owner_id",
        "status",
        "created_at",
        "updated_at",
      ],
      [projectId],
    )[0]
    if (!project) throw new CliError("not_found", "the source project does not exist")
    const aliases = rows(
      "FROM aliases WHERE aliasable_type='project' AND aliasable_id=? ORDER BY id",
      ["name", "source", "display", "account_id", "created_at", "updated_at"],
      [projectId],
    )
    if (aliases.some((alias) => alias.account_id !== null)) return unsupported()
    if (
      database
        .prepare("SELECT 1 FROM facts WHERE project_id=? AND (metadata IS NOT NULL OR deleted_at IS NOT NULL) LIMIT 1")
        .get(projectId)
    )
      return unsupported()
    const facts = rows(
      "FROM facts WHERE project_id=? ORDER BY id",
      [
        "id",
        "type",
        "statement",
        "status",
        "subject_type",
        "subject_id",
        "occurred_at",
        "supersedes_id",
        "author_type",
        "author_id",
        "model",
        "confirmed_by_type",
        "confirmed_by_id",
        "scope",
        "source",
        "created_at",
        "updated_at",
      ],
      [projectId],
    )
    const links = rows(
      "FROM links WHERE (from_type='project' AND from_id=?) OR (to_type='project' AND to_id=?) OR " +
        "(from_type='fact' AND from_id IN (SELECT id FROM facts WHERE project_id=?)) OR " +
        "(to_type='fact' AND to_id IN (SELECT id FROM facts WHERE project_id=?)) ORDER BY id",
      [
        "id",
        "from_type",
        "from_id",
        "to_type",
        "to_id",
        "kind",
        "anchor",
        "source",
        "target_text",
        "role",
        "evidence",
        "metadata",
        "confirmed",
        "author",
        "created_at",
        "updated_at",
      ],
      [projectId, projectId, projectId, projectId],
    )
    const projectRef = `project:${projectId}`
    const owned = new Set([projectRef, ...facts.map((row) => `fact:${row.id}`)])
    const data = {
      format: "wirecat.project-annotations",
      version: 2,
      project: {
        ref: projectRef,
        key: project.key,
        name: project.name,
        type: project.type,
        scope: project.scope,
        organization: project.organization_id === null ? null : sources.ref("organization", project.organization_id),
        created_at: project.created_at,
        description: project.description,
        status: project.status,
        owner: sources.ref(project.owner_type, project.owner_id),
        updated_at: project.updated_at,
        account_scope: "owner",
      },
      coverage: {
        aliases: "complete",
        facts: "complete",
        links: "complete",
        memories: "omitted",
        tasks: "omitted",
        labels: "omitted",
        findings: "omitted",
        meeting_memberships: "omitted",
        notes: "omitted",
      },
      aliases: aliases.map((row) => ({
        name: row.name,
        source: row.source,
        display: flag(row.display),
        created_at: row.created_at,
        updated_at: row.updated_at,
      })),
      facts: facts.map((row) => ({
        ref: `fact:${row.id}`,
        type: row.type,
        statement: row.statement,
        status: row.status,
        subject: sources.ref(row.subject_type, row.subject_id),
        occurred_at: row.occurred_at,
        supersedes: row.supersedes_id === null ? null : sources.ref("fact", row.supersedes_id),
        author: sources.ref(row.author_type, row.author_id),
        model: row.model,
        confirmed_by: sources.ref(row.confirmed_by_type, row.confirmed_by_id),
        scope: row.scope,
        source: row.source,
        created_at: row.created_at,
        updated_at: row.updated_at,
      })),
      links: links.map((row) => ({
        ref: `link:${row.id}`,
        from: sources.ref(row.from_type, row.from_id),
        to: sources.ref(row.to_type, row.to_id),
        kind: row.kind,
        origin: row.source,
        anchor: nullableText(row.anchor),
        target_text: nullableText(row.target_text),
        role: nullableText(row.role),
        evidence: nullableText(row.evidence),
        confirmed: flag(row.confirmed),
        provenance: provenance(row.metadata),
        created_at: row.created_at,
        updated_at: row.updated_at,
        author: nullableText(row.author),
      })),
    }
    const snapshot = decodeProjectAnnotationSnapshot(JSON.stringify({ ...data, external: sources.external(owned) }))
    return { snapshot, read_bytes: budget.bytes, records: budget.records }
  })
