import { linkEvent } from "./events.js"
import { transcriptInput } from "./ingest.js"
import type { RunReport } from "./pull.js"
import type { MeetingInput, MeetingStore, ParticipantInput } from "./store.js"
import { parseVtt } from "./vtt.js"

export interface ImportFile {
  meeting: MeetingInput
  content: string
  participants?: ParticipantInput[]
  source?: string
}
/** The caller reads files and supplies provider-neutral occurrence metadata. */
export const importFiles = async (files: ImportFile[], store: MeetingStore, now = Date.now()): Promise<RunReport> => {
  const report: RunReport = { meetings: 0, participants: 0, transcriptRows: 0, summaries: 0, warnings: [] }
  for (const file of files) {
    try {
      const lines = parseVtt(file.content)
      const participants = file.participants ?? []
      const details = await store.saveMeeting({
        meeting: file.meeting,
        participants: file.participants,
        transcripts: [await transcriptInput(lines, participants, file.source ?? "file", file.content)],
        now,
      })
      await linkEvent(store, details, now)
      report.meetings++
      report.participants += participants.length
      report.transcriptRows += lines.length
    } catch (error) {
      report.warnings.push({
        externalId: file.meeting.externalId,
        message: error instanceof Error ? error.message : "Meeting import failed",
      })
    }
  }
  return report
}
