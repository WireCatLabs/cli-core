import { isoTime, reference } from "@wirecat/cli-base/standards"
import * as v from "valibot"
import {
  preparationCount as count,
  preparationId as id,
  preparationContext,
  preparationEvidence,
  preparationMeeting,
  preparationUpcoming,
} from "./meeting-preparation-parts.js"

export const meetingPreparation = v.strictObject({
  schema_version: v.literal(1),
  kind: v.literal("meeting_preparation"),
  account_id: id,
  upcoming: preparationUpcoming,
  series: v.nullable(
    v.strictObject({
      id,
      external_id: id,
      title: v.nullable(v.string()),
      event_series_id: v.nullable(id),
      updated_at: isoTime,
    }),
  ),
  history_window: v.strictObject({ after: isoTime, before: isoTime }),
  meetings: v.array(
    v.strictObject({
      ref: reference,
      meeting: preparationMeeting,
      evidence: preparationEvidence,
      context: preparationContext,
    }),
  ),
  related: v.strictObject({
    anchors: v.array(reference),
    items: v.array(
      v.strictObject({
        ref: reference,
        meeting: preparationMeeting,
        evidence: preparationEvidence,
        shared_person: v.boolean(),
        shared_project: v.boolean(),
      }),
    ),
    has_more: v.boolean(),
    output_limited: v.boolean(),
    selection: v.literal("explicit-person-links/confirmed-project-links"),
  }),
  knowledge: v.optional(
    v.strictObject({
      anchors: v.array(reference),
      items: v.array(
        v.strictObject({
          ref: reference,
          type: v.picklist(["fact", "statement", "question", "decision", "promise"]),
          statement: v.string(),
          subject: v.nullable(reference),
          project: v.nullable(reference),
          updated_at: isoTime,
          shared_person: v.boolean(),
          shared_project: v.boolean(),
        }),
      ),
      has_more: v.boolean(),
      output_limited: v.boolean(),
      selection: v.literal("accepted-global-person/project-facts"),
      fact_evidence: v.literal("not-revalidated"),
      other_sources: v.literal("not-queried"),
    }),
  ),
  limits: v.strictObject({ meetings: count, cues: count, context_limit: count, max_read_bytes: count, bytes: count }),
  coverage: v.strictObject({
    archive_completeness: v.literal("unknown"),
    consistency: v.literal("live-reads"),
    history_has_more: v.boolean(),
    has_undated: v.boolean(),
    skipped_unavailable: v.array(reference),
    output_limited: v.boolean(),
    context: v.literal("observed-participants/confirmed-projects/accepted-meeting-subject-facts/direct-source-tasks"),
    fact_evidence: v.literal("not-revalidated"),
    unqueried: v.array(
      v.picklist([
        "person-history",
        "project-wide-context",
        "person-nonmeeting-context",
        "project-nonmeeting-context",
        "project-alias-candidates",
      ]),
    ),
  }),
})
export type MeetingPreparationItem = v.InferOutput<typeof meetingPreparation>
