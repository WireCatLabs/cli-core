import { CliError } from "@wirecat/cli-base"
import { annotate } from "@wirecat/cli-base/commands"
import { fieldsHelp } from "@wirecat/cli-base/query"
import type { Command } from "commander"
import type { MeetingProjectDiscoveryReader } from "../project-discovery.js"
import { readMeetingProjectEvidence } from "../project-evidence.js"
import type { MeetingProjectEvidenceAnswer } from "../project-evidence-answer.js"
import { MEETING_PROJECT_EVIDENCE_QUERY, type MeetingProjectEvidenceRequest } from "../project-evidence-query.js"
import { queryWordsAfterOptions } from "./query-options.js"

const integer = (value: string) => {
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)))
    throw new CliError("validation_error", "expected a positive safe integer")
  return Number(value)
}
export const addMeetingProjectEvidenceCommand = (
  program: Command,
  deps: {
    read: MeetingProjectDiscoveryReader
    signal: () => AbortSignal | undefined
    output: (value: MeetingProjectEvidenceAnswer) => void
    now?: () => number
  },
): Command => {
  const group = program.commands.find((command) => command.name() === "meetings")
  if (!group) throw new CliError("configuration_error", "meeting command group is unavailable")
  const projects =
    group.commands.find((command) => command.name() === "projects") ??
    group.command("projects").description("project-name evidence in stored meetings")
  return annotate(
    queryWordsAfterOptions(
      projects
        .command("evidence")
        .description(
          "find cited project-name and alias evidence in the local meeting index; does not refresh it or confirm membership",
        ),
    )
      .argument("<project>", "existing project name, key or explicit alias")
      .argument("[query...]", "exact ID fields and a UTC started_at range, joined by AND")
      .addHelpText("after", `\n${fieldsHelp(MEETING_PROJECT_EVIDENCE_QUERY)}`)
      .option("--limit <n>", "hits in one name page, 1 through 1000 (default 100)", integer)
      .option("--cursor <cursor>", "continue with the same project and frozen selection from next")
      .option("--max-read-bytes <bytes>", "word-read byte budget, at most 67108864 (default 4194304)", integer)
      .action(
        async (project: string, words: string[], options: Omit<MeetingProjectEvidenceRequest, "query" | "signal">) => {
          deps.output(
            await readMeetingProjectEvidence(
              deps.read,
              project,
              { ...options, query: words.join(" "), signal: deps.signal() },
              deps.now?.(),
            ),
          )
        },
      ),
    {
      origin: "handwritten",
      effects: { remote: "none", local: "read" },
      query: MEETING_PROJECT_EVIDENCE_QUERY,
      output: { entity: "meeting_project_evidence" },
    },
  )
}
