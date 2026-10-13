/** Attachments that are never a file, so their messages cost no download request. */
export const NOT_FILES: ReadonlySet<string> = new Set(["webpage", "share", "poll", "location", "contact"])

/** The stored kinds `has:<kind>` matches: MAX stores a file as `file`, Telegram as `document`. */
export const storedKinds = (kind: string): string[] => (kind === "file" ? ["file", "document"] : [kind])

/** One file `messages download` saved, as the messenger described it. */
export interface DownloadedFile {
  kind: string
  name?: string
  /** The attachment's place in the message, where the adapter knows it. */
  position?: number
  path: string
}

export interface StoredAttachment {
  position: number
  kind: string
  name: string | null
}

/**
 * Which stored attachment each saved file is, or `undefined`. A file's number counts files only — an
 * adapter leaves out attachments it cannot fetch and names their kinds, not their places — so the
 * order is trusted only when the files and the stored file attachments agree one to one by kind. A
 * wrong path is worse than none: text read from it would be credited to another file.
 */
export const matchDownloads = (stored: readonly StoredAttachment[], files: readonly DownloadedFile[]) => {
  const byPosition = new Map(stored.map((one) => [one.position, one]))
  if (files.every(({ position }) => position !== undefined)) {
    return files.map(({ position, kind }) => {
      const one = byPosition.get(position as number)
      return one?.kind === kind ? one.position : undefined
    })
  }
  const fileLike = stored.filter(({ kind }) => !NOT_FILES.has(kind))
  if (fileLike.length === files.length && files.every((file, index) => fileLike[index]?.kind === file.kind)) {
    return fileLike.map(({ position }) => position)
  }
  return files.map(({ name, kind }) => {
    if (!name || files.filter((file) => file.name === name).length > 1) return undefined
    const named = stored.filter((one) => one.name === name && one.kind === kind)
    return named.length === 1 ? named[0]?.position : undefined
  })
}
