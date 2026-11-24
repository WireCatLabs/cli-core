export interface SourceFile {
  id: string
  name: string
  mime: string
  parents: string[]
  version?: string
  modifiedAt?: string
  url: string
  trashed: boolean
  canDownload: boolean
  size?: number
  createdAt?: string
  description?: string
  providerMetadata?: unknown
}

export interface TabText {
  id: string
  title: string
  text: string
}
export interface SourceContent<M extends SourceFile = SourceFile> {
  metadata: M
  markdown: string
  text: string
  tabs: TabText[]
  notRead?: string
  raw?: unknown
}
/**
 * Why a document left the sync's copy. `deleted` only on a direct signal from the source (its trash, a delete event);
 * `unavailable` when the source no longer shows it but may still hold it (a 404 that can mean unshared, lost access);
 * `unsynced` when it left the synced folders.
 */
export type SourceRemoval = "deleted" | "unavailable" | "unsynced"
export interface SourceChange<M extends SourceFile = SourceFile> {
  id: string
  removed: boolean
  /**
   * What a removal means. Left out, a removal counts as `unavailable` and the document keeps its text: a removal
   * from a feed can be a lost share as well as a deletion. A source sets `deleted` only when it knows.
   */
  gone?: "deleted" | "unavailable"
  file?: M
}
/**
 * A provider without a change feed (Yandex Disk, WebDAV, S3): every sync walks the selected folders in full, saves only
 * what changed since the last pass, and removes what the finished pass no longer found. A `DocumentSource` is one too.
 */
export interface FeedlessDocumentSource<M extends SourceFile = SourceFile> {
  identity(): Promise<string>
  /**
   * The file `known` is the one the sync last listed under this id, when it has one: a provider that addresses files
   * by path, not by id (Yandex Disk, WebDAV), reads its path from there. The same holds for `children`,
   * `childrenPage`, `content` and `bytes`.
   */
  metadata(id: string, known?: M): Promise<M>
  children(id: string, folder?: M): Promise<M[]>
  /**
   * One page of a folder's children, for a provider whose folder can be too big for one step of a sync (a Notion
   * database of 12,000 rows). A sync with it lists one page per step and saves the cursor between calls. A cursor
   * the provider no longer accepts must fail as `not_found` (through `errorOf`): the sync then lists the folder again
   * from its first page, where any other error fails every later sync on that page until a `--rescan`.
   */
  childrenPage?(id: string, cursor?: string, folder?: M): Promise<{ files: M[]; cursor?: string }>
  content(id: string, maxChars?: number, file?: M): Promise<SourceContent<M>>
  bytes(id: string, file?: M): Promise<Uint8Array>
  /**
   * How many folders a sync lists at once, for a provider whose one listing takes seconds (Yandex Disk): a whole
   * number up to 8; one when unset or anything else. Each listing takes its own request from the run's budget; a source that paces its requests keeps pacing
   * them, so stay within the provider's rate limit.
   */
  parallelListings?: number
  /**
   * Whether a saved document is read again though it did not change: one saved before the source learned to read
   * something (a page's authors). The sync reads at most `REREAD_BATCH` of them a pass, so new edits are not held back;
   * `content()` must give what this asks for, or the document is read again on every pass.
   */
  reread?(saved: IndexedSource<M>): boolean
}
/** A provider with a change feed: after the first walk, a sync reads only what the feed names. */
export interface DocumentSource<M extends SourceFile = SourceFile> extends FeedlessDocumentSource<M> {
  startToken(): Promise<string>
  changes(token: string): Promise<{ items: SourceChange<M>[]; cursor: string }>
}
/** The feed of a source that has one. */
export const feedOf = <M extends SourceFile>(source: FeedlessDocumentSource<M>) =>
  "changes" in source && typeof source.changes === "function" ? (source as DocumentSource<M>) : undefined
export interface IndexedSource<M extends SourceFile = SourceFile> {
  metadata: M
  hash: string
  reference: string
  tabs: number
  notRead?: string
  picture?: "saved" | "too-large"
  /** The OCR reading its text came from (`ScanReader.extractor`); absent for text a reader found in the file. */
  ocr?: string
}
export interface SourceWork<M extends SourceFile = SourceFile> {
  id: string
  kind: "save" | "remove"
  file?: M
  /** A removal's reason; a job saved before reasons existed counts as `unavailable`. */
  reason?: SourceRemoval
}
export interface SourceSkip<M extends SourceFile = SourceFile> {
  id: string
  reason: string
  file?: M
  textLimit?: number
  storeRefusedIn?: string
}
export interface SourceState<M extends SourceFile = SourceFile> {
  version: 1
  principal: string
  scope: string
  cursor?: string
  folders: Record<string, M>
  documents: Record<string, IndexedSource<M>>
  skipped: SourceSkip<M>[]
  pending?: {
    cursor: string
    scope: string
    folders: Record<string, M>
    jobs: SourceWork<M>[]
    skipped: SourceSkip<M>[]
    /** Files a saved query found, in scope wherever they sit. */
    matched?: string[]
  }
  matched?: string[]
  lastSync?: string
}
export interface PictureWriter {
  save(reference: string, bytes: Uint8Array): Promise<"saved" | "unchanged">
  close(): Promise<void>
}

export interface SourceWalk<M extends SourceFile = SourceFile> {
  scope: string
  cursor: string
  /** `listing`: the cursor of the folder's next page, while a source with `childrenPage` is part way through it. */
  stack: { id: string; ancestry: string[]; folder?: M; listing?: string }[]
  visited: string[]
  folders: Record<string, M>
  files: M[]
  discovered: number
  /** Ids of `files` the source itself marked deleted, so a walk resumed in a later call still removes them so. */
  deleted?: string[]
}
export interface SourceIndex<M extends SourceFile = SourceFile> {
  catalog?: { import(principal: string, files: M[]): Promise<unknown> }
  save(principal: string, content: SourceContent<M>, hash: string): Promise<string>
  remove(principal: string, id: string, reason?: SourceRemoval): Promise<void>
  /** Drops the history older than `before` (ISO 8601); a sync calls it when a pass completes. */
  prune?(principal: string, before: string): Promise<unknown>
  openPictures(): Promise<PictureWriter>
  /** Indexes what the sync saved for word search, until `until` says stop; the rest waits for the next search. */
  settle?(options: { until: () => boolean }): Promise<unknown>
  registerProfile?(name: string, principal: string): Promise<void>
}
export interface SourceStatePort<M extends SourceFile = SourceFile> {
  read(): SourceState<M>
  save(state: SourceState<M>): void
  readWalk(scope: string): SourceWalk<M> | undefined
  saveWalk(walk: SourceWalk<M>): void
  removeWalk(): void
  saveSnapshot(content: SourceContent<M>): void
  removeSnapshot(id: string): void
}
