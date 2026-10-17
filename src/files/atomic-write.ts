import { randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { type FileHandle, link, open, realpath, rename, unlink } from "node:fs/promises"
import { basename, dirname, join } from "node:path"

export interface AtomicWriteOptions {
  /** The new file's mode; 0o600 when not given. */
  mode?: number
  /** `false` refuses to replace a file already there: the write fails with `EEXIST` and the file stays. */
  overwrite?: boolean
  signal?: AbortSignal
  /** Runs once the content is on disk and before it takes the path — the last moment to refuse, by throwing. */
  beforePublish?: () => void | Promise<void>
}

// Windows cannot open a folder to sync it.
const openFolder = (folder: string): Promise<FileHandle | undefined> =>
  process.platform === "win32"
    ? Promise.resolve(undefined)
    : open(folder, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0))

/**
 * Writes beside `path` and then puts the file in its place, so a reader sees the old file or the whole new one,
 * never half of it. The content is synced before it is published, and the directory after. The folder may be
 * reached through a symlink: it is resolved and opened before anything is written, so a folder that cannot be
 * used refuses the write with nothing on disk, and the directory synced is the one the file went into.
 */
export const writeFileAtomic = async (
  path: string,
  content: string | Uint8Array,
  { mode = 0o600, overwrite = true, signal, beforePublish }: AtomicWriteOptions = {},
): Promise<void> => {
  signal?.throwIfAborted()
  const folder = await realpath(dirname(path))
  const target = join(folder, basename(path))
  const directory = await openFolder(folder)
  try {
    const temporary = join(folder, `.${basename(path)}.${randomUUID()}.tmp`)
    let handle: FileHandle | undefined = await open(temporary, "wx", mode)
    let published = false
    try {
      await handle.writeFile(content)
      await handle.sync()
      await handle.close()
      handle = undefined
      signal?.throwIfAborted()
      await beforePublish?.()
      if (overwrite) await rename(temporary, target)
      else await link(temporary, target)
      published = overwrite
      await directory?.sync()
    } finally {
      await handle?.close().catch(() => undefined)
      if (!published) await unlink(temporary).catch(() => undefined)
    }
  } finally {
    await directory?.close().catch(() => undefined)
  }
}
