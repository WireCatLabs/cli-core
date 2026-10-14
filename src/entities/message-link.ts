import * as v from "valibot"
import { reference, text } from "./fields.js"

/** Where a message can be opened: its locator always, a provider link when there is one and who that link reaches. */
export const messageLink = v.strictObject({
  ref: reference,
  url: v.nullable(text),
  access: v.picklist(["public", "restricted", "unknown", "unavailable"]),
  /** Why there is no link. */
  reason: v.nullable(v.picklist(["unsupported_chat", "unsupported_provider", "offline"])),
})
