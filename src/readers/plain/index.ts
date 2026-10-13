import { decodeText } from "../../attachments/encoding.js"
import { capped, extensionOf } from "../engine.js"
import type { Extraction, FileHint, Reader } from "../types.js"

const PLAIN = new Set([".txt", ".md", ".markdown", ".csv", ".tsv", ".json", ".log"])

export const isPlain = (hint: FileHint) =>
  PLAIN.has(extensionOf(hint)) || hint.mime?.startsWith("text/") || hint.mime === "application/json"

export const readPlain = (bytes: Uint8Array): Extraction => {
  const result = decodeText(bytes)
  if ("error" in result) return { status: "unreadable", extractor: "plain:v2", error: result.error }
  return {
    status: "extracted",
    text: capped(result.text),
    extractor: result.encoding === "utf-8" ? "plain" : `plain:v2:${result.encoding}`,
  }
}

export const plain: Reader = {
  id: "plain",
  version: "v2",
  accepts: (hint) => Boolean(isPlain(hint)),
  read: async (bytes) => readPlain(bytes),
}
