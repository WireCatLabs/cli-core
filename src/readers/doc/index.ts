import { capped, extensionOf, startsWith, withEngine } from "../engine.js"
import type { Reader } from "../types.js"

/** OLE2 compound file: every legacy Office binary — .doc, .xls, .ppt — starts with it. */
// biome-ignore lint/security/noSecrets: OLE2 file signature bytes, not a key
const OLE = "\xD0\xCF\x11\xE0\xA1\xB1\x1A\xE1"

interface WordExtractor {
  extract(input: Buffer): Promise<{ getBody(): string }>
}

export const doc: Reader = {
  id: "doc",
  version: "word-extractor",
  accepts: (hint, head) =>
    startsWith(head, OLE) && (extensionOf(hint) === ".doc" || hint.mime === "application/msword"),
  read: (bytes, _hint, { load }) =>
    withEngine<{ default: new () => WordExtractor }>(load, "word-extractor", async (engine, extractor) => {
      const value = (await new engine.default().extract(Buffer.from(bytes))).getBody()
      return value.trim() === ""
        ? { status: "needs-agent", extractor }
        : { status: "extracted", text: capped(value), extractor }
    }),
}
