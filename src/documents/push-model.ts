/** A local file a push mirrors: its path relative to the mirrored folder, with `/` separators. */
export interface LocalDocument {
  path: string
  absolute: string
  hash: string
  kind: string
}
export interface Pushed<S> {
  id: string
  url: string
  /** What the provider reads back after its own write; the next push compares the remote against it. */
  snapshot: S
}
/**
 * What an update found before writing. Only `write` reaches the remote, so a conflict or a file with nothing to
 * change never counts as a write.
 */
export type Prepared<S> =
  | { conflict: string }
  | { missing: true }
  | { unchanged: Pushed<S> }
  | { write(): Promise<Pushed<S>> }

/**
 * A provider that writes local files as its own native documents. Every write is one provider call per
 * file (or one all-or-nothing batch): a write cut in half would read back as somebody else's edit.
 */
export interface DocumentTarget<S> {
  identity(): Promise<string>
  /** The provider's document kind for a local path, or undefined when the path is not pushed. */
  kindOf(path: string): string | undefined
  /** Finds the folder carrying `origin` or creates it: a crash between create and save must not duplicate it. */
  ensureFolder(input: { parent: string; name: string; origin: string }): Promise<string>
  findByOrigin(origin: string): Promise<Pushed<S> | undefined>
  create(input: {
    file: LocalDocument
    name: string
    parent: string
    origin: string
    operationId: string
    signal?: AbortSignal
  }): Promise<Pushed<S>>
  /** Reads the remote and compares it with `recorded`; a conflict instead of a write unless `force`. */
  prepare(input: {
    id: string
    file: LocalDocument
    recorded: S
    force: boolean
    signal?: AbortSignal
  }): Promise<Prepared<S>>
}

export interface PushEntry<S> {
  id: string
  url: string
  kind: string
  hash: string
  snapshot: S
  pushedAt: string
}
export interface PushState<S> {
  version: 1
  principal: string
  root: string
  target: string
  folders: Record<string, string>
  entries: Record<string, PushEntry<S>>
  /** Saved before a create, so a crash after the provider wrote but before this state was saved finds the file. */
  pending: Record<string, { origin: string; operationId: string }>
}
export interface PushStatePort<S> {
  read(): PushState<S>
  save(state: PushState<S>): void
}
export interface PushPlan {
  create: LocalDocument[]
  update: LocalDocument[]
  unchanged: LocalDocument[]
  orphans: string[]
}
