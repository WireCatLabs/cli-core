import { closeSync, openSync, readSync, realpathSync, statSync } from "node:fs"
import { relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import type { Setup } from "./define.js"
import { SETUP_LIMITS } from "./document.js"

/** PNG, JPEG and WebP by their first bytes, whatever the file is named. */
const IMAGES: ((head: Buffer) => boolean)[] = [
  (head) => head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  (head) => head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff,
  (head) => head.toString("latin1", 0, 4) === "RIFF" && head.toString("latin1", 8, 12) === "WEBP",
]

const headOf = (path: string): Buffer => {
  const head = Buffer.alloc(12)
  const fd = openSync(path, "r")
  try {
    readSync(fd, head, 0, head.length, 0)
  } finally {
    closeSync(fd)
  }
  return head
}

/**
 * What is wrong with the flow's image files, from the package root: each exists inside it (links followed), is a PNG,
 * JPEG or WebP by its first bytes, never SVG, and is at most 2 MB. For the CLI's own test, never at start.
 */
export const setupFileProblems = (setup: Setup, packageRoot: string | URL): string[] => {
  const root = realpathSync(typeof packageRoot === "string" ? packageRoot : fileURLToPath(packageRoot))
  return Object.entries(setup.document.assets ?? {}).flatMap(([id, { file }]) => {
    const where = `assets.${id} (${file})`
    let path: string
    try {
      path = realpathSync(resolve(root, file))
    } catch {
      return [`${where}: no such file in ${root}`]
    }
    const inside = relative(root, path)
    if (inside.startsWith(`..${sep}`) || inside === "..") return [`${where}: leads outside the package`]
    const size = statSync(path).size
    if (size > SETUP_LIMITS.imageBytes) return [`${where}: is ${size} bytes, over ${SETUP_LIMITS.imageBytes}`]
    const head = headOf(path)
    return IMAGES.some((matches) => matches(head)) ? [] : [`${where}: is not a PNG, JPEG or WebP image`]
  })
}
