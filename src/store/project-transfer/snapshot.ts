import { CliError } from "@wirecat/cli-base"
import { openStoreContext } from "../sqlite/open-store.js"
import { SnapshotBudget } from "../sqlite/project-transfer/budget.js"
import { projectAnnotationSnapshot } from "../sqlite/project-transfer/snapshot.js"
import { type ProjectAnnotationSnapshot, projectAnnotationSnapshotFingerprint } from "./snapshot-model.js"

export type { ProjectAnnotationSnapshot } from "./snapshot-model.js"
export {
  decodeProjectAnnotationSnapshot,
  projectAnnotationSnapshotFingerprint,
  projectAnnotationSnapshotSchema,
} from "./snapshot-model.js"

export interface ProjectAnnotationSnapshotOptions {
  source: string
  project: string
  env?: NodeJS.ProcessEnv
  maxReadBytes?: number
}
export interface ProjectAnnotationSnapshotResult {
  snapshot: ProjectAnnotationSnapshot
  fingerprint: string
  read_bytes: number
  records: number
}

/** No source maintenance, source fetching or output-file publication belongs to a snapshot read. */
export const snapshotProjectAnnotations = async (
  options: ProjectAnnotationSnapshotOptions,
): Promise<ProjectAnnotationSnapshotResult> => {
  if (!options || typeof options !== "object" || Array.isArray(options))
    throw new CliError("validation_error", "snapshot options are required")
  for (const field of Object.keys(options))
    if (!["source", "project", "env", "maxReadBytes"].includes(field))
      throw new CliError("validation_error", `unknown snapshot field ${field}`)
  if (typeof options.source !== "string" || !options.source.trim() || options.source.length > 4096)
    throw new CliError("validation_error", "snapshot source is an explicit existing store path")
  if (
    typeof options.project !== "string" ||
    !/^project:[1-9]\d*$/.test(options.project) ||
    !Number.isSafeInteger(Number(options.project.slice(8)))
  )
    throw new CliError("validation_error", "snapshot project is a project:<safe integer id> reference")
  const budget = new SnapshotBudget(options.maxReadBytes ?? 4 * 1024 * 1024)
  const context = await openStoreContext({ path: options.source, env: options.env, readOnly: true })
  try {
    const result = projectAnnotationSnapshot(context.database, Number(options.project.slice(8)), budget)
    return { ...result, fingerprint: projectAnnotationSnapshotFingerprint(JSON.stringify(result.snapshot)) }
  } finally {
    context.database.close()
  }
}
