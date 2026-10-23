import { createHash } from "node:crypto"
import { readdir } from "node:fs/promises"
import { join } from "node:path"
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
    Object.keys(one).sort().join(",") !== "account,chat,kind,message,path,position,provider,sha256,size,version" ||
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
  const actual = await mediaFingerprint(join(root, one.path), signal)
  return actual.size === one.size && actual.sha256 === one.sha256
}
export const commitMediaEntry = (root: string, one: MediaArchiveEntry, beforePublish: () => Promise<void>) =>
  writeFileAtomic(join(root, mediaManifestName(one)), JSON.stringify(parseMediaEntry(one)), {
    overwrite: false,
    beforePublish,
  })
