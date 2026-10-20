import { CliError } from "@wirecat/cli-base"
import { projectAnnotationBindingSources } from "./plan.js"
import { decodeProjectAnnotationSnapshot } from "./snapshot-model.js"
import type { ProjectAnnotationRestoreRequest, ProjectAnnotationTargetRequest } from "./store.js"

export const projectAnnotationRequest = (request: ProjectAnnotationTargetRequest, restore = false) => {
  if (!request || typeof request !== "object" || Array.isArray(request))
    throw new CliError("validation_error", "project annotation request is required")
  const fields = ["snapshot", "project", "bindings", "maxReadBytes", ...(restore ? ["fingerprint"] : [])]
  for (const field of Object.keys(request))
    if (!fields.includes(field)) throw new CliError("validation_error", `unknown project annotation field ${field}`)
  const snapshot = decodeProjectAnnotationSnapshot(request.snapshot)
  projectAnnotationBindingSources(snapshot, request.bindings)
  if (
    typeof request.project !== "string" ||
    !/^project:[1-9]\d*$/.test(request.project) ||
    !Number.isSafeInteger(Number(request.project.slice(8)))
  )
    throw new CliError("validation_error", "project annotation project is a project:<safe integer id> reference")
  if (
    restore &&
    (typeof (request as ProjectAnnotationRestoreRequest).fingerprint !== "string" ||
      !/^[a-f0-9]{64}$/.test((request as ProjectAnnotationRestoreRequest).fingerprint))
  )
    throw new CliError("validation_error", "project annotation fingerprint is required")
  return { snapshot, projectId: Number(request.project.slice(8)) }
}
