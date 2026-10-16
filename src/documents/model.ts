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
export interface SourceChange<M extends SourceFile = SourceFile> {
  id: string
  removed: boolean
  file?: M
}
export interface DocumentSource<M extends SourceFile = SourceFile> {
  identity(): Promise<string>
  metadata(id: string): Promise<M>
  children(id: string): Promise<M[]>
  startToken(): Promise<string>
  changes(token: string): Promise<{ items: SourceChange<M>[]; cursor: string }>
  content(id: string, maxChars?: number): Promise<SourceContent<M>>
  bytes(id: string): Promise<Uint8Array>
}
export interface IndexedSource<M extends SourceFile = SourceFile> {
  metadata: M
  hash: string
  reference: string
  tabs: number
  notRead?: string
  picture?: "saved" | "too-large"
}
export interface SourceWork<M extends SourceFile = SourceFile> {
  id: string
  kind: "save" | "remove"
  file?: M
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
  }
  lastSync?: string
}
export interface PictureWriter {
  save(reference: string, bytes: Uint8Array): Promise<"saved" | "unchanged">
  close(): Promise<void>
}

export interface SourceWalk<M extends SourceFile = SourceFile> {
  scope: string
  cursor: string
  stack: { id: string; ancestry: string[]; folder?: M }[]
  visited: string[]
  folders: Record<string, M>
  files: M[]
  discovered: number
}
export interface SourceIndex<M extends SourceFile = SourceFile> {
  catalog?: { import(principal: string, files: M[]): Promise<unknown> }
  save(principal: string, content: SourceContent<M>, hash: string): Promise<string>
  remove(principal: string, id: string): Promise<void>
  openPictures(): Promise<PictureWriter>
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
