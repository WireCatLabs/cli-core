export {
  type BlockConflict,
  type BlockHunk,
  diffBlocks,
  type Merged,
  mergeBlocks,
} from "../services/documents/block-diff.js"
export { type Complete, extractMemories } from "../services/documents/extraction.js"
export { fileText, readableFile } from "../services/documents/file-text.js"
export { documentIngestion, type IngestionOptions } from "../services/documents/ingestion.js"
export { type DocumentKnowledge, documentKnowledge } from "../services/documents/knowledge.js"
export { blocksMarkdown, inlineMarkdown, spliceMarkdown } from "../services/documents/markdown-splice.js"
export {
  type MirrorLocalCheck,
  type MirrorTrigger,
  type MirrorWatchEvent,
  type MirrorWatchOptions,
  watchMirrors,
} from "../services/documents/mirror-watch.js"
export {
  conflictReport,
  fileMirrorState,
  type HeldLock,
  type Mirror,
  type MirrorSyncOptions,
  mirrorId,
  mirrorStatus,
  syncMirrors,
} from "../services/documents/mirrors.js"
export type { SyncOptions } from "../services/documents/ports.js"
export { extractDocumentMemories, type ImportedSource, type ProposalOptions } from "../services/documents/proposals.js"
export {
  type MirrorAction,
  type PushConflict,
  type PushOptions,
  type PushResult,
  planPush,
  pushDocuments,
  scanLocal,
  skippedName,
} from "../services/documents/push.js"
export { KEEP_VERSIONS_FOR_DAYS, type SyncResult, syncDocuments } from "../services/documents/sync.js"
export {
  type FileConflictResolution,
  type FileConflictResolveOptions,
  type FileConflictVersion,
  type FileConflictView,
  listFileConflicts,
  resolveFileConflict,
  showFileConflict,
} from "../services/files/conflicts.js"
export { excludedBy, exclusionPattern } from "../services/files/exclusions.js"
export {
  type GuardedFileWrite,
  type GuardedFileWriteResult,
  guardedFileWrite,
} from "../services/files/guarded-write.js"
export {
  type FileMirrorOptions,
  type FileMirrorResult,
  type FileMirrorSyncOptions,
  type FileStep,
  fileMirrorStatus,
  fileRemoteChanges,
  fileSyncState,
  MAX_DELETIONS,
  MAX_REPLACEMENTS,
  type MirrorHints,
  syncFileMirror,
  syncFileMirrors,
} from "../services/files/mirror.js"
export {
  MAX_MERGE_BYTES,
  mergeable,
  mergeText,
  type TextMerge,
  type TextSegment,
} from "../services/files/text-merge.js"
export {
  type FileVersion,
  type FileVersions,
  fileVersions,
  restoreFileVersion,
  type VersionDirection,
  type VersionEvent,
  type VersionParts,
  type VersionRole,
} from "../services/files/versions.js"
export { type Block, blockKey, blockShape, type Inline, type ListKind, normalizeInlines } from "./blocks.js"
export { catalogFiles } from "./catalog.js"
export type {
  Expect,
  FileConflict,
  FileEntry,
  FileMirrorState,
  FileMirrorStatePort,
  FileStepKind,
  FileTarget,
  RemoteFile,
} from "./file-mirror-model.js"
export { htmlToMarkdown, markdownToHtml } from "./html-markdown.js"
export { markdownBlocks, type PlacedBlock, placedMarkdownBlocks } from "./markdown-blocks.js"
export type {
  DocumentSource,
  FeedlessDocumentSource,
  IndexedSource,
  PictureWriter,
  SourceChange,
  SourceContent,
  SourceFile,
  SourceIndex,
  SourceRemoval,
  SourceSkip,
  SourceState,
  SourceStatePort,
  SourceWalk,
  SourceWork,
  TabText,
} from "./model.js"
export { feedOf } from "./model.js"
export type {
  ConflictPart,
  DocumentTarget,
  Keep,
  LocalDocument,
  Prepared,
  PushEntry,
  Pushed,
  PushPlan,
  PushState,
  PushStatePort,
  RemoteChange,
} from "./push-model.js"
export { inScope, type SourceQuery, within } from "./scope.js"
