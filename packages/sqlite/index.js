import { existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

export const SQLITE_VERSION = "3.53.4"
export const SQLITE_VEC_VERSION = "0.1.9"

const here = dirname(fileURLToPath(import.meta.url))

const folderFor = ({ platform, arch, musl }) =>
  platform === "darwin"
    ? "darwin"
    : platform === "linux"
      ? `linux-${arch}-${musl ? "musl" : "gnu"}`
      : platform === "win32" && arch === "x64"
        ? "win32-x64"
        : undefined

const existing = (folder, file) => {
  if (folder === undefined) return undefined
  const path = join(here, "lib", folder, file)
  return existsSync(path) ? path : undefined
}

export const libraryFor = ({ platform = process.platform, arch = process.arch, musl = false } = {}) =>
  platform === "win32"
    ? undefined
    : existing(folderFor({ platform, arch, musl }), platform === "darwin" ? "libsqlite3.dylib" : "libsqlite3.so.0")

export const extensionFor = ({ platform = process.platform, arch = process.arch, musl = false } = {}) =>
  existing(
    folderFor({ platform, arch, musl }),
    platform === "darwin" ? "vec0.dylib" : platform === "win32" ? "vec0.dll" : "vec0.so",
  )
