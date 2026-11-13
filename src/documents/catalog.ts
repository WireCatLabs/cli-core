import type { SourceFile, SourceState } from "./model.js"
import { inScope, type SourceQuery } from "./scope.js"

export const catalogFiles = <M extends SourceFile>(
  state: SourceState<M>,
  roots: string[],
  query?: SourceQuery<M>,
): M[] => {
  const folders = state.pending?.folders ?? state.folders
  const matched = new Set(state.pending?.matched ?? state.matched ?? [])
  const files = new Map<string, M>(Object.values(state.documents).map((doc) => [doc.metadata.id, doc.metadata]))
  for (const skip of state.skipped) if (skip.file) files.set(skip.id, skip.file)
  for (const file of Object.values(folders)) files.set(file.id, file)
  for (const job of state.pending?.jobs ?? []) {
    if (job.kind === "remove") files.delete(job.id)
    else if (job.file) files.set(job.id, job.file)
  }
  return [...files.values()].filter((file) => inScope(file, roots, folders, matched, query))
}
