import type { FileHandle } from "node:fs/promises"
import { unlink } from "node:fs/promises"
import { CliError } from "@wirecat/cli-base"
import { openOrdinaryFile, sameOrdinaryFile, syncDirectory } from "../../files/index.js"
import { fingerprintPartial } from "./recording-partial-metadata.js"

export interface RecordingPublicationFingerprint {
  size: number
  sha256: string
}

export const verifiedPublicationFile = async (
  path: string,
  expected: RecordingPublicationFingerprint,
  signal?: AbortSignal,
  writable = false,
): Promise<FileHandle> => {
  signal?.throwIfAborted()
  const file = await openOrdinaryFile(path, { writable })
  try {
    if ((await file.stat()).size !== expected.size)
      throw new CliError("validation_error", "recording recovery final checksum does not match")
    const actual = await fingerprintPartial(file, signal, expected.size)
    if (actual.offset !== expected.size || actual.sha256 !== expected.sha256)
      throw new CliError("validation_error", "recording recovery final checksum does not match")
    return file
  } catch (error) {
    await file.close()
    throw error
  }
}

export const assertPublicationIdentity = async (path: string, file: FileHandle) => {
  if (!(await sameOrdinaryFile(path, await file.stat({ bigint: true }))))
    throw new CliError("validation_error", "recording publication path changed")
}

export const commitPublication = async (
  root: string,
  partialPath: string,
  finalPath: string,
  partial: FileHandle,
  final: FileHandle,
  commit: () => Promise<void>,
  signal?: AbortSignal,
) => {
  await assertPublicationIdentity(partialPath, partial)
  await assertPublicationIdentity(finalPath, final)
  await syncDirectory(root)
  signal?.throwIfAborted()
  await commit()
  signal?.throwIfAborted()
  await assertPublicationIdentity(finalPath, final)
  await assertPublicationIdentity(partialPath, partial)
  await unlink(partialPath)
  await syncDirectory(root)
  signal?.throwIfAborted()
}
