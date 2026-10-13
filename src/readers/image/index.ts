import { extensionOf } from "../engine.js"
import type { Reader } from "../types.js"

export const IMAGES = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".heic", ".tif", ".tiff", ".bmp"])

export const image: Reader = {
  id: "image",
  version: "none",
  accepts: (hint) => hint.kind === "photo" || Boolean(hint.mime?.startsWith("image/")) || IMAGES.has(extensionOf(hint)),
  read: async () => ({ status: "needs-agent" }),
}
