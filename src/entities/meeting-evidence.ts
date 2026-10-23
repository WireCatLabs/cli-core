import { reference } from "@wirecat/cli-base/standards"
import * as v from "valibot"
import { preparationCount as count, preparationCue, preparationEvidence } from "./meeting-preparation-parts.js"

/** `meetings evidence`: the stored lines behind a meeting reference, a page at a time. */
export const meetingEvidence = preparationEvidence

/** `meetings context`: what the stored meetings say about one person, through their linked identities. */
export const meetingPersonContext = v.strictObject({
  person: v.strictObject({ uid: v.string(), name: v.nullable(v.string()) }),
  items: v.array(
    v.strictObject({
      ref: reference,
      cues: v.array(preparationCue),
      cue_coverage: v.strictObject({ included: count, omitted: v.nullable(count), has_more: v.boolean() }),
    }),
  ),
  limits: v.strictObject({ meetings: count, cues: count, bytes: count, scan_limit: count }),
  content_bytes: count,
  coverage: v.strictObject({
    involvements_scanned: count,
    scan_limit_reached: v.boolean(),
    pending: count,
    truncated_by: v.nullable(v.picklist(["meetings", "bytes"])),
    skipped_unavailable: count,
    complete: v.literal(false),
    input: v.literal("bounded-meeting-pages"),
  }),
})
