import * as v from "valibot"
import { actionableError, batchResult } from "./batch-result.js"
import { count, reference, text } from "./fields.js"

export const extractionItem = v.strictObject({
  ref: reference,
  attachment: count,
  kind: text,
  name: v.nullable(text),
  status: v.picklist(["extracted", "needs-agent", "unreadable", "engine-missing", "too-large", "missing"]),
  extractor: v.optional(text),
  chars: v.optional(count),
  local_path: v.optional(text),
  pages: v.optional(count),
  ocr_pages: v.optional(count),
  error: v.optional(text),
  issue: v.optional(actionableError),
})
export const extractionSummary = v.strictObject({
  extracted: count,
  failed: count,
  needs_agent: count,
  complete: v.boolean(),
  batch: v.optional(batchResult),
})
export const extractionReport = v.strictObject({
  ...extractionSummary.entries,
  items: v.array(extractionItem),
  unchanged: count,
  not_downloaded: count,
  unsupported: count,
  /** Reader package names, such as unpdf or @napi-rs/canvas. */
  engines_missing: v.array(text),
  cursor: v.optional(text),
})
