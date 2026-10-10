import type { TranscriptLine } from "./model.js"
import type { ParticipantInput, TranscriptInput } from "./store.js"

export const contentHash = async (text: string): Promise<string> => {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("")
}
export const speakerPosition = (name: string | null, participants: ParticipantInput[]): number | null => {
  if (name === null) return null
  const matches = participants.flatMap((p, i) => (p.displayName === name ? [i] : []))
  return matches.length === 1 ? (matches[0] ?? null) : null
}
export const transcriptInput = async (
  lines: TranscriptLine[],
  participants: ParticipantInput[],
  source: string,
  hashText = JSON.stringify(lines),
): Promise<TranscriptInput> => ({
  source,
  format: "vtt",
  language: null,
  contentHash: await contentHash(hashText),
  externalCreatedAt: null,
  metadata: null,
  deletedAt: null,
  rows: lines.map((line, position) => ({
    position,
    startMs: line.startMs,
    endMs: line.endMs,
    speakerParticipantPosition: speakerPosition(line.speaker, participants),
    speakerName: line.speaker,
    text: line.text,
    normalizedText: null,
    metadata: null,
  })),
})
export const timestamp = (value: string): number => {
  const time = Date.parse(value)
  if (!Number.isFinite(time)) throw new Error("Invalid meeting timestamp")
  return time
}
