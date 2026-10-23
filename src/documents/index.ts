export {
  type BlockConflict,
  type BlockHunk,
  diffBlocks,
  type Merged,
  mergeBlocks,
} from "../services/documents/block-diff.js"
export { type Complete, extractMemories } from "../services/documents/extraction.js"
export { documentIngestion, type IngestionOptions } from "../services/documents/ingestion.js"
export { type DocumentKnowledge, documentKnowledge } from "../services/documents/knowledge.js"
export { blocksMarkdown, inlineMarkdown, spliceMarkdown } from "../services/documents/markdown-splice.js"
export {
  conflictReport,
  fileMirrorState,
  type Mirror,
  type MirrorSyncOptions,
  mirrorId,
  mirrorStatus,
  syncMirrors,
} from "../services/documents/mirrors.js"
export type { SyncOptions } from "../services/documents/ports.js"
export { extractDocumentMemories, type ImportedSource, type ProposalOptions } from "../services/documents/proposals.js"
export {
  type PushConflict,
  type PushOptions,
  type PushResult,
  planPush,
  pushDocuments,
  scanLocal,
} from "../services/documents/push.js"
export { type SyncResult, syncDocuments } from "../services/documents/sync.js"
export { type Block, blockKey, blockShape, type Inline, type ListKind, normalizeInlines } from "./blocks.js"
export { catalogFiles } from "./catalog.js"
export { markdownBlocks, type PlacedBlock, placedMarkdownBlocks } from "./markdown-blocks.js"
export type {
  DocumentSource,
  IndexedSource,
  PictureWriter,
  SourceChange,
  SourceContent,
  SourceFile,
  SourceIndex,
  SourceSkip,
  SourceState,
  SourceStatePort,
  SourceWalk,
  SourceWork,
  TabText,
} from "./model.js"
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
export { within } from "./scope.js"
