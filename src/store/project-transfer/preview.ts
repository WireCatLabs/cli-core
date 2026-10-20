import { CliError } from "@wirecat/cli-base"
import { openStoreContext } from "../sqlite/open-store.js"
import { SnapshotBudget } from "../sqlite/project-transfer/budget.js"
import { previewAnnotationSnapshot } from "../sqlite/project-transfer/preview.js"
import { projectAnnotationBindingSources } from "./plan.js"
import { decodeProjectAnnotationSnapshot } from "./snapshot-model.js"

export interface ProjectAnnotationPreviewOptions {
  snapshot: string
  target: string
  project: string
  bindings: Record<string, string>
  maxReadBytes?: number
  env?: NodeJS.ProcessEnv
}
export type ProjectAnnotationPreview = ReturnType<typeof previewAnnotationSnapshot>

export const previewProjectAnnotationSnapshot = async (
  options: ProjectAnnotationPreviewOptions,
): Promise<ProjectAnnotationPreview> => {
  if (!options || typeof options !== "object" || Array.isArray(options))
    throw new CliError("validation_error", "project preview options are required")
  for (const field of Object.keys(options))
    if (!["snapshot", "target", "project", "bindings", "maxReadBytes", "env"].includes(field))
      throw new CliError("validation_error", `unknown project preview field ${field}`)
  const snapshot = decodeProjectAnnotationSnapshot(options.snapshot)
  projectAnnotationBindingSources(snapshot, options.bindings)
  if (typeof options.target !== "string" || !options.target.trim() || options.target.length > 4096)
    throw new CliError("validation_error", "project preview target is an explicit existing store path")
  if (
    typeof options.project !== "string" ||
    !/^project:[1-9]\d*$/.test(options.project) ||
    !Number.isSafeInteger(Number(options.project.slice(8)))
  )
    throw new CliError("validation_error", "project preview project is a project:<safe integer id> reference")
  const budget = new SnapshotBudget(options.maxReadBytes ?? 4 * 1024 * 1024)
  const context = await openStoreContext({ path: options.target, env: options.env, readOnly: true })
  try {
    return previewAnnotationSnapshot(
      context.database,
      Number(options.project.slice(8)),
      snapshot,
      options.bindings,
      budget,
    )
  } finally {
    context.database.close()
  }
}
