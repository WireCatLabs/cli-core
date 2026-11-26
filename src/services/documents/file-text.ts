import { CliError } from "@wirecat/cli-base"
import { engineHint, extractText, importEngine, MAX_TEXT_CHARS } from "../../attachments/extract.js"
import { attachmentMaxBytes, sizeText } from "../../attachments/limits.js"

const READABLE = new Set([
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.oasis.opendocument.text",
  "application/vnd.oasis.opendocument.spreadsheet",
  "application/vnd.oasis.opendocument.presentation",
  "application/epub+zip",
  "application/rtf",
  "text/rtf",
  "text/html",
  "application/xhtml+xml",
  "text/csv",
  "text/tab-separated-values",
  "text/plain",
  "text/markdown",
])

/**
 * A file a documents sync reads the text of: PDF, Word (doc, docx), RTF, OpenDocument (odt, ods, odp), xlsx, pptx,
 * EPUB, HTML, CSV, TSV, plain text and Markdown. Images and scans are kept by name only.
 */
export const readableFile = ({ name, mime }: { name: string; mime: string }): boolean =>
  READABLE.has(mime) ||
  /\.(md|markdown|txt|pdf|doc|docx|rtf|odt|ods|odp|xlsx|pptx|epub|html?|xhtml|csv|tsv)$/iu.test(name)

/** The start of the reason a file with no text layer is kept by name only, before and after OCR was offered. */
export const NO_TEXT_LAYER = "file has no text layer (a scan or images only)"

/**
 * The text of a downloaded file through cli-core's readers, or a `validation_error` that says why there is none, in
 * words a person acts on. `command` names the CLI in the hint for a missing reader.
 */
export const fileText = async (
  bytes: Uint8Array,
  file: { name: string; mime: string },
  command: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> => {
  const read = await extractText(
    bytes,
    { kind: "document", name: file.name, mime: file.mime, path: file.name },
    importEngine,
    undefined,
    env,
  )
  if (read.status === "extracted") return read.text
  if (read.status === "needs-agent")
    throw new CliError("validation_error", `${NO_TEXT_LAYER}; a documents sync reads it with OCR (read_scans)`, {
      reason: "document.needs-ocr",
    })
  const reason =
    read.status === "engine-missing"
      ? engineHint(read.engine, command)
      : read.status === "unreadable"
        ? "file could not be read as text; it may be damaged or protected"
        : read.status === "unsupported"
          ? "file contents do not match its type"
          : `file is too large for the document readers (over ${sizeText(attachmentMaxBytes(env))}, or over ${MAX_TEXT_CHARS} characters of text)`
  throw new CliError("validation_error", reason)
}
