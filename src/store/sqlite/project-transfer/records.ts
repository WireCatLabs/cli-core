import { CliError } from "@wirecat/cli-base"
import type { CacheDatabase } from "../../driver.js"
import { fold } from "../../normalize.js"
import type { ProjectAnnotationSnapshot } from "../../project-transfer/snapshot-model.js"
import { nextId } from "../memories.js"
import { type Thing, thingOf } from "../things.js"

export const restoreAnnotationRecords = (
  database: CacheDatabase,
  projectId: number,
  snapshot: ProjectAnnotationSnapshot,
  bindings: Record<string, string>,
) => {
  const mappings = { ...bindings }
  const resolve = (ref: string | null): Thing | null => {
    if (ref === null) return null
    const mapped = mappings[ref],
      thing = mapped === undefined ? undefined : thingOf(database, mapped)
    if (!thing) throw new CliError("validation_error", "project annotation binding became unavailable")
    return thing
  }
  const organization = resolve(snapshot.project.organization),
    owner = resolve(snapshot.project.owner)
  database
    .prepare(
      "UPDATE projects SET description=?,type=?,scope=?,organization_id=?,owner_type=?,owner_id=?,status=?,created_at=?,updated_at=? WHERE id=?",
    )
    .run(
      snapshot.project.description,
      snapshot.project.type,
      snapshot.project.scope,
      organization?.id ?? null,
      owner?.type ?? null,
      owner?.id ?? null,
      snapshot.project.status,
      snapshot.project.created_at,
      snapshot.project.updated_at,
      projectId,
    )
  for (const alias of snapshot.aliases)
    database
      .prepare(
        "INSERT INTO aliases(aliasable_type,aliasable_id,account_id,name,name_folded,display,source,created_at,updated_at) VALUES('project',?,NULL,?,?,?,?,?,?)",
      )
      .run(
        projectId,
        alias.name,
        fold(alias.name),
        Number(alias.display),
        alias.source,
        alias.created_at,
        alias.updated_at,
      )
  for (const fact of snapshot.facts) {
    const author = resolve(fact.author),
      confirmed = resolve(fact.confirmed_by)
    if (!author) throw new CliError("validation_error", "project annotation author is required")
    const row = database
      .prepare(
        "INSERT INTO facts(id,type,statement,status,project_id,subject_type,subject_id,occurred_at,supersedes_id,author_type,author_id,model,confirmed_by_type,confirmed_by_id,scope,source,created_at,updated_at) VALUES(?,?,?,?,?,NULL,NULL,?,NULL,?,?,?,?,?,?,?,?,?) RETURNING id",
      )
      .get(
        nextId(database, "facts"),
        fact.type,
        fact.statement,
        fact.status,
        projectId,
        fact.occurred_at,
        author.type,
        author.id,
        fact.model,
        confirmed?.type ?? null,
        confirmed?.id ?? null,
        fact.scope,
        fact.source,
        fact.created_at,
        fact.updated_at,
      )
    if (!row) throw new CliError("configuration_error", "project annotation fact insertion failed")
    mappings[fact.ref] = `fact:${row.id}`
  }
  for (const fact of snapshot.facts) {
    const subject = resolve(fact.subject),
      previous = resolve(fact.supersedes),
      target = resolve(fact.ref)
    if (!target) throw new CliError("configuration_error", "project annotation fact mapping is missing")
    database
      .prepare("UPDATE facts SET subject_type=?,subject_id=?,supersedes_id=? WHERE id=?")
      .run(subject?.type ?? null, subject?.id ?? null, previous?.id ?? null, target.id)
  }
  for (const link of snapshot.links) {
    const from = resolve(link.from),
      to = resolve(link.to)
    if (!from) throw new CliError("validation_error", "project annotation link source is required")
    const row = database
      .prepare(
        "INSERT INTO links(from_type,from_id,to_type,to_id,kind,anchor,source,target_text,target_folded,role,evidence,metadata,confirmed,created_at,author,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id",
      )
      .get(
        from.type,
        from.id,
        to?.type ?? null,
        to?.id ?? null,
        link.kind,
        link.anchor,
        link.origin,
        link.target_text,
        link.target_text === null ? null : fold(link.target_text),
        link.role,
        link.evidence,
        link.provenance === null ? null : JSON.stringify({ provenance: link.provenance }),
        Number(link.confirmed),
        link.created_at,
        link.author,
        link.updated_at,
      )
    if (!row) throw new CliError("configuration_error", "project annotation link insertion failed")
    mappings[link.ref] = `link:${row.id}`
  }
  return mappings
}
