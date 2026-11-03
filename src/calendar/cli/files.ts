import { readFile, stat } from "node:fs/promises"
import { dirname } from "node:path"
import { CliError, writeSecurely } from "@wirecat/cli-base"

/** The largest .ics file `events import` reads; checked before the file is read whole. */
export const ICS_MAX_BYTES = 10 * 1024 * 1024

type FileError = [code: "not_found" | "permission_error" | "validation_error", reason: string, words: string]
const FILE_ERRORS: Record<string, FileError> = {
  ENOENT: ["not_found", "file.not-found", "does not exist"],
  ENOTDIR: ["not_found", "file.not-found", "is not in a folder that exists"],
  EISDIR: ["validation_error", "file.not-a-file", "is a folder, not a file"],
  EACCES: ["permission_error", "file.denied", "cannot be opened: permission denied"],
  EPERM: ["permission_error", "file.denied", "cannot be opened: permission denied"],
}

/** A file the owner named that cannot be read or written is their error, named by its path, never a crash. */
const named = async <T>(path: string, act: () => Promise<T>): Promise<T> => {
  try {
    return await act()
  } catch (error) {
    const known = FILE_ERRORS[(error as NodeJS.ErrnoException).code ?? ""]
    if (!known) throw error
    const [code, reason, words] = known
    throw new CliError(code, `${path} ${words}`, { reason })
  }
}

export const readIcsFile = (path: string): Promise<string> =>
  named(path, async () => {
    const info = await stat(path)
    if (!info.isFile()) throw new CliError("validation_error", `${path} is not a file`, { reason: "file.not-a-file" })
    if (info.size > ICS_MAX_BYTES)
      throw new CliError("validation_error", `${path} is larger than 10 MB`, { reason: "ics.too-large" })
    return readFile(path, "utf8")
  })

/**
 * 0600 even over an existing file, written whole or not at all: an export holds the owner's meetings, attendees and
 * descriptions. writeSecurely would make a missing folder; an export names one that exists.
 */
export const writeIcsFile = (path: string, content: string): Promise<void> =>
  named(path, async () => {
    await stat(dirname(path))
    writeSecurely(path, content, 0o600)
  })
