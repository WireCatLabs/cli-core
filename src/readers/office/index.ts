import { documentExtractor, documentKind, readDocument } from "../../attachments/documents.js"
import type { Reader } from "../types.js"

export const office: Reader = {
  id: "office",
  version: documentExtractor("odt"),
  accepts: (hint) => documentKind(hint) !== undefined,
  read: async (bytes, hint, { signal }) => {
    const kind = documentKind(hint)
    return kind ? readDocument(bytes, kind, signal) : { status: "unsupported" }
  },
}
