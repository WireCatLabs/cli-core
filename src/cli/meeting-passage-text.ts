import type { Command } from "commander"
import type { MeetingPassageOutputFormat, MeetingPassageResult } from "../meetings/index.js"
import { formatMeetingPassage } from "../services/meeting-passage-format.js"
import { runMarkOf, withUntrustedMarked } from "./untrusted-marks.js"

/**
 * The passage as the host prints it from `meetings passage`'s `output`, or as `callMeetingPassageTool` answers it: in a scheduled agent's run, text and Markdown
 * are formatted again from the marked cues. The meetings module cannot read the run's mark; JSON is marked by
 * `renderAnswer`.
 */
export const passageForRun = (
  command: Command,
  result: MeetingPassageResult,
  format: MeetingPassageOutputFormat,
): MeetingPassageResult => {
  const mark = runMarkOf(command)
  if (mark === undefined || format === "json") return result
  return { ...result, content: formatMeetingPassage(withUntrustedMarked(result.packet, mark), format) }
}
