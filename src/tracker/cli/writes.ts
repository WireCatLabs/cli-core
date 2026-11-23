import { CliError } from "@wirecat/cli-base"
import { annotate } from "@wirecat/cli-base/commands"
import type { Command } from "commander"
import type * as v from "valibot"
import { answerEntity } from "../../cli/answer-entity.js"
import { REMOTE_WRITE } from "../../cli/effects.js"
import { type Body, itemOf } from "../../cli/envelope.js"
import { terminalAsker } from "../../cli/messenger/ask.js"
import type { TrackerItem } from "../../store/sqlite/tracker.js"
import type { TrackerWrite } from "../writer.js"
import {
  commentTrackerIssue,
  createTrackerIssue,
  type TrackerIssueInput,
  type TrackerWriteContext,
  type TrackerWrites,
  updateTrackerIssue,
} from "../writes.js"

/** What the writes need of the open profile: the shared `TrackerRun` and its writes, built for the command run. */
interface WriteRun {
  account: TrackerWriteContext["account"]
  store: TrackerWriteContext["store"]
  writes?: (command: Command) => TrackerWrites
  source?: TrackerWriteContext["source"]
}

export interface TrackerWriteCommandOptions<R extends WriteRun> {
  writes: readonly TrackerWrite[]
  within: (command: Command, readOnly: boolean, work: (run: R) => Promise<Body>) => Promise<void>
  example: (command: Command, ...lines: string[]) => Command
  /** An issue or comment as the read commands show it, with its `untrusted` fields. */
  view: (run: R, item: TrackerItem) => Promise<Record<string, unknown> & { untrusted: string[] }>
  answer: v.GenericSchema
  now: () => number
}

const collect = (value: string, previous: string[] = []) => [...previous, value]

type Typed = Omit<TrackerIssueInput, "labels"> & { label?: string[] }

const inputOf = ({ label, ...rest }: Typed): TrackerIssueInput => ({
  ...Object.fromEntries(Object.entries(rest).filter(([, value]) => value !== undefined)),
  // The empty default marks the flag as repeatable; left empty, the labels are not changed.
  ...(label?.length ? { labels: label } : {}),
})

/** `issues create|update|comment` for each write the tracker takes, under the `issues` group. */
export const addTrackerWriteCommands = <R extends WriteRun>(
  issues: Command,
  options: TrackerWriteCommandOptions<R>,
): void => {
  const contextOf = (run: R, command: Command): TrackerWriteContext => {
    if (!run.writes) throw new CliError("configuration_error", "this profile cannot write to its tracker")
    return {
      store: run.store,
      account: run.account,
      writes: run.writes(command),
      ask: terminalAsker(command),
      ...(run.source ? { source: run.source } : {}),
      now: options.now,
    }
  }
  const answered = async (run: R, operationId: string, kind: "issue" | "comment", item: TrackerItem) => {
    const shown = await options.view(run, item)
    return itemOf({
      operation_id: operationId,
      [kind]: shown,
      untrusted: shown.untrusted.map((field) => `${kind}.${field}`),
    })
  }
  const write = (name: TrackerWrite, description: string) =>
    answerEntity(
      annotate(issues.command(name), { effects: REMOTE_WRITE, offline: false }),
      "tracker_write",
      options.answer,
    ).description(description)
  const fields = (command: Command) =>
    command
      .option("--description <text>", "the issue's text; an empty value clears it")
      .option("--team <team>", "the team, by its id, key or name; left out, the copy's only team")
      .option("--state <state>", "the workflow state, by its id or a name only one of the team's states has")
      .option(
        "--assignee <user>",
        "the user, by id, name or e-mail; empty for none; anyone but you checks issues.assign-others",
      )
      .option("--priority <priority>", "0 to 4, or none, urgent, high, medium, low; empty for none")
      .option(
        "--label <label>",
        "a label by its id or name; repeat it for each; replaces the issue's labels, and one empty value clears them",
        collect,
        [] as string[],
      )
      .option("--project <project>", "the project, by its id or name; empty for none")
      .option("--parent <issue>", "the issue this one is part of, by its key or id; empty for none")
  const reference = (command: Command) => command.argument("<issue>", "the issue's key (ENG-12) or id")

  if (options.writes.includes("create"))
    options
      .example(
        fields(
          write("create", "make an issue in the tracker, then store the tracker's copy of it").requiredOption(
            "--title <title>",
            "the issue's title",
          ),
        ),
        'issues create --title "Example: invoices fail for EUR" --team ENG --label Bug',
        'issues create --title "Example: write the guide" --assignee ada@example.com --priority high',
      )
      .action(async (typed: Typed, command: Command) => {
        await options.within(command, false, async (run) => {
          const done = await createTrackerIssue(contextOf(run, command), inputOf(typed))
          return answered(run, done.operationId, "issue", done.issue)
        })
      })
  if (options.writes.includes("update"))
    options
      .example(
        fields(
          reference(
            write(
              "update",
              "change an issue in the tracker; what is left out keeps its value; the tracker's copy is stored again",
            ),
          ).option("--title <title>", "the issue's title"),
        ),
        'issues update ENG-12 --state "In Progress"',
        'issues update ENG-12 --assignee ""',
      )
      .action(async (issue: string, typed: Typed, command: Command) => {
        await options.within(command, false, async (run) => {
          const done = await updateTrackerIssue(contextOf(run, command), issue, inputOf(typed))
          return answered(run, done.operationId, "issue", done.issue)
        })
      })
  if (options.writes.includes("comment"))
    options
      .example(
        reference(write("comment", "add a comment to an issue in the tracker, then store it")).requiredOption(
          "--body <text>",
          "the comment, as it is to read",
        ),
        'issues comment ENG-12 --body "Example: fixed in the next release"',
      )
      .action(async (issue: string, typed: { body: string }, command: Command) => {
        await options.within(command, false, async (run) => {
          const done = await commentTrackerIssue(contextOf(run, command), issue, typed.body)
          return answered(run, done.operationId, "comment", done.comment)
        })
      })
}
