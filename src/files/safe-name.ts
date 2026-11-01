import { basename } from "node:path"

/**
 * A name another person chose cannot climb out of the folder, cannot be a dot file we would then
 * hide, and carries no control or direction character to rewrite the terminal or disguise its extension.
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
  return plain === "" ? undefined : plain
}
