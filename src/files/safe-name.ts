import { basename, extname } from "node:path"

/** Below the 255 bytes most file systems allow a name, leaving room for a prefix such as a provider id. */
const MOST_NAME_BYTES = 200
const bytesOf = (text: string) => Buffer.byteLength(text, "utf8")

/** A name cut to `most` bytes at a whole character, its extension kept. */
const shortened = (name: string, most: number) => {
  if (bytesOf(name) <= most) return name
  const extension = extname(name)
  const kept = bytesOf(extension) <= 32 ? extension : ""
  let stem = ""
  for (const character of name.slice(0, name.length - kept.length)) {
    if (bytesOf(stem + character) + bytesOf(kept) > most) break
    stem += character
  }
  return stem + kept
}

/**
 * A name another person chose cannot climb out of the folder, cannot be a dot file we would then
 * hide, carries no control or direction character to rewrite the terminal or disguise its extension, and is at most
 * 200 bytes, its extension kept.
 */
export const safeName = (name: string | undefined, platform = process.platform): string | undefined => {
  let plain =
    name === undefined
      ? ""
      : basename(name.replaceAll("\\", "/"))
          .replace(/[\p{Cc}​-‏‪-‮⁦-⁩]/gu, "")
          .replace(/^\.+/, "")
  if (platform === "win32") {
    plain = plain.replace(/[<>:"|?*]/g, "_").replace(/[. ]+$/, "")
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(plain)) return undefined
  }
  return plain === "" ? undefined : shortened(plain, MOST_NAME_BYTES)
}
