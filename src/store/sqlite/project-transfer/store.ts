import { CliError } from "@wirecat/cli-base"
import { projectAnnotationRequest } from "../../project-transfer/request.js"
import type { ProjectAnnotationStore } from "../../project-transfer/store.js"
import type { StoreContext } from "../open.js"
import { write } from "../transaction.js"
import { SnapshotBudget } from "./budget.js"
import { previewAnnotationSnapshot } from "./preview.js"
import { restoreAnnotationRecords } from "./records.js"

export const projectAnnotationStoreOver = ({ database }: StoreContext): ProjectAnnotationStore => ({
  async preview(request) {
    const { snapshot, projectId } = projectAnnotationRequest(request)
    return previewAnnotationSnapshot(
      database,
      projectId,
      snapshot,
      request.bindings,
      new SnapshotBudget(request.maxReadBytes ?? 4 * 1024 * 1024),
    )
  },
  async restore(request) {
    const { snapshot, projectId } = projectAnnotationRequest(request, true)
    const budget = new SnapshotBudget(request.maxReadBytes ?? 4 * 1024 * 1024)
    try {
      return write(database, () => {
        const preview = previewAnnotationSnapshot(database, projectId, snapshot, request.bindings, budget)
        if (!preview.ready || preview.fingerprint !== request.fingerprint)
          throw new CliError("validation_error", "project annotation preview is stale or has conflicts; preview again")
        const mappings = restoreAnnotationRecords(database, projectId, snapshot, request.bindings)
        return {
          project: request.project,
          fingerprint: preview.fingerprint,
          mappings,
          counts: { aliases: snapshot.aliases.length, facts: snapshot.facts.length, links: snapshot.links.length },
        }
      })
    } catch (error) {
      if (error instanceof CliError) throw error
      throw new CliError("configuration_error", "project annotation restore failed; its transaction was rolled back")
    }
  },
})
