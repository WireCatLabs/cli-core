import type { CliError } from "@wirecat/cli-base"
import type { DocumentSource, SourceFile, SourceIndex, SourceSkip, SourceStatePort } from "../../documents/model.js"
export interface SyncOptions<M extends SourceFile> {
  source: DocumentSource<M> | undefined
  index: SourceIndex<M>
  state: SourceStatePort<M>
  principal: string
  roots: string[]
  textLimit: number
  max: number
  maxEntries: number
  limitError?(): CliError
  isFolder(file: M): boolean
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
