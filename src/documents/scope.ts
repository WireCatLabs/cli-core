import { CliError } from "@wirecat/cli-base"
import type { SourceFile } from "./model.js"

export const within = <F extends SourceFile>(
  file: F,
  roots: string[],
  folders: Record<string, F>,
  seen = new Set<string>(),
  cut?: (folder: F) => boolean,
): boolean => {
  if (file.trashed) return false
  if (roots.includes(file.id)) return true
  if (seen.has(file.id)) throw new CliError("invalid_response", "folder ancestry contains a cycle")
  const next = new Set([...seen, file.id])
  return file.parents.some((id) => {
    const folder = folders[id]
    if (!folder) return roots.includes(id)
    return !cut?.(folder) && within(folder, roots, folders, next, cut)
  })
}

/**
 * A saved query beside the selected folders: `include` adds the files it finds wherever they sit, `exclude` keeps the
 * files it matches out even inside a selected folder, and everything below a folder or page it matches.
 */
export interface SourceQuery<M extends SourceFile = SourceFile> {
  /** Part of the sync's scope: a changed query or mode plans the sync again from the start. */
  key: string
  mode: "include" | "exclude"
  matches(file: M): boolean
  /** Every file the query finds, read on each sync: a file shared by another owner may never reach the change feed. */
  list?(): Promise<M[]>
}

export const inScope = <M extends SourceFile>(
  file: M,
  roots: string[],
  folders: Record<string, M>,
  matched: ReadonlySet<string> = new Set(),
  query?: SourceQuery<M>,
): boolean => {
  if (file.trashed) return false
  const excluded = query?.mode === "exclude" ? query.matches : undefined
  if (excluded?.(file)) return false
  return matched.has(file.id) || within(file, roots, folders, new Set(), excluded)
}
