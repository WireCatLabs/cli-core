import * as v from "valibot"
import { extractionItem, extractionReport } from "./extraction-report.js"
import { count, reference, text } from "./fields.js"

const fingerprint = v.pipe(text, v.regex(/^[a-f0-9]{64}$/))
/** Resource/image MCP responses put bytes in a separate content block; CLI JSON carries base64 here. */
export const attachmentBytes = v.strictObject({
  ref: reference,
  attachment: count,
  name: v.nullable(text),
  mime_type: text,
  total_bytes: count,
  sha256: fingerprint,
  offset_bytes: count,
  read_bytes: count,
  next_offset_bytes: v.nullable(count),
  complete: v.boolean(),
  base64: v.optional(text),
  pdf: v.optional(v.strictObject({ page: count, page_count: count, source_sha256: fingerprint, source_bytes: count })),
})
/** JSON reports all files and totals; JSONL streams each extraction item. */
export const attachmentExtraction = v.union([
  v.strictObject({ ...v.omit(extractionReport, ["items"]).entries, files: v.array(extractionItem) }),
  extractionItem,
])
export const attachmentTextChange = v.strictObject({
  ref: reference,
  attachment: count,
  origin: v.literal("agent"),
  chars: count,
  replaced: v.nullable(v.picklist(["extracted", "agent"])),
})
