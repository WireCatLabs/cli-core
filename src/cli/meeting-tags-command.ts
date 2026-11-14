import { CliError } from "@wirecat/cli-base"
import { annotate } from "@wirecat/cli-base/commands"
import type { QueryRegistry } from "@wirecat/cli-base/query"
import { type Command, InvalidArgumentError } from "commander"
import { meetingTagChangeItem, meetingTaggingItem } from "../meetings/index.js"
import type { MeetingTags, MeetingTagTarget } from "../services/meeting-tags.js"
import { outputFor } from "./context.js"
import { LOCAL_READ, LOCAL_WRITE, NO_EFFECTS } from "./effects.js"
import { type Body, itemOf, listOf, renderAnswer } from "./envelope.js"
import { queryTerms, termField, withQuery } from "./list-query.js"

export interface MeetingTagsCommandDeps {
  /** The tags of the profile's own meetings account; opened when the command runs. */
  read: () => Promise<MeetingTags>
  signal?: () => AbortSignal | undefined
  /** Prints the answer; cli-core's renderer when not given. A host that closes its store first passes its own. */
  output?: (body: Body, command: Command) => void
  /** One to three examples per command that run as written, with the host's command and a profile. */
  examples: Record<"add" | "remove" | "list", string[]>
}

const MEETING_TAG_QUERY = {
  entity: "meeting_tagging",
  backend: "native",
  fields: [termField("tag", "kw", "tag:complaint")],
} as const satisfies QueryRegistry

const positive = (value: string) => {
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)))
    throw new InvalidArgumentError("expected a positive integer")
  return Number(value)
}
const ids = (value: string, previous: number[] = []) => [...previous, positive(value)]

interface ChangeFlags {
  meeting?: number[]
  matching?: string
}

const targetOf = ({ meeting, matching }: ChangeFlags): MeetingTagTarget => {
  if ((meeting === undefined) === (matching === undefined))
    throw new CliError("validation_error", "name the meetings: --meeting <id> (repeat for more) or --matching <query>")
  return matching === undefined ? { meetings: meeting ?? [] } : { matching }
}

const groupOf = (program: Command): Command =>
  program.commands.find((command) => command.name() === "tags") ??
  annotate(program.command("tags"), { effects: NO_EFFECTS }).description(
    "your labels on stored meetings, kept in the local store and never sent",
  )

/**
 * `tags add|remove|list` for a host whose things to label are its meetings, such as pbx's phone calls. A host of
 * chats mounts the messenger's `tags` instead. `--matching` takes `search meetings`'s query, so "search, then tag" is
 * one command, and a rerun after new calls are transcribed marks only those.
 */
export const addMeetingTagsCommand = (program: Command, deps: MeetingTagsCommandDeps): void => {
  const tags = groupOf(program)
  const print = (body: Body, command: Command) =>
    deps.output ? deps.output(body, command) : renderAnswer(command, outputFor(command), body)

  for (const operation of ["add", "remove"] as const)
    annotate(tags.command(operation), {
      effects: LOCAL_WRITE,
      output: { entity: "meeting_tag_change" },
      examples: deps.examples[operation],
    })
      .summary(operation === "add" ? "put tags on stored meetings" : "take tags off stored meetings")
      .description(
        operation === "add"
          ? "put tags on stored meetings: by id, or every meeting where a search finds its words"
          : "take tags off stored meetings: by id, or every meeting where a search finds its words",
      )
      .argument("<tag...>", "one or more tags: 1–32 letters a–z, digits and hyphens; upper case is lowered")
      .option("--meeting <id>", "a meeting, by its store id; repeat for more", ids)
      .option(
        "--matching <query>",
        "every meeting where search meetings finds this query: words, phrases, OR, -word, from:, date>=30d",
      )
      .action(async (given: string[], flags: ChangeFlags, command: Command) => {
        const target = targetOf(flags)
        const done = await (await deps.read())[operation](target, given, deps.signal?.())
        print(itemOf(meetingTagChangeItem(done)), command)
      })

  withQuery(
    annotate(tags.command("list"), { effects: LOCAL_READ, examples: deps.examples.list })
      .summary("tagged meetings of this account, with their tags")
      .description("the stored meetings of this account that carry a tag, each with all its tags"),
    MEETING_TAG_QUERY,
  )
    .option("--limit <n>", "meetings per page, 1–500 (default 100)", positive, 100)
    .option("--page <n>", "page number", positive, 1)
    .action(async (words: string[], flags: { limit: number; page: number }, command: Command) => {
      if (flags.limit > 500) throw new CliError("validation_error", "--limit is at most 500")
      const tag = queryTerms(words, MEETING_TAG_QUERY, "tags list").get("tag")
      const found = await (await deps.read()).list({
        ...(tag === undefined ? {} : { tag }),
        limit: flags.limit,
        offset: (flags.page - 1) * flags.limit,
      })
      print(
        listOf("tags list", {
          items: found.items.map(meetingTaggingItem),
          limit: flags.limit,
          page: flags.page,
          has_more: found.hasMore,
        }),
        command,
      )
    })
}
