import type { SourceFile, SourceState } from "./model.js"
import { within } from "./scope.js"

export const catalogFiles = <M extends SourceFile>(state: SourceState<M>, roots: string[]): M[] => {
  const folders = state.pending?.folders ?? state.folders
  const files = new Map<string, M>(Object.values(state.documents).map((doc) => [doc.metadata.id, doc.metadata]))
  for (const skip of state.skipped) if (skip.file) files.set(skip.id, skip.file)
  for (const file of Object.values(folders)) files.set(file.id, file)
  for (const job of state.pending?.jobs ?? []) {
    if (job.kind === "remove") files.delete(job.id)
    else if (job.file) files.set(job.id, job.file)
  }
  return [...files.values()].filter((file) => within(file, roots, folders))
}
