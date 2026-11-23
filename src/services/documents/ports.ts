import type { CliError } from "@wirecat/cli-base"
import type { Deadline } from "../../background/budget.js"
import type {
  FeedlessDocumentSource,
  SourceFile,
  SourceIndex,
  SourceSkip,
  SourceStatePort,
} from "../../documents/model.js"
import type { SourceQuery } from "../../documents/scope.js"
export interface SyncOptions<M extends SourceFile> {
  source: FeedlessDocumentSource<M> | undefined
  index: SourceIndex<M>
  state: SourceStatePort<M>
  principal: string
  /** The profile being synced, recorded against `principal` once the signed-in account is checked. */
  profile?: string
  roots: string[]
  query?: SourceQuery<M>
  textLimit: number
  max: number
  /**
   * The entries one call walks, each folder listing counted as one too; the walk saves where it stopped and the next
   * sync goes on from there, so a tree of any size is synced over several calls.
   */
  maxEntries: number
  /** Asked before each folder listing and each file read: a stop ends the call with its work saved. */
  budget?: {
    take(): "requests" | "deadline" | "cancelled" | null
    /** The call's first request, when `take()` said "deadline" and nothing has gone yet (`RunBudget.first`). */
    first?(): boolean
    readonly stopped?: string | null
  }
  /** The run's hard limit: the word index at the end of a sync stops before it, less its margin. */
  deadline?: Deadline
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
  /** How long earlier versions and the change log are kept, in days (`keep_versions_for_days`); 365 unless given. */
  keepVersionsForDays?: number
  now?(): number
}
