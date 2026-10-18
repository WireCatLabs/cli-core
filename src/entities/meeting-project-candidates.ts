import { reference } from "@wirecat/cli-base/standards"
import * as v from "valibot"

const count = v.pipe(v.number(), v.integer(), v.minValue(0))
const id = v.pipe(v.string(), v.minLength(1))
const text = v.string()
export const meetingProjectCandidates = v.strictObject({
  schema_version: v.literal(1),
  kind: v.literal("meeting_project_candidates"),
  source: v.strictObject({ provider: text, account: text, account_id: id, ref: reference }),
  input_fingerprint: id,
  vocabulary_fingerprint: id,
  association: v.literal("unconfirmed-literal-evidence"),
  items: v.array(
    v.strictObject({
      project: v.strictObject({ ref: reference, id, name: text, key: v.nullable(text) }),
      matches: v.array(
        v.strictObject({
          term: v.strictObject({
            name: text,
            kind: v.picklist(["canonical", "key", "alias"]),
            alias_id: v.optional(id),
          }),
          ambiguous: v.boolean(),
          source: v.strictObject({
            kind: v.picklist(["metadata-title", "transcript"]),
            ref: reference,
            fingerprint: v.nullable(id),
            revision: v.nullable(v.picklist(["current", "superseded"])),
          }),
        }),
      ),
      omitted_matches: count,
    }),
  ),
  limits: v.strictObject({ limit: count, max_projects: count, max_vocabulary_read_bytes: count, bytes: count }),
  coverage: v.strictObject({
    selection: v.literal("explicit-host-evidence/global-project-vocabulary"),
    source_evidence: v.literal("not-revalidated"),
    association: v.literal("unconfirmed-literal-evidence"),
    archive_completeness: v.literal("unknown"),
    omitted_matches: count,
    candidates_total: count,
    has_more: v.boolean(),
    output_limited: v.boolean(),
    matching: v.literal("unicode-normalized-literal-word-boundaries"),
  }),
  evidence: v.strictObject({
    fingerprint: id,
    limits: v.strictObject({ cues: count, bytes: count, max_read_bytes: count, max_transcript_pages: count }),
    coverage: v.strictObject({
      provided: count,
      included: count,
      omitted: v.nullable(count),
      provided_exact: v.boolean(),
      next_cursor: v.nullable(reference),
      next_transcript_id: v.nullable(id),
      next_reference: v.nullable(reference),
      transcript_pages: count,
      skipped_unavailable: count,
      has_more: v.boolean(),
      truncated_by: v.nullable(v.picklist(["cues", "bytes", "transcripts"])),
      input: v.literal("bounded-meeting-pages"),
      archive_completeness: v.literal("unknown"),
    }),
    consistency: v.literal("live-reads"),
    max_store_calls: v.literal(8),
  }),
})
