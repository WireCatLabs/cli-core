import { createHash } from "node:crypto"
import { readdir } from "node:fs/promises"
import { isAbsolute, join, resolve } from "node:path"
import { CliError } from "@wirecat/cli-base"
import { openOrdinaryFile, readBoundedUtf8File, writeFileAtomic } from "../files/index.js"

export interface MediaIdentity {
  provider: string
  account: string
  chat: string
  message: string
  position: number
}
export interface MediaArchiveEntry extends MediaIdentity {
  version: 1
  kind: string
  path: string
  size: number
  sha256: string
  messageTime?: string
  mime?: string
  relocatedTo?: string
}
export const mediaKey = (one: MediaIdentity): string =>
  createHash("sha256")
    .update(JSON.stringify([one.provider, one.account, one.chat, one.message, one.position]))
    .digest("hex")
export const mediaManifestName = (one: MediaIdentity): string => `.media-archive-${mediaKey(one)}.json`
export const missingMediaFile = (error: unknown): boolean =>
  typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
export const parseMediaEntry = (value: unknown): MediaArchiveEntry => {
  const one = value as MediaArchiveEntry
  if (
    !one ||
    typeof one !== "object" ||
    Array.isArray(one) ||
    one.version !== 1 ||
    Object.keys(one).some(
      (key) =>
        ![
          "account",
          "chat",
          "kind",
          "message",
          "path",
          "position",
          "provider",
          "sha256",
          "size",
          "version",
          "messageTime",
          "mime",
          "relocatedTo",
        ].includes(key),
    ) ||
    (one.messageTime !== undefined &&
      (typeof one.messageTime !== "string" ||
        !Number.isFinite(Date.parse(one.messageTime)) ||
        new Date(one.messageTime).toISOString() !== one.messageTime)) ||
    (one.mime !== undefined &&
      (typeof one.mime !== "string" || one.mime.length > 127 || !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(one.mime))) ||
    (one.relocatedTo !== undefined &&
      (typeof one.relocatedTo !== "string" || !isAbsolute(one.relocatedTo) || /[\p{Cc}]/u.test(one.relocatedTo))) ||
    [one.provider, one.account, one.chat, one.message, one.kind].some(
      (text) => typeof text !== "string" || !text.trim() || text.length > 512 || /[\0\r\n]/.test(text),
    ) ||
    !Number.isSafeInteger(one.position) ||
    one.position < 0 ||
    !Number.isSafeInteger(one.size) ||
    one.size < 0 ||
    typeof one.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(one.sha256) ||
    one.path !== `${mediaKey(one)}.bin`
  )
    throw new CliError("validation_error", "invalid media archive manifest")
  return { ...one }
}
export const mediaFingerprint = async (path: string, signal?: AbortSignal) => {
  signal?.throwIfAborted()
  const file = await openOrdinaryFile(path)
  try {
    const hash = createHash("sha256")
    let size = 0
    for await (const chunk of file.createReadStream({ autoClose: false, ...(signal ? { signal } : {}) })) {
      signal?.throwIfAborted()
      hash.update(chunk)
      size += chunk.length
    }
    return { size, sha256: hash.digest("hex") }
  } finally {
    await file.close()
  }
}
export const readMediaManifests = async (root: string, signal?: AbortSignal): Promise<MediaArchiveEntry[]> => {
  const entries: MediaArchiveEntry[] = []
  for (const name of await readdir(root)) {
    signal?.throwIfAborted()
    if (!name.startsWith(".media-archive-") || !name.endsWith(".json")) continue
    let one: MediaArchiveEntry
    try {
      one = parseMediaEntry(JSON.parse(await readBoundedUtf8File(join(root, name), { maxBytes: 16384 })))
    } catch {
      throw new CliError("validation_error", "invalid media archive manifest")
    }
    if (name !== mediaManifestName(one)) throw new CliError("validation_error", "media manifest identity mismatch")
    entries.push(one)
  }
  return entries
}
export const verifyMediaEntry = async (root: string, one: MediaArchiveEntry, signal?: AbortSignal) => {
  let location = resolve(root)
  let entry = one
  const visited = new Set<string>()
  while (entry.relocatedTo !== undefined) {
    signal?.throwIfAborted()
    if (visited.has(location) || visited.size >= 64)
      throw new CliError("validation_error", "media archive relocation cycle or excessive depth")
    visited.add(location)
    location = resolve(entry.relocatedTo)
    const target = parseMediaEntry(
      JSON.parse(await readBoundedUtf8File(join(location, mediaManifestName(one)), { maxBytes: 16384 })),
    )
    if (!sameMediaCopy(one, target)) return false
    entry = target
  }
  if (visited.has(location)) return false
  const actual = await mediaFingerprint(join(location, one.path), signal)
  return actual.size === one.size && actual.sha256 === one.sha256
}
export const sameMediaCopy = (a: MediaArchiveEntry, b: MediaArchiveEntry): boolean =>
  mediaKey(a) === mediaKey(b) &&
  a.size === b.size &&
  a.sha256 === b.sha256 &&
  a.kind === b.kind &&
  a.messageTime === b.messageTime &&
  a.mime === b.mime
export const commitMediaEntry = (root: string, one: MediaArchiveEntry, beforePublish: () => Promise<void>) =>
  writeFileAtomic(join(root, mediaManifestName(one)), JSON.stringify(parseMediaEntry(one)), {
    overwrite: false,
    beforePublish,
  })
