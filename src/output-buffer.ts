import { CliError } from "./errors.js"
import type { RenderFormat } from "./renderer.js"
import { fieldsOf, projectFields } from "./result-fields.js"

export interface OutputBufferOptions {
  maxOutputBytes?: number
  fields?: string
  format?: RenderFormat
}
export interface OutputBuffer {
  readonly bytes: number
  /** Raw output chunks, including any delimiters. Projection requires complete JSON values/JSONL lines. */
  data(text: string): void
  /** Consumes the buffer once; the writer receives the exact buffered text, without extra newlines. */
  flush(write: (text: string) => void): void
  discard(): void
}

export const createOutputBuffer = ({
  maxOutputBytes = 4 * 1024 * 1024,
  fields,
  format,
}: OutputBufferOptions = {}): OutputBuffer => {
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 0)
    throw new CliError("validation_error", "maxOutputBytes must be a nonnegative whole byte count")
  const paths = fields === undefined ? undefined : fieldsOf(fields)
  if (paths && format !== "json" && format !== "jsonl")
    throw new CliError("validation_error", "field projection requires an explicit JSON or JSONL format")
  let chunks: string[] = []
  let bytes = 0
  let finished = false
  const requireActive = () => {
    if (finished) throw new CliError("validation_error", "output buffer is already finished")
  }
  return {
    get bytes() {
      return bytes
    },
    data(text) {
      requireActive()
      let result = text
      if (paths) {
        const project = (value: string) => JSON.stringify(projectFields(JSON.parse(value), paths))
        try {
          result =
            format === "jsonl"
              ? text
                  .split("\n")
                  .map((line) => (line.trim() ? project(line) : line))
                  .join("\n")
              : project(text) + (text.endsWith("\n") ? "\n" : "")
        } catch (error) {
          if (error instanceof CliError) throw error
          throw new CliError("invalid_response", "field projection requires complete JSON values or JSONL lines", {
            reason: "projection_unavailable",
            retryable: false,
          })
        }
      }
      const size = Buffer.byteLength(result)
      if (!Number.isSafeInteger(bytes + size) || (maxOutputBytes !== 0 && bytes + size > maxOutputBytes))
        throw new CliError("invalid_response", "output exceeds the configured byte limit", {
          reason: "output_limit",
          maxBytes: maxOutputBytes,
          bufferedBytes: bytes,
          retryable: false,
          partialOutput: false,
        })
      bytes += size
      chunks.push(result)
    },
    flush(write) {
      requireActive()
      finished = true
      const output = chunks
      chunks = []
      for (const text of output) write(text)
    },
    discard() {
      finished = true
      chunks = []
    },
  }
}
