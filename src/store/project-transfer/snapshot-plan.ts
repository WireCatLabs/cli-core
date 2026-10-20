import { type ProjectAnnotationsPlan, type ProjectAnnotationsTarget, planBoundProjectAnnotations } from "./plan.js"
import { decodeProjectAnnotationSnapshot, projectAnnotationSnapshotFingerprint } from "./snapshot-model.js"

export interface ProjectAnnotationPreview {
  plan: ProjectAnnotationsPlan
  descriptor_conflicts: ("key" | "name")[]
  namespace_conflicts: string[]
  ready: boolean
  fingerprint: string
  read_bytes: number
  records: number
}

/** Metadata and project-owner bindings participate in the version-2 preview fingerprint. */
export const planProjectAnnotationSnapshot = (
  json: string,
  target: ProjectAnnotationsTarget,
  bindings: Record<string, string>,
) =>
  planBoundProjectAnnotations(
    decodeProjectAnnotationSnapshot(json),
    projectAnnotationSnapshotFingerprint(json),
    target,
    bindings,
  )
