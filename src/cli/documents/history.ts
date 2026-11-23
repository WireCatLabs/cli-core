import { CliError } from "@wirecat/cli-base"
import { annotate, sharedCommand } from "@wirecat/cli-base/commands"
import { type Command, InvalidArgumentError } from "commander"
import * as v from "valibot"
import { type documentIngestion, KEEP_VERSIONS_FOR_DAYS } from "../../documents.js"
import { momentOf } from "../../services/moment.js"
import { DOCUMENT_EVENTS, type DocumentEvent } from "../../store/index.js"
import { honoursDryRun } from "../dry-run-guard.js"
import { LOCAL_READ } from "../effects.js"
import { type Body, itemOf, listOf } from "../envelope.js"
import { count, fromFile, type Settings } from "../settings.js"
import { type DocumentWords, documentsGroup, examples, positive, wordsOf } from "./words.js"

/** The local history `documentIngestion` gives: what a CLI hands these commands. */
export type DocumentHistoryPort = ReturnType<typeof documentIngestion>["history"]

export interface DocumentHistoryCommands {
  words: DocumentWords
  output(body: Body): void
  /** Opens the store read-only for the selected profile, with the source account its documents belong to. */
  run<T>(fn: (history: DocumentHistoryPort, principal: string) => Promise<T>): Promise<T>
  /** The source's id from what was typed: an id or a link. A `document:<n>` ref may pass as it is. */
  id(input: string): string
}

/** `keep_versions_for_days`: a documents CLI adds it to `settingsFor` and passes `keepVersionsForDays` to its sync. */
export const DOCUMENT_HISTORY_SETTINGS = {
  profile: { keep_versions_for_days: v.optional(count) },
  settings: [
    {
      key: "keep_versions_for_days",
      default: KEEP_VERSIONS_FOR_DAYS,
      description: "days earlier versions of synced documents, and the change log, are kept",
    },
  ],
}

/** The profile's `keep_versions_for_days`, or 365. */
export const keepVersionsForDays = (settings: Pick<Settings, "configured" | "shared">): number =>
  fromFile(settings, "keep_versions_for_days", KEEP_VERSIONS_FOR_DAYS).value

const eventList = (input: string, before: DocumentEvent[] = []) => {
  const events = input.split(",").map((one) => one.trim())
  for (const event of events)
    if (!DOCUMENT_EVENTS.includes(event as DocumentEvent))
      throw new InvalidArgumentError(`use ${DOCUMENT_EVENTS.join(", ")}`)
  return [...before, ...(events as DocumentEvent[])]
}

const addDocumentHistoryCommandsDefinition = (program: Command, helpers: DocumentHistoryCommands) => {
  const wording = wordsOf(helpers.words)
  const { prefix, text } = wording
  const documents = documentsGroup(program, wording)
  const reference = async (history: DocumentHistoryPort, principal: string, input: string) => {
    const found = await history.reference(principal, /^document:\d+$/.test(input) ? input : helpers.id(input))
    if (!found)
      throw new CliError("not_found", "this document is not in the selected profile's local copy", {
        reason: "document.not-imported",
      })
    return found
  }
  examples(
    annotate(documents.command("history"), { effects: LOCAL_READ })
      .argument("<document>", text.documentArgument)
      .description("list the versions of a document kept in the local copy, or show one with --revision"),
    [`${prefix} documents history DOC_ID`, `${prefix} documents history DOC_ID --revision 3`],
  )
    .option("--revision <n>", "show the text of this version", positive)
    .action((input: string, args: { revision?: number }) =>
      helpers.run(async (history, principal) => {
        const ref = await reference(history, principal, input)
        if (args.revision !== undefined) {
          helpers.output(itemOf({ document: ref, ...(await history.version(ref, args.revision)) }))
          return
        }
        helpers.output(itemOf(await history.versions(ref)))
      }),
    )
  return examples(
    annotate(program.command("changes"), { effects: LOCAL_READ }).description(
      "list the documents the sync added, changed, removed or brought back, newest first",
    ),
    [`${prefix} changes`, `${prefix} changes --since 7d --event deleted,unavailable`],
  )
    .option("--since <when>", "from this time: an ISO 8601 time, today, yesterday, or 30m, 2h, 1d ago", "1d")
    .option("--until <when>", "up to this time, in the same forms")
    .option(`--event <events>`, `only these, comma separated: ${DOCUMENT_EVENTS.join(", ")}`, eventList)
    .option("--limit <n>", "how many changes to return", positive, 50)
    .option("--page <n>", "which page to return", positive, 1)
    .action((args: { since: string; until?: string; event?: DocumentEvent[]; limit: number; page: number }) =>
      helpers.run(async (history, principal) => {
        const now = Date.now()
        const since = new Date(momentOf(args.since, "--since", now)).toISOString()
        const until =
          args.until === undefined
            ? undefined
            : new Date(momentOf(args.until, "--until", now, { end: true })).toISOString()
        const found = await history.changes(principal, {
          since,
          ...(until ? { until } : {}),
          ...(args.event ? { events: args.event } : {}),
          limit: args.limit,
          offset: (args.page - 1) * args.limit,
        })
        helpers.output(
          listOf("changes", {
            items: found.items,
            limit: args.limit,
            has_more: found.hasMore,
            page: args.page,
            args: { since, ...(until ? { until } : {}), ...(args.event ? { event: args.event } : {}) },
          }),
        )
      }),
    )
}

/**
 * `documents history <document>` and `changes`, over the selected profile's local history: every version a sync
 * replaced or removed, and what changed since a time. A CLI whose `documents` group is its own gets them there too.
 */
export const addDocumentHistoryCommands = honoursDryRun(sharedCommand(addDocumentHistoryCommandsDefinition))
