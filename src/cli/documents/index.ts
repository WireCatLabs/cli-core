import type { Command } from "commander"
import { addDocumentCatalogCommands, type DocumentCatalogCommands } from "./catalog.js"
import { addLocalDocumentCommands, type LocalDocumentCommands } from "./documents.js"
import { addDocumentFolderCommands, type DocumentFolderCommands } from "./folders.js"
import { addDocumentKnowledgeCommands, type DocumentKnowledgeCommands } from "./knowledge.js"
import { addDocumentMirrorCommands, type DocumentMirrorCommands } from "./mirrors.js"
import { addDocumentSearchCommand, type DocumentSearchCommands } from "./search.js"
import { addDocumentSyncCommands, type DocumentSyncCommands } from "./sync.js"
import type { DocumentWords } from "./words.js"

export {
  addDocumentCatalogCommands,
  CATALOG_FIELDS,
  type CatalogTree,
  type CatalogTreeSource,
  catalogId,
  catalogOutput,
  catalogSource,
  catalogTree,
  type DocumentCatalog,
  type DocumentCatalogCommands,
  type DocumentCatalogStores,
} from "./catalog.js"
export { addLocalDocumentCommands, type ImportedDocument, type LocalDocumentCommands } from "./documents.js"
export { addDocumentFolderCommands, type DocumentFolderCommands } from "./folders.js"
export {
  addDocumentKnowledgeCommands,
  type DocumentKnowledgeCommands,
  type DocumentKnowledgePort,
} from "./knowledge.js"
export { addDocumentMirrorCommands, type DocumentMirrorCommands, type DocumentMirrorConnection } from "./mirrors.js"
export {
  documentQueries,
  FACT_QUERY,
  factItem,
  folderRow,
  identityRowOf,
  linkRow,
  MEMORY_QUERY,
  MEMORY_SEARCH_QUERY,
  memoryItem,
  memorySearch,
  mirrorRow,
  tagRow,
} from "./queries.js"
export { addDocumentSearchCommand, type DocumentSearchCommands, type DocumentSearchOptions } from "./search.js"
export { addDocumentSyncCommands, type DocumentSyncArgs, type DocumentSyncCommands } from "./sync.js"
export { ageOf, type CopyAge, type DocumentTexts, type DocumentWords, staleCopy } from "./words.js"

type Group<T> = Omit<T, "words" | "output">

/** Every shared group at once, for a CLI with nothing of its own between them. */
export interface DocumentCommands<S> {
  words: DocumentWords
  output: DocumentKnowledgeCommands["output"]
  folders: Group<DocumentFolderCommands>
  sync: Group<DocumentSyncCommands>
  documents: Group<LocalDocumentCommands>
  search: Group<DocumentSearchCommands>
  catalog: Group<DocumentCatalogCommands>
  knowledge: Group<DocumentKnowledgeCommands>
  mirrors?: Group<DocumentMirrorCommands<S>>
}

/**
 * `folders`, `sync`, `status`, `documents list|show|export|context`, `search`, `catalog`, the knowledge groups and,
 * when given, `mirrors`, in that order. Answers the `documents` group, for the CLI's live subcommands.
 */
export const addDocumentCommands = <S>(program: Command, options: DocumentCommands<S>): Command => {
  const shared = { words: options.words, output: options.output }
  addDocumentFolderCommands(program, { ...shared, ...options.folders })
  addDocumentSyncCommands(program, { ...shared, ...options.sync })
  const documents = addLocalDocumentCommands(program, { ...shared, ...options.documents })
  addDocumentSearchCommand(program, { ...shared, ...options.search })
  addDocumentCatalogCommands(program, { ...shared, ...options.catalog })
  addDocumentKnowledgeCommands(program, { ...shared, ...options.knowledge })
  if (options.mirrors) addDocumentMirrorCommands(program, { ...shared, ...options.mirrors })
  return documents
}
