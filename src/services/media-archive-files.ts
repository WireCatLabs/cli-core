import { lstat } from "node:fs/promises"
import { CliError } from "@wirecat/cli-base"
import type { RecordingAssetLocator } from "../meetings/index.js"
import { NativeRecordingPartialStore, NativeRecordingPublication } from "../persistence/native/index.js"
import type { RemoteFile } from "../ports/messenger.js"
import {
  commitMediaEntry,
  type MediaArchiveEntry,
  type MediaIdentity,
  mediaKey,
  missingMediaFile,
  parseMediaEntry,
} from "./media-archive-manifest.js"

const validator = '"media-completed-v1"'
const maximumFileBytes = 64 * 1024 * 1024 * 1024

export const archiveMediaFile = async (
  root: string,
  identity: MediaIdentity,
  kind: string,
  file: () => Promise<RemoteFile>,
  beforeWrite: () => Promise<void>,
  signal?: AbortSignal,
): Promise<MediaArchiveEntry> => {
  const key = mediaKey(identity)
  const locator: RecordingAssetLocator = {
    provider: identity.provider,
    account: identity.account,
    occurrenceId: mediaKey({ ...identity, position: 0 }),
    assetId: key,
  }
  const storage = new NativeRecordingPartialStore(root, locator, {
    prefix: ".media-partial-",
    persistent: true,
    maxBytes: maximumFileBytes,
    signal,
  })
  const publication = new NativeRecordingPublication<MediaArchiveEntry>(root, locator, {
    prefix: ".media-publication-",
    filename: `${key}.bin`,
    maxBytes: maximumFileBytes,
    metadataLimit: 16384,
    codec: {
      encode: JSON.stringify,
      decode: (value) => {
        const one = parseMediaEntry(value)
        if (mediaKey(one) !== key || one.kind !== kind)
          throw new CliError("validation_error", "media recovery identity mismatch")
        return one
      },
    },
    evidence: (one) => ({ size: one.size, sha256: one.sha256, validator }),
    signal,
  })
  const commit = async (one: MediaArchiveEntry) => {
    await beforeWrite()
    await commitMediaEntry(root, one, beforeWrite)
  }
  let exists = false
  try {
    await lstat(publication.finalPath)
    exists = true
  } catch (error) {
    if (!missingMediaFile(error)) throw error
  }
  const intent = await publication.read()
  if (exists) {
    await beforeWrite()
    return publication.recover(storage.path, () => storage.load(locator), commit)
  }
  if (intent) {
    const partial = await storage.load(locator)
    if (
      !partial ||
      partial.offset !== intent.size ||
      partial.sha256 !== intent.sha256 ||
      partial.validator !== validator
    )
      throw new CliError("validation_error", "completed media recovery evidence is missing; choose a new destination")
    await beforeWrite()
    await publication.publish(storage.path, intent, () => commit(intent))
    return intent
  }
  const remote = await file()
  if (
    remote.size !== undefined &&
    (!Number.isSafeInteger(remote.size) || remote.size < 0 || remote.size > maximumFileBytes)
  )
    throw new CliError("validation_error", "invalid media download size")
  await beforeWrite()
  // No range validators are exposed by messenger streams. A cut download restarts; only finish writes a checkpoint.
  const writer = await storage.open(locator, { validator, total: remote.size ?? null })
  let proof: { size: number; sha256: string }
  try {
    let received = 0
    for await (const chunk of remote.bytes()) {
      await beforeWrite()
      await writer.write(chunk)
      received += chunk.length
    }
    if (remote.size !== undefined && received !== remote.size)
      throw new CliError("invalid_response", "media download ended with a different size")
    proof = await writer.finish()
  } finally {
    await writer.close()
  }
  const entry = parseMediaEntry({ ...identity, version: 1, kind, path: `${key}.bin`, ...proof })
  await beforeWrite()
  await publication.write(entry)
  await beforeWrite()
  await publication.publish(storage.path, entry, () => commit(entry))
  return entry
}
