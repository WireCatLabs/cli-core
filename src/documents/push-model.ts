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
/** Which side a stretch both sides changed keeps: the local file, the remote, or both one after the other. */
export type Keep = "local" | "remote" | "both"
/** One stretch both sides changed, as text a person can compare. */
export interface ConflictPart {
  base: string
  local: string
  remote: string
}
/** The remote's last change, when the provider can tell. */
export interface RemoteChange {
  changedAt?: string
  changedBy?: string
}
/**
 * What a sync found before writing. `local` is the file's new content when the remote changed it; `write` runs
 * after it and reaches the remote only when `remote` is true, so a conflict or a file with nothing to change
 * never counts as a write.
 */
export type Prepared<S> =
  | { conflict: string; parts?: ConflictPart[]; remote?: RemoteChange }
  | { missing: true }
  | { unchanged: Pushed<S> }
  | { local?: string; remote: boolean; write(): Promise<Pushed<S>> }

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
  /**
   * Reads the remote and merges it with the local file against `recorded`, what the last sync left on both sides.
   * A stretch both sides changed is a conflict unless `keep` says which side wins.
   */
  prepare(input: {
    id: string
    file: LocalDocument
    recorded: S
    keep?: Keep
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
