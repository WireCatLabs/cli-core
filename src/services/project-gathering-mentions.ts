import { CliError } from "@wirecat/cli-base"
import type { VocabularyKind, VocabularyStore } from "../store/index.js"
import { matchVocabularyTerms, type VocabularyTerm } from "./meeting-project-candidate-matching.js"
import type { ProjectGathering } from "./project-gathering.js"

export interface EvidenceMention {
  target: { kind: VocabularyKind; id: string; reference: string; name: string; key: string | null }
  matches: { term: VocabularyTerm; ambiguous: boolean; reference: string; in: "hit" | "around" }[]
  omittedMatches: number
}
export interface EvidenceMentions {
  kind: "evidence_mentions"
  association: "unconfirmed-literal-evidence"
  items: EvidenceMention[]
  vocabularyFingerprints: Partial<Record<VocabularyKind, string>>
  coverage: {
    texts: "returned-excerpts"
    matching: "unicode-normalized-literal-word-boundaries"
    hasMore: boolean
    skipped: { kind: VocabularyKind; code: string; reason: string | null }[]
  }
}

const KINDS: readonly VocabularyKind[] = ["project", "tag", "topic"]

/**
 * Which existing projects, tags and topics the returned excerpts and their neighbours name. A name is evidence to
 * review, never membership; the gathered project itself is left out.
 */
export const findEvidenceMentions = async (
  vocabulary: Pick<VocabularyStore, "vocabulary">,
  gathering: Pick<ProjectGathering, "items">,
  options: { exclude?: string | null; limit?: number; signal?: AbortSignal } = {},
): Promise<EvidenceMentions> => {
  if (typeof vocabulary?.vocabulary !== "function")
    throw new CliError("configuration_error", "evidence mentions need the store's vocabulary")
  const limit = options.limit ?? 50
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200)
    throw new CliError("validation_error", "limit must be a whole number from 1 to 200", { param: "limit" })
  const texts = gathering.items.flatMap((item) => [
    { text: `${item.title ?? ""} ${item.text}`, source: { reference: item.ref, in: "hit" as const } },
    ...(item.around ?? []).map((one) => ({ text: one.text, source: { reference: one.ref, in: "around" as const } })),
  ])
  const items: EvidenceMention[] = []
  const vocabularyFingerprints: EvidenceMentions["vocabularyFingerprints"] = {}
  const skipped: EvidenceMentions["coverage"]["skipped"] = []
  for (const kind of KINDS) {
    options.signal?.throwIfAborted()
    let catalog: Awaited<ReturnType<typeof vocabulary.vocabulary>>
    try {
      catalog = await vocabulary.vocabulary({ kind, signal: options.signal })
    } catch (error) {
      options.signal?.throwIfAborted()
      if (!(error instanceof CliError)) throw error
      const reason = error.details?.reason
      skipped.push({ kind, code: error.code, reason: typeof reason === "string" ? reason : null })
      continue
    }
    vocabularyFingerprints[kind] = catalog.fingerprint
    for (const { entry, matches, omitted } of matchVocabularyTerms<{ reference: string; in: "hit" | "around" }>(
      catalog,
      texts,
    )) {
      const reference = `${kind}:${entry.id}`
      if (reference === options.exclude) continue
      items.push({
        target: { kind, id: entry.id, reference, name: entry.name, key: entry.key },
        matches: matches.map(({ term, source, ambiguous }) => ({ term, ambiguous, ...source })),
        omittedMatches: omitted,
      })
    }
  }
  items.sort((a, b) => b.matches.length - a.matches.length)
  return {
    kind: "evidence_mentions",
    association: "unconfirmed-literal-evidence",
    items: items.slice(0, limit),
    vocabularyFingerprints,
    coverage: {
      texts: "returned-excerpts",
      matching: "unicode-normalized-literal-word-boundaries",
      hasMore: items.length > limit,
      skipped,
    },
  }
}
