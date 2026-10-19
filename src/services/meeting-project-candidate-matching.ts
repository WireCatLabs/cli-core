import { normalizeVocabularyName } from "../domain/vocabulary.js"
import type { MeetingProjectCandidateInput, MeetingProjectCandidates } from "../meetings/index.js"
import type { VocabularyCatalog } from "../store/index.js"

type Entry = VocabularyCatalog["entries"][number]
export type VocabularyTerm = { name: string; kind: "canonical" | "key" | "alias"; aliasId?: string }

const normalizedText = (text: string) => text.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ")
const termsOf = (entry: Entry): VocabularyTerm[] => [
  { name: entry.name, kind: "canonical" as const },
  ...(entry.key ? [{ name: entry.key, kind: "key" as const }] : []),
  ...entry.aliases.map((alias) => ({ name: alias.name, kind: "alias" as const, aliasId: alias.id })),
]

/** Every entry whose name, key or alias stands as whole words in a text, at most 20 matches an entry. */
export const matchVocabularyTerms = <S>(catalog: VocabularyCatalog, texts: readonly { text: string; source: S }[]) => {
  const owners = new Map<string, Set<string>>()
  for (const entry of catalog.entries)
    for (const term of termsOf(entry)) {
      const key = normalizeVocabularyName(term.name)
      const ids = owners.get(key) ?? new Set<string>()
      ids.add(entry.id)
      owners.set(key, ids)
    }
  const sources = texts.map(({ text, source }) => ({ text: normalizedText(text), source }))
  const result: {
    entry: Entry
    matches: { term: VocabularyTerm; source: S; ambiguous: boolean }[]
    omitted: number
  }[] = []
  for (const entry of catalog.entries) {
    const matches: { term: VocabularyTerm; source: S; ambiguous: boolean }[] = []
    let omitted = 0
    const seen = new Set<string>()
    for (const term of termsOf(entry)) {
      const normalized = normalizeVocabularyName(term.name)
      if (seen.has(normalized)) continue
      seen.add(normalized)
      const pattern = new RegExp(
        `(?<![\\p{L}\\p{N}\\p{M}_])${normalized.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}\\p{M}_])`,
        "u",
      )
      for (const { text, source } of sources) {
        if (!pattern.test(text)) continue
        if (matches.length === 20) {
          omitted++
          continue
        }
        matches.push({ term, source, ambiguous: (owners.get(normalized)?.size ?? 0) > 1 })
      }
    }
    if (matches.length) result.push({ entry, matches, omitted })
  }
  return result.sort((a, b) => Number(a.entry.id) - Number(b.entry.id))
}

export const matchProjectCandidates = (catalog: VocabularyCatalog, input: MeetingProjectCandidateInput) =>
  matchVocabularyTerms<MeetingProjectCandidates["items"][number]["matches"][number]["source"]>(catalog, [
    ...(input.title === undefined
      ? []
      : [
          {
            text: input.title,
            source: { kind: "metadata-title" as const, reference: input.reference, fingerprint: null, revision: null },
          },
        ]),
    ...(input.cues ?? []).map((cue) => ({
      text: cue.text,
      source: {
        kind: "transcript" as const,
        reference: cue.reference,
        fingerprint: cue.fingerprint,
        revision: cue.revision,
      },
    })),
  ]).map(({ entry, matches, omitted }): MeetingProjectCandidates["items"][number] => ({
    project: { reference: `project:${entry.id}`, id: entry.id, name: entry.name, key: entry.key },
    matches: matches.map(({ term, source, ambiguous }) => ({ term, source, ambiguous })),
    omittedMatches: omitted,
  }))
