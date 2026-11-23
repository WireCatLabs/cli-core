import type { ProjectAnnotationPreview } from "./snapshot-plan.js"

/** @experimental */
export interface ProjectAnnotationTargetRequest {
  snapshot: string
  project: string
  bindings: Record<string, string>
  maxReadBytes?: number
}
/** @experimental */
export interface ProjectAnnotationRestoreRequest extends ProjectAnnotationTargetRequest {
  fingerprint: string
}
/** @experimental */
export interface ProjectAnnotationRestoreReceipt {
  project: string
  fingerprint: string
  mappings: Record<string, string>
  counts: { aliases: number; facts: number; links: number }
}

/** Hosts authorize restore before calling; historical accepted state is not a new agent decision. @experimental */
export interface ProjectAnnotationStore {
  preview(request: ProjectAnnotationTargetRequest): Promise<ProjectAnnotationPreview>
  restore(request: ProjectAnnotationRestoreRequest): Promise<ProjectAnnotationRestoreReceipt>
}
