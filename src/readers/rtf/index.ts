import { rtfText } from "../../attachments/markup.js"
import { derived, startsWith } from "../engine.js"
import type { Reader } from "../types.js"

export const rtf: Reader = {
  id: "rtf",
  version: "v1",
  accepts: (_hint, head) => startsWith(head, "{\\rtf"),
  read: async (bytes) => derived(bytes, "rtf:v1", rtfText),
}
