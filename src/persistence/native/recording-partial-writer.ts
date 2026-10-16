import { randomUUID } from "node:crypto"
import { type FileHandle, open, rename, unlink } from "node:fs/promises"
import { join } from "node:path"
import { CliError } from "@wirecat/cli-base"
import { sameOrdinaryFile, syncDirectory } from "../../files/index.js"
import type { RecordingPartial, RecordingTransferWriter } from "../../meetings/index.js"
import { type fingerprintPartial, metadataLimit, missing } from "./recording-partial-metadata.js"

export const partialWriter = async (input: {
  file: FileHandle
  path: string
  root: string
  prefix: string
  metadataPath: string
  partial: RecordingPartial
  fingerprint: Awaited<ReturnType<typeof fingerprintPartial>>
  persistent: boolean
  maxBytes: number
  signal?: AbortSignal
  complete(value: RecordingPartial | null): void
}): Promise<RecordingTransferWriter> => {
  const { file, signal, partial } = input
  const owned = await file.stat({ bigint: true })
  let size = input.fingerprint.offset
  const hash = input.fingerprint.hash
  let closed = false
  let failed = false
  const usable = async () => {
    signal?.throwIfAborted()
    if (closed || failed) throw new CliError("validation_error", "recording partial writer is no longer writable")
    if (!(await sameOrdinaryFile(input.path, owned)))
      throw new CliError("validation_error", "recording partial changed before append")
  }
  const checkpoint = async () => {
    await usable()
    await file.sync()
    if (!partial.validator || !input.persistent) {
      await syncDirectory(input.root)
      return
    }
    const content = JSON.stringify({ ...partial, offset: size, sha256: hash.copy().digest("hex") })
    if (Buffer.byteLength(content) > metadataLimit)
      throw new CliError("validation_error", "recording partial metadata exceeds its byte limit")
    const temp = join(input.root, `${input.prefix}${randomUUID()}.tmp`)
    const metadata = await open(temp, "wx", 0o600)
    try {
      try {
        await metadata.writeFile(content)
        await metadata.sync()
      } finally {
        await metadata.close()
      }
      await usable()
      await rename(temp, input.metadataPath)
      await syncDirectory(input.root)
    } finally {
      await unlink(temp).catch((error) => {
        if (!missing(error)) throw error
      })
    }
  }
  return {
    write: async (bytes) => {
      await usable()
      if (!(bytes instanceof Uint8Array) || bytes.length > input.maxBytes - size)
        throw new CliError("validation_error", "recording partial exceeds its byte limit")
      let offset = 0
      try {
        while (offset < bytes.length) {
          signal?.throwIfAborted()
          const written = (await file.write(bytes, offset, bytes.length - offset, size + offset)).bytesWritten
          if (written === 0) throw new CliError("configuration_error", "recording partial write did not progress")
          offset += written
        }
        hash.update(bytes)
        size += bytes.length
      } catch (error) {
        failed = true
        throw error
      }
    },
    checkpoint,
    finish: async () => {
      await checkpoint()
      const sha256 = hash.copy().digest("hex")
      input.complete(partial.validator ? { ...partial, offset: size, sha256 } : null)
      return { size, sha256 }
    },
    close: async () => {
      if (closed) return
      closed = true
      try {
        await file.close()
      } catch (error) {
        input.complete(null)
        throw error
      }
    },
  }
}
