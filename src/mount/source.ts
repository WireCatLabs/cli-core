/** One file or folder as a mount shows it. */
export interface MountEntry {
  name: string
  folder: boolean
  size?: number
  /** ISO 8601. */
  modifiedAt?: string
  createdAt?: string
  mime?: string
  /** Changes when the content does, such as an md5; it becomes the ETag. */
  version?: string
}

/** Inclusive, as HTTP's `Range: bytes=start-end`. */
export interface ByteRange {
  start: number
  end: number
}

export interface MountRead {
  body: ReadableStream<Uint8Array>
  /** True when `body` holds only the range asked for; false when the service sent the whole file. */
  ranged: boolean
}

/**
 * What a service hands a mount. It has no method that changes anything, so a mount cannot write, whatever a client
 * asks. Paths are `/` or `/a/b`, under the folder the owner mounted; a missing item throws `not_found`.
 */
export interface MountSource {
  stat(path: string): Promise<MountEntry>
  list(path: string): Promise<MountEntry[]>
  read(path: string, entry: MountEntry, range?: ByteRange): Promise<MountRead>
}
