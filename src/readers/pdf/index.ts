import { CliError } from "@wirecat/cli-base"
import { ReaderLimit } from "../../attachments/container.js"
import { MAX_TEXT_CHARS } from "../../attachments/limits.js"
import { capped, startsWith, withEngine } from "../engine.js"
import type { Reader } from "../types.js"

interface PdfDocument {
  numPages: number
  loadingTask: { destroy(): Promise<void> }
}

interface Unpdf {
  getDocumentProxy(data: Uint8Array, options: Record<string, unknown>): Promise<PdfDocument>
  extractText(
    pdf: PdfDocument,
    options: { mergePages: boolean },
  ): Promise<{ text: string | string[]; totalPages?: number }>
}

export const pdf: Reader = {
  id: "pdf",
  version: "unpdf",
  accepts: (_hint, head) => startsWith(head, "%PDF-"),
  read: (bytes, _hint, { load, signal }) =>
    withEngine<Unpdf>(load, "unpdf", async (unpdf, extractor) => {
      const bounded = signal ?? new AbortController().signal
      let pdf: PdfDocument | undefined
      let closed = false
      const close = () => {
        if (pdf && !closed) {
          closed = true
          void pdf.loadingTask.destroy().catch(() => {})
        }
      }
      let abort = () => {}
      const aborted = new Promise<never>((_, reject) => {
        abort = () => {
          close()
          reject(new CliError("cancelled", "PDF text extraction stopped"))
        }
        bounded.addEventListener("abort", abort, { once: true })
        if (bounded.aborted) abort()
      })
      try {
        const reading = async () => {
          bounded.throwIfAborted()
          pdf = await unpdf.getDocumentProxy(new Uint8Array(bytes), {
            isEvalSupported: false,
            verbosity: 0,
            maxImageSize: 20_000_000,
          })
          if (bounded.aborted) {
            close()
            bounded.throwIfAborted()
          }
          if (!Number.isSafeInteger(pdf.numPages) || pdf.numPages < 1) throw new ReaderLimit()
          return unpdf.extractText(pdf, { mergePages: false })
        }
        const result = await Promise.race([reading(), aborted])
        const pages = Array.isArray(result.text) ? result.text : [result.text]
        const text = pages.join("\n\n")
        let at = 0
        const spans = pages.map((page, index) => {
          const span = { page: index + 1, start: at, end: at + page.length }
          at += page.length + 2
          return span
        })
        return text.trim() === ""
          ? { status: "needs-agent", extractor }
          : {
              status: "extracted",
              text: capped(text),
              extractor,
              pages: result.totalPages ?? pages.length,
              spans,
              ...(text.length > MAX_TEXT_CHARS ? { truncated: true } : {}),
            }
      } finally {
        bounded.removeEventListener("abort", abort)
        close()
      }
    }),
}
