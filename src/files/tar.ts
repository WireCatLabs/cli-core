export interface TarEntry {
  /** The path as the archive gives it, PAX and GNU long names applied and a leading `./` dropped. */
  path: string
  /** `0` (or empty) a file, `5` a folder, `1` a hard link, `2` a symbolic link; other types as the archive says. */
  type: string
  mode: number
  data: Uint8Array
}

/** Every entry of a ustar archive, in order. PAX and GNU long names are understood. */
export function* tarEntries(tar: Uint8Array): Generator<TarEntry> {
  const text = (from: number, length: number) =>
    new TextDecoder().decode(tar.subarray(from, from + length)).replace(/\0.*$/s, "")
  let longName: string | undefined
  for (let offset = 0; offset + 512 <= tar.length; ) {
    const name = text(offset, 100)
    if (!name) return
    const mode = Number.parseInt(text(offset + 100, 8).trim() || "0", 8)
    const size = Number.parseInt(text(offset + 124, 12).trim() || "0", 8)
    const type = text(offset + 156, 1)
    const prefix = text(offset + 345, 155)
    const data = tar.subarray(offset + 512, offset + 512 + size)
    offset += 512 + Math.ceil(size / 512) * 512
    if (type === "x") {
      longName = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(new TextDecoder().decode(data))?.[1] ?? longName
      continue
    }
    if (type === "g") continue
    if (type === "L") {
      longName = new TextDecoder().decode(data).replace(/\0.*$/s, "")
      continue
    }
    const path = (longName ?? (prefix ? `${prefix}/${name}` : name)).replace(/^\.\//, "")
    longName = undefined
    yield { path, type, mode, data }
  }
}

/** One regular file of a ustar archive, by its path. */
export const tarMember = (tar: Uint8Array, member: string): Uint8Array | undefined => {
  const wanted = member.replace(/^\.\//, "")
  for (const entry of tarEntries(tar))
    if (entry.path === wanted && (entry.type === "0" || entry.type === "")) return entry.data
  return undefined
}
