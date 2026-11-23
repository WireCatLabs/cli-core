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
   * Files at paths `excluded` names are listed too, so a file moved there is found by its id, but count toward no cap.
   * An incomplete listing that can go on later returns `next`, its position; given back as `from` in a later run, the
   * listing returns only the files from there on.
   */
  list(
    root: string,
    signal?: AbortSignal,
    options?: { excluded?(path: string): boolean; from?: string },
  ): Promise<{ rootId: string; files: RemoteFile[]; complete: boolean; next?: string } | undefined>
  /**
   * Whether anything is at `path` now, read directly rather than from a listing; false only when the provider says the
   * file was deleted. A file missing from a listing is deleted only once this says so. An answer that cannot tell a
   * deletion from lost access (a 404 that may mean "no longer shared") throws, and the file is left alone.
   */
  exists(path: string, signal?: AbortSignal): Promise<boolean>
  /** Streams the file into `into`, a new local file. */
  download(path: string, into: string, signal?: AbortSignal): Promise<void>
  /**
   * Streams the local file `from` to `path` and returns the file as the remote now has it. With `rewrites`, its hash
   * is of the remote's own form of the text, the bytes `download` gives.
   */
  upload(path: string, from: string, expect: Expect, signal?: AbortSignal): Promise<RemoteFile>
  /** Moves the file to the remote's trash, where the owner can restore it. */
  trash(path: string, expect: Exclude<Expect, { absent: true }>, signal?: AbortSignal): Promise<void>
  /** Creates the folder and its parents; a folder that exists is fine. */
  ensureFolder(path: string, signal?: AbortSignal): Promise<void>
  /**
   * The remote keeps its own form of the text it is sent (Notion's Markdown), so an upload may read back with another
   * hash. The mirror then writes that form into the local file, the earlier one kept, and both sides hold the same
   * bytes again. Without it, such an upload is a conflict.
   */
  rewrites?: boolean
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

/**
 * A conflict the last sync left: why, when, and the contents it found. A side that deleted the file has no hash. The
 * store keeps all three (`kept`) for a text file the merge could not settle; for other files only the hashes are
 * known, and a resolution reads the sides again.
 */
export interface FileConflict {
  reason: string
  at: string
  base?: string
  local?: string
  remote?: string
  /** The remote file as the listing saw it. */
  remoteFile?: RemoteFile
  kept?: boolean
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
  /**
   * A remote listing that stopped before its end: the files listed so far and where the next run goes on. Cleared once
   * a run completes it, or when it is too old, of another root, or cannot go on.
   */
  listing?: { rootId: string; startedAt: string; next: string; files: RemoteFile[] }
  /** The conflicts the last sync left, by path; each sync replaces them, and a resolution removes its own. */
  conflicts?: Record<string, FileConflict>
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
  | "merge"
  | "forget"
  | "conflict"
  | "unknown"
