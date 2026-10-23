import * as v from "valibot"
import { count, text, time } from "./fields.js"

export const mediaArchive = v.strictObject({
  directory: text,
  chats: count,
  saved: count,
  existing: count,
  complete: v.boolean(),
})
export const mediaArchiveCheck = v.strictObject({
  valid: v.boolean(),
  checked: count,
  files: v.array(v.strictObject({ path: text, valid: v.boolean(), archive_directory: v.optional(text) })),
})
export const mediaArchiveMove = v.strictObject({
  directory: text,
  archive_directory: text,
  before_time: time,
  selected: count,
  selected_bytes: count,
  moved: count,
  moved_bytes: count,
  already_archived: count,
  undated: count,
  complete: v.boolean(),
  dry_run: v.boolean(),
})
const timer = { name: text, installed: v.boolean(), service_path: text, timer_path: text }
export const mediaArchiveTimer = v.union([
  v.strictObject({ ...timer, active: v.boolean() }),
  v.strictObject({ ...timer, action: v.picklist(["install", "start", "stop", "uninstall"]) }),
])
