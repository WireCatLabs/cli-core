import { type ProjectAnnotationsTarget, planBoundProjectAnnotations } from "./plan.js"
import { decodeProjectAnnotationSnapshot, projectAnnotationSnapshotFingerprint } from "./snapshot-model.js"

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
