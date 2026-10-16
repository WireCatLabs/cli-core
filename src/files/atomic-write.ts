import { randomUUID } from "node:crypto"
import { type FileHandle, link, open, rename, unlink } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import { syncDirectory } from "./ordinary-file.js"

export interface AtomicWriteOptions {
  /** The new file's mode; 0o600 when not given. */
  mode?: number
  /** `false` refuses to replace a file already there: the write fails with `EEXIST` and the file stays. */
  overwrite?: boolean
  signal?: AbortSignal
  /** Runs once the content is on disk and before it takes the path — the last moment to refuse, by throwing. */
  beforePublish?: () => void | Promise<void>
}

/**
 * Writes beside `path` and then puts the file in its place, so a reader sees the old file or the whole new one,
 * never half of it. The content is synced before it is published, and the directory after.
 */
export const writeFileAtomic = async (
  path: string,
  content: string | Uint8Array,
  { mode = 0o600, overwrite = true, signal, beforePublish }: AtomicWriteOptions = {},
): Promise<void> => {
  signal?.throwIfAborted()
  const folder = dirname(path)
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
    if (overwrite) await rename(temporary, path)
    else await link(temporary, path)
    published = overwrite
    await syncDirectory(folder)
  } finally {
    await handle?.close().catch(() => undefined)
    if (!published) await unlink(temporary).catch(() => undefined)
  }
}
