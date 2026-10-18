import { CliError } from "@wirecat/cli-base"
import * as v from "valibot"
import { meetingProjectCandidates } from "../entities/index.js"
import { formatMeetingReference, parseMeetingReference } from "../meetings/index.js"
import type { StoredMeetingProjectCandidateReader } from "../services/index.js"
import { itemOf, metaNow, sealed, snakeKeys } from "./envelope.js"
import { boundMeetingProjectCandidatesItem } from "./meeting-project-candidates-budget.js"

const bounded = (min: number, max: number) =>
  v.optional(v.pipe(v.number(), v.integer(), v.minValue(min), v.maxValue(max)))
export const meetingProjectCandidatesInput = v.strictObject({
  ref: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
  limit: bounded(1, 10),
  cues: bounded(1, 100),
  bytes: bounded(2048, 65536),
  max_read_bytes: bounded(1, 65536),
  cursor: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(200))),
})

export const readMeetingProjectCandidates = async (
  read: StoredMeetingProjectCandidateReader,
  input: unknown,
  signal?: AbortSignal,
) => {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new CliError("validation_error", "project candidate arguments must be an object")
  for (const key of Object.keys(input))
    if (!Object.hasOwn(meetingProjectCandidatesInput.entries, key))
      throw new CliError("validation_error", `unknown project candidate argument: ${key}`)
  const parsed = v.safeParse(meetingProjectCandidatesInput, input)
  if (!parsed.success) {
    const field = parsed.issues[0]?.path?.map((part) => String(part.key)).join(".") ?? "arguments"
    throw new CliError("validation_error", `invalid project candidate field: ${field}`)
  }
  const args = parsed.output
  const parent = parseMeetingReference(args.ref)
  if (parent.transcriptId !== undefined || formatMeetingReference(parent) !== args.ref)
    throw new CliError("validation_error", "ref must identify a canonical parent meeting")
  let after: string | undefined
  let afterTranscriptId: number | undefined
  if (args.cursor !== undefined) {
    const cursor = parseMeetingReference(args.cursor)
    if (
      cursor.accountId !== parent.accountId ||
      cursor.meetingId !== parent.meetingId ||
      cursor.transcriptId === undefined ||
      formatMeetingReference(cursor) !== args.cursor
    )
      throw new CliError("validation_error", "cursor must identify a cue or transcript of the selected meeting")
    if (cursor.cuePosition === undefined) afterTranscriptId = cursor.transcriptId
    else after = args.cursor
  }
  signal?.throwIfAborted()
  const packet = await read(args.ref, {
    limit: args.limit,
    cues: args.cues,
    bytes: args.bytes,
    maxReadBytes: args.max_read_bytes,
    after,
    afterTranscriptId,
    signal,
  })
  signal?.throwIfAborted()
  const mapped = snakeKeys({
    ...packet,
    source: {
      provider: packet.source.provider,
      account: packet.source.account,
      accountId: String(packet.source.accountId),
      ref: packet.source.reference,
    },
    items: packet.items.map(({ project, matches, omittedMatches }) => ({
      project: { ref: project.reference, id: project.id, name: project.name, key: project.key },
      omittedMatches,
      matches: matches.map(({ source, ...match }) => ({
        ...match,
        source: {
          kind: source.kind,
          ref: source.reference,
          fingerprint: source.fingerprint,
          revision: source.revision,
        },
      })),
    })),
    evidence: {
      ...packet.evidence,
      coverage: {
        ...packet.evidence.coverage,
        nextTranscriptId:
          packet.evidence.coverage.nextTranscriptId === null ? null : String(packet.evidence.coverage.nextTranscriptId),
        nextCursor:
          packet.evidence.coverage.nextTranscriptId === null
            ? packet.evidence.coverage.nextReference
            : formatMeetingReference({ ...parent, transcriptId: packet.evidence.coverage.nextTranscriptId }),
      },
    },
  })
  const checked = v.safeParse(meetingProjectCandidates, mapped)
  if (
    !checked.success ||
    packet.source.reference !== args.ref ||
    packet.source.accountId !== parent.accountId ||
    packet.limits.bytes !== (args.bytes ?? 16384)
  )
    throw new CliError("invalid_response", "project candidates do not match the selected meeting answer contract")
  const item = checked.output
  boundMeetingProjectCandidatesItem(item)
  return sealed(
    itemOf(item, {
      meta: metaNow({
        complete: item.evidence.coverage.skipped_unavailable === 0,
        ...(item.coverage.has_more || item.evidence.coverage.has_more ? { truncated: true } : {}),
      }),
    }),
  )
}
