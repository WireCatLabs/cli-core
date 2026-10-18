import { CliError } from "@wirecat/cli-base"
import { type MeetingProviderScope, snapshotMeetingScope } from "../meetings/index.js"
import { checkMeetingCancelled, readMeetingEvidence } from "./meeting-evidence.js"
import { createMeetingProjectCandidateReader } from "./meeting-project-candidates.js"
import { authorizedMeetingMetadata, type MeetingReadStore } from "./meeting-reference.js"
import type {
  StoredMeetingProjectCandidatePorts,
  StoredMeetingProjectCandidateReader,
} from "./stored-meeting-project-candidate-types.js"
import { storedCandidateRequest } from "./stored-meeting-project-candidate-validation.js"

export const createStoredMeetingProjectCandidateReader = (
  scope: MeetingProviderScope,
  accountId: number,
  ports: StoredMeetingProjectCandidatePorts,
): StoredMeetingProjectCandidateReader => {
  const fixed = snapshotMeetingScope(scope)
  const store = ports?.meetings
  if (
    !store ||
    ["account", "meetingMetadata", "transcriptMetadata", "transcripts", "transcriptRows"].some(
      (key) => typeof store[key as keyof typeof store] !== "function",
    )
  )
    throw new CliError("configuration_error", "Stored project suggestions require bounded meeting reads")
  const suggest = createMeetingProjectCandidateReader(fixed, accountId, { vocabulary: ports.vocabulary })
  const account = store.account.bind(store)
  const reads = {
    meetingMetadata: store.meetingMetadata.bind(store),
    transcriptMetadata: store.transcriptMetadata.bind(store),
    transcripts: store.transcripts.bind(store),
    transcriptRows: store.transcriptRows.bind(store),
  }
  return async (reference, options = {}) => {
    const request = storedCandidateRequest(reference, accountId, options)
    const { limits, signal } = request
    let calls = 0
    const dispatch = () => {
      checkMeetingCancelled(signal)
      if (++calls > 8) throw new CliError("validation_error", "Stored project candidate read budget exhausted")
    }
    dispatch()
    const owner = await account(accountId)
    checkMeetingCancelled(signal)
    if (!owner || owner.provider !== fixed.provider || owner.account !== fixed.account)
      throw new CliError("not_found", "The selected meeting account is unavailable")
    const bounded: MeetingReadStore = {
      meetingMetadata: (input) => {
        dispatch()
        return reads.meetingMetadata(input)
      },
      transcriptMetadata: (input) => {
        dispatch()
        return reads.transcriptMetadata(input)
      },
      transcripts: (input) => {
        dispatch()
        return reads.transcripts(input)
      },
      transcriptRows: (input) => {
        dispatch()
        return reads.transcriptRows(input)
      },
    }
    const { meeting } = await authorizedMeetingMetadata(bounded, accountId, reference, {
      maxReadBytes: limits.maxReadBytes,
      signal,
    })
    checkMeetingCancelled(signal)
    const title = meeting.title
    const evidence = await readMeetingEvidence(
      { ...bounded, meetingMetadata: async () => meeting },
      accountId,
      reference,
      {
        cues: limits.cues,
        bytes: 32768,
        maxReadBytes: limits.maxReadBytes,
        maxTranscriptPages: 1,
        after: request.after,
        afterTranscriptId: request.afterTranscriptId,
        signal,
      },
    )
    const candidates = await suggest(
      {
        reference,
        ...(title === null ? {} : { title }),
        cues: evidence.items.map(({ reference, fingerprint, text, revision }) => ({
          reference,
          fingerprint,
          text,
          revision,
        })),
      },
      { limit: limits.limit, bytes: limits.bytes, signal },
    )
    const result = {
      ...candidates,
      evidence: {
        fingerprint: evidence.fingerprint,
        limits: evidence.limits,
        coverage: evidence.coverage,
        consistency: "live-reads" as const,
        maxStoreCalls: 8 as const,
      },
    }
    while (Buffer.byteLength(JSON.stringify(result), "utf8") > limits.bytes) {
      if (!result.items.length)
        throw new CliError("validation_error", "Stored project candidate bytes cannot fit required coverage")
      result.items.pop()
      result.coverage.hasMore = result.coverage.outputLimited = true
    }
    checkMeetingCancelled(signal)
    return result
  }
}
