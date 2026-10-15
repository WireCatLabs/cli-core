import { CliError } from "@wirecat/cli-base"
import { formatMeetingReference, type MeetingProviderScope, snapshotMeetingScope } from "../meetings/index.js"
import { readMeetingEvidence } from "./meeting-evidence.js"
import type {
  MeetingPreparation,
  MeetingPreparationPorts,
  MeetingPreparationRequest,
} from "./meeting-preparation-types.js"
import { preparationCancelled, preparationRequest } from "./meeting-preparation-validation.js"
import { appendRelatedPreparation } from "./meeting-related-preparation.js"

const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8")

export const createMeetingPreparationService = (
  scope: MeetingProviderScope,
  accountId: number,
  ports: MeetingPreparationPorts,
) => {
  const fixed = snapshotMeetingScope(scope)
  if (!Number.isSafeInteger(accountId) || accountId < 1)
    throw new CliError("validation_error", "accountId must be a positive safe integer")
  const store = ports?.meetings
  if (
    !store ||
    [
      "account",
      "seriesHistory",
      "relatedHistory",
      "preparationContext",
      "meetingMetadata",
      "transcriptMetadata",
      "transcripts",
      "transcriptRows",
    ].some((key) => typeof store[key as keyof typeof store] !== "function") ||
    typeof ports?.upcoming?.next !== "function"
  )
    throw new CliError(
      "configuration_error",
      "Meeting preparation requires bounded meeting reads and an upcoming reader",
    )
  if (ports.upcoming.scope?.provider !== fixed.provider || ports.upcoming.scope?.account !== fixed.account)
    throw new CliError("configuration_error", "The upcoming reader belongs to another provider or account")
  const next = ports.upcoming.next.bind(ports.upcoming)
  return {
    scope: fixed,
    async prepare(externalId: string, original: MeetingPreparationRequest): Promise<MeetingPreparation> {
      const input = preparationRequest(accountId, externalId, original)
      const { signal, meetings, cues, contextLimit, maxReadBytes, bytes } = input
      const owner = await store.account(accountId)
      preparationCancelled(signal)
      if (!owner || owner.provider !== fixed.provider || owner.account !== fixed.account)
        throw new CliError("not_found", "The selected meeting account is unavailable")
      const upcoming = await next(externalId, { after: input.after, until: input.until, maxReadBytes, signal })
      preparationCancelled(signal)
      if (
        upcoming.scope.provider !== fixed.provider ||
        upcoming.scope.account !== fixed.account ||
        upcoming.meetingId !== externalId ||
        upcoming.after !== input.after ||
        upcoming.until !== input.until
      )
        throw new CliError("invalid_response", "The upcoming reader returned another selection")
      const history = await store.seriesHistory(input.history)
      preparationCancelled(signal)
      const result: MeetingPreparation = {
        schemaVersion: 1,
        accountId,
        upcoming,
        series: history.series,
        historyWindow: { after: input.historyAfter, before: input.after },
        items: [],
        related: {
          anchors: [],
          items: [],
          hasMore: false,
          outputLimited: false,
          selection: "explicit-person-links/confirmed-project-links",
        },
        limits: { meetings, cues, contextLimit, maxReadBytes, bytes },
        coverage: {
          archiveCompleteness: "unknown",
          consistency: "live-reads",
          historyHasMore: history.hasMore,
          hasUndated: history.hasUndated,
          skippedUnavailable: [],
          outputLimited: false,
          context: "observed-participants/confirmed-projects/accepted-meeting-subject-facts/direct-source-tasks",
          factEvidence: "not-revalidated",
          unqueried: ["person-history", "project-wide-context", "project-alias-candidates"],
        },
      }
      if (
        history.items.length > meetings ||
        (history.items.length && !history.series) ||
        (history.series && history.series.externalId !== externalId)
      )
        throw new CliError("invalid_response", "The history reader returned another series or exceeded its bound")
      if (size(result) > bytes)
        throw new CliError("validation_error", "Preparation metadata exceeds bytes; increase the output budget")
      if (!history.series) return structuredClone(result)
      const seriesId = history.series.id
      for (const meeting of history.items) {
        preparationCancelled(signal)
        const reference = formatMeetingReference({ type: "meeting", accountId, meetingId: meeting.id })
        if (meeting.startedAt === null || meeting.startedAt < input.historyAfter || meeting.startedAt >= input.after)
          throw new CliError("invalid_response", "A history entry is outside the selected window")
        const remaining = bytes - size(result) - 512
        if (remaining < 2) {
          result.coverage.outputLimited = true
          break
        }
        try {
          const evidence = await readMeetingEvidence(store, accountId, reference, {
            cues,
            bytes: remaining,
            maxReadBytes,
            maxTranscriptPages: 2,
            signal,
          })
          preparationCancelled(signal)
          const context = await store.preparationContext({
            accountId,
            meetingId: meeting.id,
            seriesId,
            updatedAt: meeting.updatedAt,
            limit: contextLimit,
            maxReadBytes,
            signal,
          })
          preparationCancelled(signal)
          const entry = { reference, meeting, evidence, context }
          result.items.push(entry)
          if (size(result) > bytes) {
            result.items.pop()
            result.coverage.outputLimited = true
            break
          }
        } catch (error) {
          preparationCancelled(signal)
          if (!(error instanceof CliError) || error.code !== "not_found") throw error
          result.coverage.skippedUnavailable.push(reference)
        }
      }
      await appendRelatedPreparation(store, result, input)
      preparationCancelled(signal)
      if (size(result) > bytes)
        throw new CliError("validation_error", "Preparation coverage exceeds bytes; increase the output budget")
      return structuredClone(result)
    },
  }
}
