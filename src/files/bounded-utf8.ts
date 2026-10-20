import { CliError } from "@wirecat/cli-base"
import { openOrdinaryFile } from "./ordinary-file.js"

/** Preflight size, bound growing input too, and refuse replacement characters in structured input. */
export const readBoundedUtf8File = async (path: string, { maxBytes }: { maxBytes: number }): Promise<string> => {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 16 * 1024 * 1024)
    throw new CliError("validation_error", "file maxBytes takes 1–16777216 bytes")
  const file = await openOrdinaryFile(path)
  try {
    if ((await file.stat()).size > maxBytes)
      throw new CliError("validation_error", "input file exceeds its byte budget")
    const chunks: Buffer[] = [],
      buffer = Buffer.alloc(Math.min(65536, maxBytes + 1))
    let bytes = 0
    for (;;) {
      const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, maxBytes - bytes + 1), null)
      if (bytesRead === 0) break
      bytes += bytesRead
      if (bytes > maxBytes) throw new CliError("validation_error", "input file exceeds its byte budget")
      chunks.push(Buffer.from(buffer.subarray(0, bytesRead)))
    }
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, bytes))
    } catch {
      throw new CliError("validation_error", "input file must contain valid UTF-8")
    }
  } finally {
    await file.close()
  }
}
