import { randomUUID } from "node:crypto"
import type { BigIntStats } from "node:fs"
import { open, rename, unlink } from "node:fs/promises"
import { join } from "node:path"
import { CliError } from "@wirecat/cli-base"
import { openOrdinaryFile, sameOrdinaryFile, syncDirectory } from "../../files/index.js"
import { missing } from "./recording-partial-metadata.js"

/** The host validates its legacy format, including scope and provider metadata. */
export interface RecordingPublicationCodec<T> {
  encode(value: T): string
  decode(value: unknown): T
}

export const readPublicationJournal = async <T>(
  path: string,
  codec: RecordingPublicationCodec<T>,
  limit: number,
  signal?: AbortSignal,
): Promise<T | null> => {
  signal?.throwIfAborted()
  let file: Awaited<ReturnType<typeof openOrdinaryFile>>
  try {
    file = await openOrdinaryFile(path)
  } catch (error) {
    if (missing(error)) return null
    throw error
  }
  try {
    if ((await file.stat()).size > limit) throw new Error("metadata limit")
    const identity = await file.stat({ bigint: true })
    const bytes = Buffer.alloc(limit + 1)
    let size = 0
    while (size < bytes.length) {
      signal?.throwIfAborted()
      const count = (await file.read(bytes, size, bytes.length - size, size)).bytesRead
      if (!count) break
      size += count
    }
    if (size > limit) throw new Error("metadata limit")
    if (!(await sameOrdinaryFile(path, identity))) throw new Error("journal changed")
    const value = codec.decode(JSON.parse(bytes.subarray(0, size).toString("utf8")))
    signal?.throwIfAborted()
    return value
  } catch {
    signal?.throwIfAborted()
    throw new CliError("validation_error", "recording recovery record does not match this scoped asset")
  } finally {
    await file.close()
  }
}

export const writePublicationJournal = async <T>(
  root: string,
  path: string,
  prefix: string,
  value: T,
  codec: RecordingPublicationCodec<T>,
  limit: number,
  signal?: AbortSignal,
) => {
  signal?.throwIfAborted()
  const content = codec.encode(value)
  if (Buffer.byteLength(content) > limit)
    throw new CliError("validation_error", "recording recovery record exceeds its metadata limit")
  codec.decode(JSON.parse(content))
  const temp = join(root, `${prefix}${randomUUID()}.tmp`)
  const handle = await open(temp, "wx", 0o600)
  let identity: BigIntStats | undefined
  try {
    try {
      identity = await handle.stat({ bigint: true })
      await handle.writeFile(content)
      await handle.sync()
    } finally {
      await handle.close()
    }
    signal?.throwIfAborted()
    if (!identity || !(await sameOrdinaryFile(temp, identity)))
      throw new CliError("validation_error", "recording publication journal changed")
    await rename(temp, path)
    await syncDirectory(root)
    signal?.throwIfAborted()
  } finally {
    if (identity && (await sameOrdinaryFile(temp, identity)))
      await unlink(temp).catch((error) => {
        if (!missing(error)) throw error
      })
  }
}
