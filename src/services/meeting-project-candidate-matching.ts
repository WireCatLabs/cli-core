import { normalizeVocabularyName } from "../domain/vocabulary.js"
import type { MeetingProjectCandidateInput, MeetingProjectCandidates } from "../meetings/index.js"
import type { VocabularyCatalog } from "../store/index.js"

const normalizedText = (text: string) => text.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ")
const termsOf = (entry: VocabularyCatalog["entries"][number]) => [
  { name: entry.name, kind: "canonical" as const },
  ...(entry.key ? [{ name: entry.key, kind: "key" as const }] : []),
  ...entry.aliases.map((alias) => ({ name: alias.name, kind: "alias" as const, aliasId: alias.id })),
]

export const matchProjectCandidates = (catalog: VocabularyCatalog, input: MeetingProjectCandidateInput) => {
  const owners = new Map<string, Set<string>>()
  for (const entry of catalog.entries)
    for (const term of termsOf(entry)) {
      const key = normalizeVocabularyName(term.name)
      const ids = owners.get(key) ?? new Set<string>()
      ids.add(entry.id)
      owners.set(key, ids)
    }
  const sources = [
    ...(input.title === undefined
      ? []
      : [
          {
            text: normalizedText(input.title),
            source: { kind: "metadata-title" as const, reference: input.reference, fingerprint: null, revision: null },
          },
        ]),
    ...(input.cues ?? []).map((cue) => ({
      text: normalizedText(cue.text),
      source: {
        kind: "transcript" as const,
        reference: cue.reference,
        fingerprint: cue.fingerprint,
        revision: cue.revision,
      },
    })),
  ]
  const result: MeetingProjectCandidates["items"] = []
  for (const entry of catalog.entries) {
    const matches: MeetingProjectCandidates["items"][number]["matches"] = []
    let omittedMatches = 0
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
          omittedMatches++
          continue
        }
        matches.push({ term, source, ambiguous: (owners.get(normalized)?.size ?? 0) > 1 })
      }
    }
    if (matches.length)
      result.push({
        project: { reference: `project:${entry.id}`, id: entry.id, name: entry.name, key: entry.key },
        matches,
        omittedMatches,
      })
  }
  return result.sort((a, b) => Number(a.project.id) - Number(b.project.id))
}
