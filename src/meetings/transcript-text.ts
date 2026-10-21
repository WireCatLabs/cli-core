import type { TranscriptLine } from "./model.js"

export class TranscriptTextError extends Error {
  override name = "TranscriptTextError"
}

/** What the header of a text transcript says, as written; the caller reads the date in its zone. */
export interface TranscriptTextHeader {
  title: string | null
  date: string | null
  meetingId: string | null
  speakers: string[]
}

const HEADER: Record<string, keyof Omit<TranscriptTextHeader, "speakers"> | "speakers"> = {
  "Встреча: ": "title",
  "Дата: ": "date",
  "Zoom ID: ": "meetingId",
  "Говорят: ": "speakers",
}
const LINE = /^\[(\d{2,}):([0-5]\d):([0-5]\d)\]\s*(?:([^:\n]{1,60}):\s*)?([\s\S]*)$/
// Early files had no blank line after the rule, so the first line of speech is glued to it.
const RULE = /^[—–-]{10,}[^\n]*(?:\n|$)/
const EMPTY = new Set(["", "—", "-"])

/**
 * A transcript in the text form zoom-searcher wrote: a header (`Встреча:`, `Дата:`, `Zoom ID:`, `Говорят:`),
 * a rule, then `[hh:mm:ss] Speaker: text` blocks apart by a blank line. A block may run over several lines.
 * A line ends where the next begins: the file keeps start times only.
 */
export const parseTranscriptText = (input: string): { header: TranscriptTextHeader; lines: TranscriptLine[] } => {
  const text = input.replace(/^﻿/, "").replace(/\r\n?/g, "\n")
  const header: TranscriptTextHeader = { title: null, date: null, meetingId: null, speakers: [] }
  let sawHeader = false
  for (const line of text.split("\n")) {
    if (!line.trim()) break
    for (const [prefix, key] of Object.entries(HEADER)) {
      if (!line.startsWith(prefix)) continue
      sawHeader = true
      const value = line.slice(prefix.length).trim()
      if (key === "speakers")
        header.speakers = value
          .split(",")
          .map((name) => name.trim())
          .filter((name) => !EMPTY.has(name))
      else header[key] = EMPTY.has(value) ? null : value
    }
  }
  if (!sawHeader) throw new TranscriptTextError('a text transcript starts with a header such as "Встреча: …"')
  const found: { startMs: number; speaker: string | null; text: string }[] = []
  for (const block of text.split(/\n\s*\n/)) {
    const match = LINE.exec(block.trim().replace(RULE, ""))
    if (!match) continue
    const [, hours = "0", minutes = "0", seconds = "0", speaker, said = ""] = match
    found.push({
      startMs: ((Number(hours) * 60 + Number(minutes)) * 60 + Number(seconds)) * 1000,
      speaker: speaker?.trim() || null,
      text: said.trim(),
    })
  }
  const lines = found.map((line, at) => ({
    ...line,
    endMs: Math.max(line.startMs, found[at + 1]?.startMs ?? line.startMs),
  }))
  return { header, lines }
}
