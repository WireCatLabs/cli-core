import { existsSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"

export const SQLITE_VERSION = "3.53.4"
export const SQLITE_VEC_VERSION = "0.1.9"

// From this file, not the caller: pnpm links the platform package only beside this package.
const require = createRequire(import.meta.url)

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
  let root
  try {
    root = dirname(require.resolve(`@wirecat/cli-core-sqlite-${folder}/package.json`))
  } catch {
    return undefined
  }
  const path = join(root, file)
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
