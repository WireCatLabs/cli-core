import type { CliError } from "@wirecat/cli-base"
import type { DocumentSource, SourceFile, SourceIndex, SourceSkip, SourceStatePort } from "../../documents/model.js"
import type { SourceQuery } from "../../documents/scope.js"
export interface SyncOptions<M extends SourceFile> {
  source: DocumentSource<M> | undefined
  index: SourceIndex<M>
  state: SourceStatePort<M>
  principal: string
  roots: string[]
  query?: SourceQuery<M>
  textLimit: number
  max: number
  maxEntries: number
  limitError?(): CliError
  isFolder(file: M): boolean
  /**
   * A folder that is a document too, such as a wiki page with sub-pages: walked for its children and imported
   * itself. Left out, no folder is imported.
   */
  isDocument?(file: M): boolean
  skipReason(file: M): string | undefined
  retryable(skip: SourceSkip<M>, limit: number): boolean
  errorOf(error: unknown): CliError
  assertHeld(): void
  storeVersion: string
  signal?: AbortSignal
  rescan?: boolean
  pictures?: boolean
  now?(): number
}
