import { createHash } from "node:crypto"
import type { FileHandle } from "node:fs/promises"
import { CliError } from "@wirecat/cli-base"
import { openOrdinaryFile } from "../../files/index.js"
import type { RecordingAssetLocator, RecordingPartial } from "../../meetings/index.js"

export const metadataLimit = 16384
export const partialIdentity = (locator: RecordingAssetLocator) =>
  JSON.stringify([locator.provider, locator.account, locator.occurrenceId, locator.assetId])
export const missing = (error: unknown) =>
  typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"

export const fingerprintPartial = async (file: FileHandle, signal?: AbortSignal, length?: number) => {
  const hash = createHash("sha256")
  let size = 0
  const buffer = Buffer.alloc(65536)
  for (;;) {
    signal?.throwIfAborted()
    const wanted = length === undefined ? buffer.length : Math.min(buffer.length, length - size)
    if (wanted === 0) break
    const count = (await file.read(buffer, 0, wanted, size)).bytesRead
    signal?.throwIfAborted()
    if (count === 0) break
    size += count
    hash.update(buffer.subarray(0, count))
  }
  return { offset: size, sha256: hash.copy().digest("hex"), hash }
}

export const readPartialMetadata = async (
  path: string,
  locator: RecordingAssetLocator,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<RecordingPartial | null> => {
  let file: FileHandle
  try {
    file = await openOrdinaryFile(path)
  } catch (error) {
    if (missing(error)) return null
    throw error
  }
  try {
    signal?.throwIfAborted()
    if ((await file.stat()).size > metadataLimit) throw new Error("metadata limit")
    const bytes = Buffer.alloc(metadataLimit + 1)
    let size = 0
    while (size < bytes.length) {
      signal?.throwIfAborted()
      const count = (await file.read(bytes, size, bytes.length - size, size)).bytesRead
      if (!count) break
      size += count
    }
    if (size > metadataLimit) throw new Error("metadata limit")
    const value = JSON.parse(bytes.subarray(0, size).toString("utf8")) as RecordingPartial
    if (
      Object.keys(value).some((key) => !["locator", "offset", "sha256", "validator", "total"].includes(key)) ||
      partialIdentity(value.locator) !== partialIdentity(locator) ||
      Object.keys(value.locator).some((key) => !["provider", "account", "occurrenceId", "assetId"].includes(key)) ||
      !Number.isSafeInteger(value.offset) ||
      value.offset < 0 ||
      value.offset > maxBytes ||
      typeof value.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(value.sha256) ||
      typeof value.validator !== "string" ||
      (value.total !== null &&
        (!Number.isSafeInteger(value.total) || value.total < value.offset || value.total > maxBytes))
    )
      throw new Error("metadata shape")
    signal?.throwIfAborted()
    return value
  } catch {
    signal?.throwIfAborted()
    throw new CliError("validation_error", "recording partial metadata is invalid")
  } finally {
    await file.close()
  }
}
