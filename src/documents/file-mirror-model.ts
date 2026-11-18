/** A file in the remote folder, as one listing returns it. */
export interface RemoteFile {
  /** Relative to the listed folder, with `/` separators. */
  path: string
  /** Stays the same across a move or an overwrite, so a remote rename is found by it. */
  id: string
  size: number
  /** The plain sha256 of the content. A file without one (still being processed) is left for the next run. */
  sha256?: string
  md5?: string
  modifiedAt: string
}

/**
 * What a remote write expects to find at the path, from the last listing: nothing, or the file with these hashes.
 * A target that cannot check the condition atomically checks it just before the write.
 */
export type Expect = { absent: true } | { sha256: string; md5?: string }

/**
 * A remote folder of plain files. Writes take the remote path (`root` joined with the relative path) and refuse with
 * a `conflict` CliError when the file is not what `expect` says.
 */
export interface FileTarget {
  identity(): Promise<string>
  /**
   * Every file under `root`, with the root folder's own id; undefined when the folder does not exist. `complete` is
   * false when any page was skipped or a cap was hit: a file missing from such a listing is not taken as deleted.
   */
  list(
    root: string,
    signal?: AbortSignal,
  ): Promise<{ rootId: string; files: RemoteFile[]; complete: boolean } | undefined>
  /** Streams the file into `into`, a new local file. */
  download(path: string, into: string, signal?: AbortSignal): Promise<void>
  /** Streams the local file `from` to `path` and returns the file as the remote now has it. */
  upload(path: string, from: string, expect: Expect, signal?: AbortSignal): Promise<RemoteFile>
  /** Moves the file to the remote's trash, where the owner can restore it. */
  trash(path: string, expect: Exclude<Expect, { absent: true }>, signal?: AbortSignal): Promise<void>
  /** Creates the folder and its parents; a folder that exists is fine. */
  ensureFolder(path: string, signal?: AbortSignal): Promise<void>
  /** A value that moves with every change on the remote, when the provider has one: a watch reads it before listing. */
  revision?(signal?: AbortSignal): Promise<string>
}

/** The last sync of one path: the base of the three-way comparison. */
export interface FileEntry {
  id: string
  size: number
  sha256: string
  md5?: string
  remoteModified: string
  localMtimeMs: number
  localSize: number
  syncedAt: string
}

export interface FileMirrorState {
  version: 1
  principal: string
  root: string
  target: string
  /** Set at the first sync; a later listing with another id means the remote folder was moved or replaced. */
  rootId?: string
  /** The local folder's device and inode at the first sync: another folder at the same path is not this mirror. */
  localRoot?: { dev: number; ino: number }
  entries: Record<string, FileEntry>
  /**
   * Saved before each write. After a crash the next listing settles the write (same content on both sides is
   * adopted); this only names the temporary file to remove and the operation to look up. `created` is false for a
   * download that replaces a file, which is renamed into place whole and so never left partial.
   */
  pending: Record<string, { op: FileStepKind; operationId: string; created?: boolean }>
}

export interface FileMirrorStatePort {
  read(): FileMirrorState
  save(state: FileMirrorState): void
}

export type FileStepKind =
  | "upload"
  | "download"
  | "adopt"
  | "trash-remote"
  | "trash-local"
  | "rename-local"
  | "keep-both"
  | "forget"
  | "conflict"
  | "unknown"
