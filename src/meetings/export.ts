import { singleLine, visibleControls } from "@wirecat/cli-core"
import type { TranscriptLine } from "./model.js"
import { MeetingError, meetingShow, positiveInteger } from "./reads.js"
import type { MeetingDetails, MeetingStore } from "./store.js"

export type MeetingExportFormat = "markdown" | "vtt"
export interface MeetingExportOptions {
  accountId?: number
  format: MeetingExportFormat
  transcriptId?: number
}
export interface MeetingExport {
  meetingId: number
  format: MeetingExportFormat
  filename: string
  content: string
}
const timestamp = (milliseconds: number): string => {
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0)
    throw new MeetingError("validation_error", "transcript times must be nonnegative integer milliseconds")
  const hours = Math.floor(milliseconds / 3600000)
  const minutes = Math.floor((milliseconds % 3600000) / 60000)
  const seconds = Math.floor((milliseconds % 60000) / 1000)
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(milliseconds % 1000).padStart(3, "0")}`
}
const vttText = (text: string): string => {
  if (visibleControls(text) !== text || /\n\s*\n/.test(text))
    throw new MeetingError("validation_error", "cue paragraphs or control characters require Markdown export")
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
}
export const serializeVtt = (lines: readonly TranscriptLine[]): string =>
  `WEBVTT\n\n${lines
    .map((line, index) => {
      if (index > 0 && line.startMs < (lines[index - 1]?.startMs ?? 0))
        throw new MeetingError("validation_error", "WebVTT cues must have nondecreasing start times")
      if (line.endMs <= line.startMs)
        throw new MeetingError("validation_error", "a transcript cue ends before it starts")
      const speaker = line.speaker === null ? "" : `${vttText(line.speaker)}: `
      if (line.speaker?.includes("\n")) throw new MeetingError("validation_error", "a speaker must fit on one line")
      return `${index + 1}\n${timestamp(line.startMs)} --> ${timestamp(line.endMs)}\n${speaker}${vttText(line.text)}\n\n`
    })
    .join("")}`

const markdown = (text: string): string => visibleControls(text).replace(/[\\`*_{}[\]()<>#+.!|~]/g, "\\$&")
const heading = (text: string): string => markdown(singleLine(text))
const quote = (text: string): string =>
  markdown(text)
    .split(/\r\n|\r|\n/)
    .map((line) => `> ${line}`)
    .join("\n")
const transcriptsOf = (details: MeetingDetails, transcriptId?: number) => {
  if (transcriptId !== undefined) {
    positiveInteger(transcriptId)
    const transcript = details.transcripts.find(
      (part) => part.transcript.id === transcriptId && part.transcript.deletedAt === null,
    )
    if (!transcript) throw new MeetingError("not_found", "transcript not found in the selected meeting")
    return [transcript]
  }
  return details.transcripts.filter(
    (part) => part.transcript.supersededAt === null && part.transcript.deletedAt === null,
  )
}
export const exportMeeting = async (
  store: MeetingStore,
  id: number,
  options: MeetingExportOptions,
): Promise<MeetingExport> => {
  if (options.format !== "markdown" && options.format !== "vtt")
    throw new MeetingError("validation_error", "export format must be markdown or vtt")
  const details = await meetingShow(store, id, options.accountId)
  const transcripts = transcriptsOf(details, options.transcriptId)
  let content: string
  if (options.format === "vtt") {
    const [selected] = transcripts
    if (!selected) throw new MeetingError("not_found", "meeting has no transcript to export")
    if (transcripts.length > 1)
      throw new MeetingError("validation_error", "choose a transcript id when exporting multiple transcripts as VTT")
    content = serializeVtt(
      [...selected.rows]
        .sort((a, b) => a.position - b.position)
        .map((row) => ({
          startMs: row.startMs,
          endMs: row.endMs,
          speaker: row.speakerName,
          text: row.text,
        })),
    )
  } else {
    const parts = [`# ${heading(details.meeting.title ?? "Untitled meeting")}`, `Meeting ID: ${details.meeting.id}`]
    if (details.meeting.description !== null) parts.push("## Description", quote(details.meeting.description))
    for (const summary of details.summaries) {
      parts.push(`## ${heading(summary.title ?? "Summary")}`)
      if (summary.content !== null) parts.push(quote(summary.content))
      else {
        if (summary.overview !== null) parts.push(quote(summary.overview))
        for (const section of summary.sections) parts.push(`### ${heading(section.label)}`, quote(section.text))
        if (summary.nextSteps.length > 0)
          parts.push("### Next steps", summary.nextSteps.map((step) => `- ${markdown(step)}`).join("\n"))
      }
    }
    for (const part of transcripts) {
      parts.push(`## Transcript ${part.transcript.id}`, `Source: ${heading(part.transcript.source)}`)
      if (part.transcript.supersededAt !== null) parts.push("Version: superseded")
      for (const row of [...part.rows].sort((a, b) => a.position - b.position))
        parts.push(
          `[${timestamp(row.startMs)} – ${timestamp(row.endMs)}]${row.speakerName === null ? "" : ` ${heading(row.speakerName)}`}`,
          quote(row.text),
        )
    }
    content = `${parts.join("\n\n")}\n`
  }
  return {
    meetingId: details.meeting.id,
    format: options.format,
    filename: `meeting-${details.meeting.id}${options.transcriptId === undefined ? "" : `-transcript-${options.transcriptId}`}.${options.format === "markdown" ? "md" : "vtt"}`,
    content,
  }
}
