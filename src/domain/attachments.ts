import type { Attachment, ProviderMetadata } from "./models.js"

/** Attachments that are never a file, so their messages cost no download request. */
export const NOT_FILES: ReadonlySet<string> = new Set([
  "webpage",
  "share",
  "poll",
  "location",
  "contact",
  "control",
  "call",
  "inline_keyboard",
])

/** A file a message carries, as a search hit names it; `position` counts every attachment, from 1. */
export interface HitFile {
  position: number
  kind: string
  name?: string
  size?: number
}

// The position is taken before the filter: the store numbers every attachment, and `--attachment` takes that number.
// A server search hit built by an adapter may come without attachments at all.
export const hitFiles = (attachments: readonly Attachment[] | undefined): HitFile[] =>
  (attachments ?? []).flatMap(({ kind, name, size }, index) =>
    NOT_FILES.has(kind)
      ? []
      : [
          {
            position: index + 1,
            kind,
            ...(name === undefined ? {} : { name }),
            ...(size === undefined ? {} : { size }),
          },
        ],
  )

/** The stored kinds `has:<kind>` matches: MAX stores a file as `file`, Telegram as `document`. */
export const storedKinds = (kind: string): string[] => (kind === "file" ? ["file", "document"] : [kind])

/** One file `messages download` saved, as the messenger described it. */
export interface DownloadedFile {
  kind: string
  name?: string
  /** The attachment's place in the message, where the adapter knows it. */
  position?: number
  path: string
  /** A new reference the messenger gave while downloading; it replaces the stored one. */
  providerRef?: ProviderMetadata
}

/** A file read without being saved, and the new reference the messenger gave while it was read. */
export interface RefreshedFile {
  kind: string
  name?: string
  position?: number
  providerRef: ProviderMetadata
}

/** What a file is matched to a stored attachment by. */
export type PlacedFile = Pick<DownloadedFile, "kind" | "name" | "position">

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
export const matchDownloads = <F extends PlacedFile>(stored: readonly StoredAttachment[], files: readonly F[]) => {
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

export type UploadKind = "photo" | "file" | "voice"

/** Where an upload's bytes are: a file read only when it is sent, or bytes made in memory (a converted voice). */
export type UploadSource = { kind: "file"; path: string; size: number } | { kind: "bytes"; bytes: Uint8Array }

/** A file checked for sending. Its name goes to the messenger and never to the journal. */
export interface Upload {
  kind: UploadKind
  name: string
  source: UploadSource
  /** A `file` that goes as a file to download even where the messenger would play it — a video. */
  asFile?: true
}

/** A .webp checked for sending as a sticker. Its name goes to the messenger and never to the journal. */
export interface StickerFile {
  name: string
  source: UploadSource
}
