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
  /**
   * The entries one call walks, each folder listing counted as one too; the walk saves where it stopped and the next
   * sync goes on from there, so a tree of any size is synced over several calls.
   */
  maxEntries: number
  /** @deprecated No longer used: a walk past `maxEntries` stops and goes on in the next sync instead of failing. */
  limitError?(): CliError
  /** Asked before each folder listing and each file read: a stop ends the call with its work saved. */
  budget?: { take(): "requests" | "deadline" | "cancelled" | null }
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
