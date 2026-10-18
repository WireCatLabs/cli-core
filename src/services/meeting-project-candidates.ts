import { createHash } from "node:crypto"
import { CliError } from "@wirecat/cli-base"
import type {
  MeetingProjectCandidateReader,
  MeetingProjectCandidates,
  MeetingProviderScope,
} from "../meetings/index.js"
import type { VocabularyStore } from "../store/index.js"
import { checkMeetingCancelled } from "./meeting-evidence.js"
import { matchProjectCandidates } from "./meeting-project-candidate-matching.js"
import { candidateCatalog, candidateInput, candidateLimits } from "./meeting-project-candidate-validation.js"

/** Host-supplied evidence is bounded and scoped, but is not revalidated against a store. */
export const createMeetingProjectCandidateReader = (
  scope: MeetingProviderScope,
  accountId: number,
  ports: { vocabulary: Pick<VocabularyStore, "vocabulary"> },
): MeetingProjectCandidateReader => {
  if (
    !scope ||
    [scope.provider, scope.account].some(
      (s) => typeof s !== "string" || !s.trim() || s.length > 200 || /[\p{Cc}\p{Cf}]/u.test(s),
    ) ||
    !Number.isSafeInteger(accountId) ||
    accountId < 1 ||
    typeof ports?.vocabulary?.vocabulary !== "function"
  )
    throw new CliError(
      "configuration_error",
      "project candidates need a captured account and bounded vocabulary reader",
    )
  const owner = { provider: scope.provider, account: scope.account, accountId }
  const vocabulary = ports.vocabulary.vocabulary.bind(ports.vocabulary)
  return async (original, options = {}) => {
    const limits = candidateLimits(options)
    const signal = options.signal
    const input = candidateInput(original, accountId)
    checkMeetingCancelled(signal)
    const catalog = await vocabulary({
      kind: "project",
      maxEntries: limits.maxProjects,
      maxReadBytes: limits.maxVocabularyReadBytes,
      signal,
    })
    checkMeetingCancelled(signal)
    candidateCatalog(catalog, limits)
    const found = matchProjectCandidates(catalog, input)
    const result: MeetingProjectCandidates = {
      schemaVersion: 1,
      kind: "meeting_project_candidates",
      source: { ...owner, reference: input.reference },
      inputFingerprint: createHash("sha256").update(JSON.stringify(input)).digest("hex"),
      vocabularyFingerprint: catalog.fingerprint,
      association: "unconfirmed-literal-evidence",
      items: found.slice(0, limits.limit),
      limits,
      coverage: {
        selection: "explicit-host-evidence/global-project-vocabulary",
        sourceEvidence: "not-revalidated",
        association: "unconfirmed-literal-evidence",
        archiveCompleteness: "unknown",
        candidatesTotal: found.length,
        hasMore: found.length > limits.limit,
        outputLimited: false,
        matching: "unicode-normalized-literal-word-boundaries",
      },
    }
    while (new TextEncoder().encode(JSON.stringify(result)).byteLength > limits.bytes) {
      if (!result.items.length)
        throw new CliError("validation_error", "project candidate bytes cannot fit required coverage")
      result.items.pop()
      result.coverage.hasMore = result.coverage.outputLimited = true
    }
    checkMeetingCancelled(signal)
    return result
  }
}
