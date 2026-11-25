import * as v from "valibot"
import { count, id, text, time } from "./fields.js"

/** One source of the domain-list pack as this computer holds it (`domain-lists list`, `domain-lists update`). */
export const domainList = v.strictObject({
  id,
  title: text,
  /** `sector` gives an organization its sector; `bad` only marks a host known for spam, phishing or malware. */
  signal: v.picklist(["sector", "bad"]),
  /** `non-commercial`: WireCat may use it, a paid service built around it may not. */
  class: v.picklist(["commercial-ok", "non-commercial"]),
  licence: text,
  licence_url: text,
  attribution: text,
  homepage: text,
  /** Fetched from its source on this computer, since it may not be redistributed. */
  upstream: v.boolean(),
  lines: count,
  /** Lines per sector or category, as published. */
  tags: v.record(v.string(), count),
  /** The pack's build date. */
  version: text,
  installed_at: time,
  sha256: text,
  path: text,
})
