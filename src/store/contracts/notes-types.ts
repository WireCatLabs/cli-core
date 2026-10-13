import type { LINK_KINDS } from "../sqlite/link-kinds.js"
import type { NoteSearch } from "../sqlite/note-search.js"
import type { Label } from "../sqlite/tags.js"

/** A notes folder: an `accounts` row of provider `folder`. Where it is on disk is this computer's config. */
export interface NoteFolder {
  id: string
  name: string
  format: (typeof NOTE_FORMATS)[number]
  createdAt: string
}

/**
 * A file in a notes folder (a `documents` row, `source` file) or a note the owner wrote (a `notes` row,
 * `source` internal). Their ids overlap, so `ref` — `document:<id>` or `note:<id>` — is what names one.
 */
export interface Note {
  id: string
  ref: string
  source: "file" | "internal"
  folderId: string | null
  path: string | null
  title: string | null
  text: string
  frontMatter: unknown
  contentHash: string | null
  revision: number
  exportPath: string | null
  createdAt: string
  updatedAt: string
  deletedAt: string | null
}

export interface Link {
  id: string
  from: string
  /** `null` while the link names nobody the store knows, or more than one. */
  to: string | null
  kind: (typeof LINK_KINDS)[number]
  anchor: string | null
  origin: (typeof LINK_ORIGINS)[number]
  targetText: string | null
  role: string | null
  evidence: string | null
  provenance: string | null
  confirmed: boolean
  createdAt: string
}

export interface LinkInput {
  from: string
  to?: string
  targetText?: string
  kind: Link["kind"]
  anchor?: string
  origin?: Link["origin"]
  role?: string
  evidence?: string
  provenance?: string
  confirmed?: boolean
}

export interface FileNoteInput {
  folderId: string
  path: string
  title: string | null
  text: string
  frontMatter?: unknown
  contentHash?: string | null
}

export type NoteTag = Label

/** A stored document and the Google file id its links carry. */
export interface MessageDocument {
  /** `document:<id>`, as `drive documents show` takes it. */
  reference: string
  fileId: string
}

export interface NotesStore extends NoteSearch {
  addFolder(input: { name: string; format?: NoteFolder["format"] }): Promise<NoteFolder>
  folders(): Promise<NoteFolder[]>
  saveFileNote(input: FileNoteInput): Promise<{ note: Note; changed: boolean }>
  /** Moves a file note to a new path in its folder, keeping its id, links and tags; a gone note at `to` is dropped. */
  renameFileNote(folderId: string, from: string, to: string): Promise<Note>
  /** Marks the folder's notes at these paths deleted; answers how many were live. */
  deleteFileNotes(folderId: string, paths: string[]): Promise<number>
  /** A note about the things named, the first of them its subject; about nothing, a note to self. */
  addNote(input: { text: string; title?: string; about?: string[] }): Promise<Note>
  /** By reference (`note:12`, `document:5`); a bare id is a note's. */
  note(reference: string): Promise<Note>
  resolveNote(reference: string): Promise<Note | undefined>
  noteReferences(reference: string): Promise<string[]>
  notes(options?: {
    folderId?: string
    source?: Note["source"]
    about?: string
    search?: string
    limit?: number
    offset?: number
  }): Promise<{ items: Note[]; hasMore: boolean }>
  editNote(id: string, text: string, revision: number): Promise<Note>
  removeNote(id: string): Promise<{ id: string; removed: true }>
  addLink(input: LinkInput): Promise<Link>
  links(options?: { from?: string; to?: string; unresolved?: boolean }): Promise<Link[]>
  removeLink(id: string): Promise<{ id: string; removed: true }>
  /** The links a file states, replacing what its last import stated; links the owner added stay. */
  replaceFileLinks(documentId: string, links: Omit<LinkInput, "from" | "origin">[]): Promise<Link[]>
  /**
   * Links every stored message whose text holds a Google link to one of the documents, in any account; a link
   * already there is kept, not doubled. `since` (ISO 8601) looks only at messages stored at or after it.
   * Answers how many links it added.
   */
  linkMessages(input: { documents: MessageDocument[]; since?: string }): Promise<number>
  /**
   * The tags a file states, replacing what its last import stated. A tag the owner added stays, even when
   * the file stops stating it; a file tag the owner also added becomes the owner's.
   */
  replaceFileTags(documentId: string, tags: string[]): Promise<NoteTag[]>
  noteTags(reference: string): Promise<NoteTag[]>
  /** Tries every unresolved link against the people known now; answers how many it resolved. */
  resolveLinks(): Promise<number>
}

export const NOTE_FORMATS = ["obsidian", "markdown"] as const

export const LINK_ORIGINS = ["file", "owner", "suggested", "message"] as const
