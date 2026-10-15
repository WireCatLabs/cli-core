import { type BigIntStats, constants } from "node:fs"
import { type FileHandle, lstat, open } from "node:fs/promises"
import { CliError } from "@wirecat/cli-base"

// Node 22's Windows path stat uses a 64-bit volume serial; handle stat uses its low DWORD.
const deviceOf = (dev: bigint) => (process.platform === "win32" ? BigInt.asUintN(32, dev) : dev)
const sameIdentity = (left: BigIntStats, right: BigIntStats) =>
  left.ino === right.ino && deviceOf(left.dev) === deviceOf(right.dev)

/** Check the opened object before reading: Windows has no O_NOFOLLOW support. */
export const openOrdinaryFile = async (path: string): Promise<FileHandle> => {
  const before = await lstat(path, { bigint: true })
  if (before.isSymbolicLink())
    throw new CliError("validation_error", "archive path must be an ordinary file without a symlink")
  if (!before.isFile()) throw new CliError("validation_error", "archive path must be an ordinary file")
  const flags =
    process.platform === "win32"
      ? constants.O_RDONLY
      : constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)
  const file = await open(path, flags)
  try {
    const opened = await file.stat({ bigint: true })
    const after = await lstat(path, { bigint: true })
    if (!opened.isFile() || !after.isFile() || before.ino !== opened.ino || before.ino !== after.ino)
      throw new CliError("validation_error", "archive file changed while opening")
    if (process.platform === "win32" && before.dev === 0n && after.dev === 0n) {
      // Older Windows path stats omit the device; compare two handles before any content read.
      const witness = await open(path, flags)
      try {
        const identified = await witness.stat({ bigint: true })
        const final = await lstat(path, { bigint: true })
        if (
          opened.dev === 0n ||
          !identified.isFile() ||
          !final.isFile() ||
          !sameIdentity(identified, opened) ||
          final.ino !== before.ino ||
          (final.dev !== 0n && deviceOf(final.dev) !== deviceOf(opened.dev))
        )
          throw new CliError("validation_error", "archive file changed while opening")
      } finally {
        await witness.close()
      }
    } else if (deviceOf(before.dev) !== deviceOf(opened.dev) || deviceOf(before.dev) !== deviceOf(after.dev)) {
      throw new CliError("validation_error", "archive file changed while opening")
    }
    return file
  } catch (error) {
    await file.close()
    throw error
  }
}

export const sameOrdinaryFile = async (path: string, created: BigIntStats): Promise<boolean> => {
  let file: FileHandle
  try {
    file = await openOrdinaryFile(path)
  } catch (error) {
    if (
      error instanceof CliError ||
      (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
    )
      return false
    throw error
  }
  try {
    return sameIdentity(created, await file.stat({ bigint: true }))
  } finally {
    await file.close()
  }
}

export const syncDirectory = async (path: string): Promise<void> => {
  if (process.platform === "win32") return
  const directory = await open(path, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0))
  try {
    if (!(await directory.stat()).isDirectory())
      throw new CliError("validation_error", "archive publication directory must be ordinary")
    await directory.sync()
  } finally {
    await directory.close()
  }
}
