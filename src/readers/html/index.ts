import { htmlText } from "../../attachments/markup.js"
import { derived, extensionOf } from "../engine.js"
import type { Reader } from "../types.js"

const HTML = new Set([".html", ".htm", ".xhtml"])

export const html: Reader = {
  id: "html",
  version: "v1",
  accepts: (hint) => HTML.has(extensionOf(hint)) || hint.mime === "text/html" || hint.mime === "application/xhtml+xml",
  read: async (bytes) => derived(bytes, "html:v1", htmlText),
}
