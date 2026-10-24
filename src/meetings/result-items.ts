import * as v from "valibot"

const text = v.string()
const identifier = v.pipe(text, v.minLength(1))
const nullableText = v.nullable(text)
const count = v.pipe(v.number(), v.integer(), v.minValue(0))
const flag = v.boolean()
const scope = v.strictObject({ provider: text, account: text })

const run = v.strictObject({
  meetings: count,
  participants: count,
  transcript_rows: count,
  summaries: count,
  warnings: v.array(v.strictObject({ external_id: text, message: text })),
  timezone: v.optional(text),
})
const exported = v.union([
  v.strictObject({ meeting_id: identifier, format: v.picklist(["markdown", "vtt"]), filename: text, content: text }),
  v.strictObject({ meeting_id: identifier, format: v.picklist(["markdown", "vtt"]), output: text }),
])
const eventChange = v.strictObject({
  action: v.literal("event.link"),
  event_id: v.nullable(identifier),
  expected_event_id: v.optional(v.nullable(identifier)),
})
const personChange = v.strictObject({
  action: v.literal("person.link"),
  participant_id: identifier,
  person_uid: text,
  expected_person_uid: v.optional(nullableText),
  target_account_ids: v.optional(v.array(identifier)),
})
const eventResult = v.strictObject({
  meeting_id: identifier,
  event_id: v.nullable(identifier),
  previous_event_id: v.nullable(identifier),
  changed: flag,
})
const personResult = v.strictObject({
  meeting_id: identifier,
  participant_id: identifier,
  person_uid: text,
  previous_person_uid: nullableText,
  changed: flag,
})
const meetingChange = v.strictObject({
  scope,
  account_id: identifier,
  meeting_id: identifier,
  change: v.union([eventChange, personChange]),
  applied: flag,
  result: v.optional(v.union([eventResult, personResult])),
})
const recognition = v.strictObject({
  engine: text,
  model: text,
  version: v.optional(text),
  timing: v.optional(v.picklist(["fixed-windows", "recognition-segments"])),
})
const transcription = v.union([
  v.strictObject({
    applied: v.literal(false),
    account_id: identifier,
    external_id: text,
    segments: count,
    media: v.strictObject({
      id: text,
      content_hash: text,
      size: count,
      duration_ms: count,
      format: text,
      sample_rate: count,
      channels: count,
      recognition,
    }),
  }),
  v.strictObject({
    applied: v.literal(true),
    account_id: identifier,
    external_id: text,
    meeting_id: identifier,
    created: flag,
    inserted_transcripts: count,
    replayed_transcripts: count,
    superseded_transcripts: count,
    segments: count,
    media_sha256: text,
    engine: text,
    model: text,
    model_version: nullableText,
    timing: v.picklist(["fixed-windows", "recognition-segments"]),
  }),
])

const embeddingModel = v.strictObject({ key: text, dims: count, kind: v.picklist(["local", "remote"]), model: text })
const embedding = v.union([
  v.strictObject({
    account_id: identifier,
    model: embeddingModel,
    status: v.strictObject({ chunks: count, embedded: count }),
    applied: v.literal(false),
    scope: v.literal("existing-current-chunks"),
    rebuild_required: v.literal("explicit"),
  }),
  v.strictObject({
    account_id: identifier,
    model: embeddingModel,
    saved: count,
    skipped: count,
    has_more: flag,
    next_hash: v.optional(text),
    applied: v.literal(true),
    rebuild: v.strictObject({
      transcripts: count,
      chunks: count,
      has_more: flag,
      next_transcript_id: v.optional(identifier),
    }),
  }),
])

export const MEETING_RESULT_ENTITIES = {
  meeting_ingestion: run,
  meeting_export: exported,
  meeting_association: meetingChange,
  meeting_transcription: transcription,
  meeting_embedding: embedding,
} as const
