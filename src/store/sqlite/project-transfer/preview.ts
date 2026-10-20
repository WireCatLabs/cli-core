import { createHash } from "node:crypto"
import { normalizeVocabularyName } from "../../../domain/vocabulary.js"
import type { CacheDatabase } from "../../driver.js"
import {
  type ProjectAnnotationSnapshot,
  projectAnnotationSnapshotFingerprint,
} from "../../project-transfer/snapshot-model.js"
import { planProjectAnnotationSnapshot } from "../../project-transfer/snapshot-plan.js"
import { thingOf } from "../things.js"
import { read } from "../transaction.js"
import type { SnapshotBudget } from "./budget.js"
import { projectAnnotationSnapshot } from "./snapshot.js"
import { ProjectSnapshotSources } from "./sources.js"

export const previewAnnotationSnapshot = (
  database: CacheDatabase,
  projectId: number,
  manifest: ProjectAnnotationSnapshot,
  bindings: Record<string, string>,
  budget: SnapshotBudget,
) =>
  read(database, () => {
    const current = projectAnnotationSnapshot(database, projectId, budget).snapshot
    const sources = new ProjectSnapshotSources(database, budget)
    for (const ref of new Set(Object.values(bindings))) {
      if (ref === current.project.ref) continue
      const thing = thingOf(database, ref)
      if (thing) sources.ref(thing.type, thing.id)
    }
    const external = sources.external(new Set([current.project.ref]))
    const projectFields = ["id", "key", "name", "account_id", "deleted_at"]
    const aliasFields = ["aliasable_id", "name", "account_id"]
    const projectFrom = "FROM projects ORDER BY id"
    const aliasFrom = "FROM aliases WHERE aliasable_type='project' ORDER BY id"
    budget.rows(database, projectFrom, projectFields, [])
    budget.rows(database, aliasFrom, aliasFields, [])
    const projects = database.prepare(`SELECT ${projectFields.join(",")} ${projectFrom} LIMIT 1001`).all()
    const aliases = database.prepare(`SELECT ${aliasFields.join(",")} ${aliasFrom} LIMIT 1001`).all()
    const names = new Set(
      [manifest.project.key, manifest.project.name, ...manifest.aliases.map((a) => a.name)].map(
        normalizeVocabularyName,
      ),
    )
    const namespace = new Set<string>()
    for (const project of projects) {
      if (project.id === projectId) continue
      const keyMatches = names.has(normalizeVocabularyName(String(project.key)))
      const nameMatches =
        project.account_id === null &&
        project.deleted_at === null &&
        names.has(normalizeVocabularyName(String(project.name)))
      if (keyMatches || nameMatches) namespace.add(`project:${project.id}`)
    }
    for (const alias of aliases) {
      if (alias.aliasable_id === projectId || alias.account_id !== null) continue
      const project = projects.find(
        (p) => p.id === alias.aliasable_id && p.account_id === null && p.deleted_at === null,
      )
      if (project && names.has(normalizeVocabularyName(String(alias.name)))) namespace.add(`project:${project.id}`)
    }
    const descriptor_conflicts = (["key", "name"] as const).filter(
      (field) => current.project[field] !== manifest.project[field],
    )
    const target = {
      project: current.project.ref,
      annotation_count: current.aliases.length + current.facts.length + current.links.length,
      revision_sha256: createHash("sha256")
        .update(
          JSON.stringify({
            snapshot: projectAnnotationSnapshotFingerprint(JSON.stringify(current)),
            projects,
            aliases,
            external: external.toSorted((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0)),
          }),
        )
        .digest("hex"),
      external,
    }
    const plan = planProjectAnnotationSnapshot(JSON.stringify(manifest), target, bindings)
    const namespace_conflicts = [...namespace].sort()
    return {
      plan,
      descriptor_conflicts,
      namespace_conflicts,
      ready: plan.ready && descriptor_conflicts.length === 0 && namespace_conflicts.length === 0,
      fingerprint: createHash("sha256")
        .update(JSON.stringify({ plan: plan.fingerprint, descriptor_conflicts, namespace_conflicts }))
        .digest("hex"),
      read_bytes: budget.bytes,
      records: budget.records,
    }
  })
