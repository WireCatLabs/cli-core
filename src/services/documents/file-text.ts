import { CliError } from "@wirecat/cli-base"
import { extractText, importEngine, MAX_TEXT_CHARS } from "../../attachments/extract.js"
import type { Engine } from "../../readers/types.js"

const READABLE = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "text/csv",
  "text/tab-separated-values",
  "text/plain",
  "text/markdown",
])

/** A file a documents sync reads the text of: PDF, docx, xlsx, CSV, TSV, plain text and Markdown. */
export const readableFile = ({ name, mime }: { name: string; mime: string }): boolean =>
  READABLE.has(mime) || /\.(md|markdown|txt|pdf|docx|xlsx|csv|tsv)$/iu.test(name)

const ENGINE_LABEL: Record<Engine, string> = {
  unpdf: "PDF",
  mammoth: "Word",
  "word-extractor": "Word (.doc)",
  "@napi-rs/canvas": "scanned PDF",
  "defuddle/node": "web page",
  linkedom: "HTML",
}

/**
 * The text of a downloaded file through cli-core's readers, or a `validation_error` that says why there is none, in
 * words a person acts on. `command` names the CLI in the hint for a missing reader.
 */
export const fileText = async (
  bytes: Uint8Array,
  file: { name: string; mime: string },
  command: string,
): Promise<string> => {
  const read = await extractText(
    bytes,
    { kind: "document", name: file.name, mime: file.mime, path: file.name },
    importEngine,
  )
  if (read.status === "extracted") return read.text
  const reason =
    read.status === "needs-agent"
      ? "file has no text layer (a scan or images only); OCR is not supported"
      : read.status === "engine-missing"
        ? `${ENGINE_LABEL[read.engine]} files need the package ${read.engine} installed next to ${command}; then run ${command} <profile> sync --rescan`
        : read.status === "unreadable"
          ? "file could not be read as text; it may be damaged or protected"
          : read.status === "unsupported"
            ? "file contents do not match its type"
            : `file is too large for the document readers (over 50 MB, or over ${MAX_TEXT_CHARS} characters of text)`
  throw new CliError("validation_error", reason)
}
