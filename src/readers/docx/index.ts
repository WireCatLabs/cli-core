import { readContainer } from "../../attachments/container.js"
import { capped, extensionOf, startsWith, withEngine } from "../engine.js"
import type { Reader } from "../types.js"

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"

interface Mammoth {
  extractRawText(input: { buffer: Buffer }): Promise<{ value: string }>
}

export const docx: Reader = {
  id: "docx",
  version: "mammoth",
  accepts: (hint, head) => startsWith(head, "PK\u0003\u0004") && (extensionOf(hint) === ".docx" || hint.mime === DOCX),
  read: (bytes, _hint, { load, signal }) =>
    withEngine<Mammoth>(load, "mammoth", async (mammoth, extractor) => {
      await readContainer(bytes, signal)
      const { value } = await mammoth.extractRawText({ buffer: Buffer.from(bytes) })
      return value.trim() === ""
        ? { status: "needs-agent", extractor }
        : { status: "extracted", text: capped(value), extractor }
    }),
}
