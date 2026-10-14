import { CliError } from "@wirecat/cli-base"
import { isoTime, STEPS, type StepDefinition, stepOf } from "@wirecat/cli-base/standards"
import * as v from "valibot"
import { type MeetingItemBody, meetingHit, meetingHitItem } from "./answers.js"
import type { MeetingProjectDiscoveryPage } from "./project-discovery.js"
import type { prepareMeetingProjectEvidence } from "./project-evidence-query.js"

const count = v.pipe(v.number(), v.integer(), v.minValue(0))
const id = v.pipe(v.string(), v.minLength(1))
export const meetingProjectEvidence = v.strictObject({
  schema_version: v.literal(1),
  kind: v.literal("meeting_project_evidence"),
  account_id: id,
  query: v.string(),
  project: v.strictObject({ id, name: v.string(), key: v.nullable(v.string()) }),
  term: v.strictObject({
    name: v.string(),
    kind: v.picklist(["canonical", "key", "alias"]),
    alias_id: v.optional(id),
  }),
  hits: v.array(meetingHit),
  association: v.literal("unconfirmed-word-evidence"),
  vocabulary_fingerprint: id,
  selection: v.strictObject({
    meeting_id: v.optional(id),
    identity_id: v.optional(id),
    person_id: v.optional(id),
    tag_id: v.optional(id),
    event_id: v.optional(id),
    series_id: v.optional(id),
    since: v.optional(isoTime),
    until: v.optional(isoTime),
  }),
  limits: v.strictObject({ limit: count, max_read_bytes: count, max_vocabulary_read_bytes: count, max_terms: count }),
  page: v.strictObject({ limit: count, has_more: v.boolean(), cursor: v.optional(id) }),
  coverage: v.strictObject({
    archive_completeness: v.literal("unknown"),
    current_revisions: v.literal(true),
    indexing: v.picklist(["ready", "pending"]),
    index_completeness: v.literal("unknown"),
    term_index: count,
    terms_total: count,
    remaining_terms: count,
    duplicates: v.literal("may-repeat-between-terms"),
  }),
})
export type MeetingProjectEvidenceItem = v.InferOutput<typeof meetingProjectEvidence>
export type MeetingProjectEvidenceAnswer = MeetingItemBody<MeetingProjectEvidenceItem>
const PAGE_NEXT = STEPS.find((step) => step.id === "page.next") as StepDefinition

export const meetingProjectEvidenceAnswer = (
  page: MeetingProjectDiscoveryPage,
  prepared: ReturnType<typeof prepareMeetingProjectEvidence>,
  command = "meetings projects evidence",
): MeetingProjectEvidenceAnswer => {
  const { options } = prepared
  const selection: MeetingProjectEvidenceItem["selection"] = {}
  for (const [field, value] of [
    ["meeting_id", options.meetingId],
    ["identity_id", options.participantIdentityId],
    ["person_id", options.personId],
    ["tag_id", options.tagId],
    ["event_id", options.eventId],
    ["series_id", options.meetingSeriesId],
  ] as const)
    if (value !== undefined) selection[field] = String(value)
  if (options.since !== undefined) selection.since = new Date(options.since).toISOString()
  if (options.until !== undefined) selection.until = new Date(options.until).toISOString()
  const cursor = page.nextCursor ?? undefined
  if (page.hasMore !== (cursor !== undefined))
    throw new CliError("invalid_response", "project evidence continuation is inconsistent")
  const item: MeetingProjectEvidenceItem = {
    schema_version: 1,
    kind: "meeting_project_evidence",
    account_id: String(page.accountId),
    query: page.query,
    project: page.project,
    term: {
      name: page.term.name,
      kind: page.term.kind,
      ...(page.term.aliasId === undefined ? {} : { alias_id: page.term.aliasId }),
    },
    hits: page.hits.map(meetingHitItem),
    association: page.association,
    vocabulary_fingerprint: page.vocabularyFingerprint,
    selection,
    limits: {
      limit: page.limits.limit,
      max_read_bytes: page.limits.maxReadBytes,
      max_vocabulary_read_bytes: page.limits.maxVocabularyReadBytes,
      max_terms: page.limits.maxTerms,
    },
    page: { limit: page.limits.limit, has_more: page.hasMore, ...(cursor === undefined ? {} : { cursor }) },
    coverage: {
      archive_completeness: page.coverage.archiveCompleteness,
      current_revisions: page.coverage.currentRevisions,
      indexing: page.coverage.indexing,
      index_completeness: page.coverage.indexCompleteness,
      term_index: page.coverage.termIndex,
      terms_total: page.coverage.termsTotal,
      remaining_terms: page.coverage.remainingTerms,
      duplicates: page.coverage.duplicates,
    },
  }
  if (!v.safeParse(meetingProjectEvidence, item).success)
    throw new CliError("invalid_response", "project evidence does not match its answer contract")
  return {
    item,
    ...(cursor === undefined
      ? {}
      : {
          next: [
            stepOf(PAGE_NEXT, {
              command,
              args: {
                project: prepared.project,
                query: prepared.query,
                cursor,
                limit: page.limits.limit,
                max_read_bytes: page.limits.maxReadBytes,
              },
              values: { shown: page.hits.length },
            }),
          ],
        }),
  }
}
