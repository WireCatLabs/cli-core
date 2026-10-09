import type { TranscriptLine } from "./model.js"

export class VttError extends Error {
  override name = "VttError"
}

const TIMESTAMP = /^(?:(\d+):)?([0-5]\d):([0-5]\d)\.(\d{3})$/
const SKIPPED = /^(NOTE|STYLE|REGION)(\s|$)/

const millis = (stamp: string, lineNo: number): number => {
  const match = TIMESTAMP.exec(stamp)
  if (!match) throw new VttError(`line ${lineNo}: "${stamp}" is not a WebVTT timestamp`)
  const [, hours = "0", minutes = "0", seconds = "0", ms = "0"] = match
  return ((Number(hours) * 60 + Number(minutes)) * 60 + Number(seconds)) * 1000 + Number(ms)
}

/** Zoom writes the speaker inline, `Name: text`, in its API transcripts and in downloaded files alike. */
const splitSpeaker = (text: string): Pick<TranscriptLine, "speaker" | "text"> => {
  const firstLine = text.split("\n", 1)[0] ?? ""
  const at = firstLine.indexOf(": ")
  if (at <= 0) return { speaker: null, text }
  return { speaker: firstLine.slice(0, at).trim(), text: text.slice(at + 2) }
}

/** The cues of a WebVTT file as transcript lines, in file order. */
export const parseVtt = (input: string): TranscriptLine[] => {
  const lines = input.replace(/^﻿/, "").split(/\r\n|\r|\n/)
  if (!/^WEBVTT([ \t].*)?$/.test(lines[0] ?? "")) throw new VttError('line 1: a WebVTT file starts with "WEBVTT"')

  const cues: TranscriptLine[] = []
  let i = 1
  while (i < lines.length) {
    while (i < lines.length && lines[i]?.trim() === "") i++
    const start = i
    while (i < lines.length && lines[i]?.trim() !== "") i++
    const block = lines.slice(start, i)
    if (block.length === 0 || SKIPPED.test(block[0] ?? "")) continue

    const timingAt = block.findIndex((line) => line.includes("-->"))
    if (timingAt < 0 || timingAt > 1) throw new VttError(`line ${start + 1}: a cue has no timing line`)
    const lineNo = start + timingAt + 1
    const [from = "", rest = ""] = (block[timingAt] ?? "").split("-->")
    const to = rest.trim().split(/\s+/)[0] ?? ""
    const text = block
      .slice(timingAt + 1)
      .join("\n")
      .trim()
    cues.push({ startMs: millis(from.trim(), lineNo), endMs: millis(to, lineNo), ...splitSpeaker(text) })
  }
  return cues
}
