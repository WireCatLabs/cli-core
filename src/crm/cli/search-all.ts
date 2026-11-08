import { CliError } from "@wirecat/cli-base"
import { annotate } from "@wirecat/cli-base/commands"
import { Command } from "commander"
import { outputFor } from "../../cli/context.js"
import { LOCAL_READ } from "../../cli/effects.js"
import type { Body } from "../../cli/envelope.js"
import { historySkipsOf } from "../../cli/messenger/history-gaps.js"
import { allAnswer, offsetOf, SOURCE_SEARCHED } from "../../cli/messenger/search-answers.js"
import { searchAllOptions } from "../../cli/messenger/search-command.js"
import { deniedKinds } from "../../cli/search-left-out.js"
import { commandAt, rootOf } from "../../cli/steps.js"
import { DEAL_KINDS } from "../../domain/deals.js"
import { SAVE_HELP } from "../../meetings/index.js"
import type { AppIdentity } from "../../ports/app.js"
import { meaningLane } from "../../services/messages-meaning.js"
import { type ResourceWithMeetings, searchAllWithMeetings } from "../../services/search-all-meetings.js"
import type { CrmRun, CrmWithin } from "./index.js"

/** What a CRM CLI's `search all` reads: its deals and leads first, then what the other tools stored. */
const SEARCHED = ["crm", ...SOURCE_SEARCHED] as const
const DEFAULT_LIMIT = 20

/**
 * `search all` in a CRM CLI: the shared search over the store, its own deals and leads beside the messages, notes and
 * events other WireCat tools stored. A locked profile reads only its own account's deals.
 */
export const addCrmSearchAll = (
  searches: Command,
  {
    within,
    app,
    example,
  }: { within: CrmWithin; app: AppIdentity; example: (command: Command, ...lines: string[]) => Command },
): void => {
  const all = annotate(new Command("all"), { effects: LOCAL_READ, partial: true, output: { entity: "hit" } })
    .summary("search stored deals and leads, messages, notes and calendar events")
    .description(
      "search the CRM's deals and leads by the words of their title, and messages, notes and calendar events other " +
        "WireCat tools stored — best match first. Use it when you do not know where something was written",
    )
    .argument("<query...>", 'words and "phrases"; deals and leads match the words of their title')
    .addHelpText("after", SAVE_HELP)
  searches.addCommand(searchAllOptions(all, SEARCHED))
  example(all, "search all Example LLC", "search all website --only crm --json")
  all.action(async (words: string[], _opts: unknown, leaf: Command) => {
    const opts = leaf.opts<{
      only?: Exclude<ResourceWithMeetings, "business">[]
      source?: string
      maxMeetings?: number | "all"
      limit?: number
      page?: number
      exact?: boolean
      timezone?: string
    }>()
    await within(leaf, async (run: CrmRun) => {
      if (run.locked && opts.source !== undefined)
        throw new CliError(
          "permission_error",
          "this process is locked to one profile; search all reads its own CRM account only, without --source",
          { reason: "profile.locked" },
        )
      const asked = opts.only ?? SEARCHED
      const denied = deniedKinds(leaf, app, [
        ...(asked.includes("crm") ? DEAL_KINDS : []),
        ...asked.filter((one): one is Exclude<typeof one, "crm" | "mail"> => one !== "crm" && one !== "mail"),
      ])
      const out = new Set<string>(denied.map(({ kind }) => kind))
      const crmKinds = DEAL_KINDS.filter((kind) => !out.has(kind))
      const only = asked.filter((one) => (one === "crm" ? crmKinds.length > 0 : !out.has(one)))
      if (!only.length)
        throw new CliError(
          "permission_error",
          `search all has nothing it may read: ${denied.map(({ why }) => why).join("; ")}`,
          { reason: "search.all-denied" },
        )
      const limit = opts.limit ?? DEFAULT_LIMIT
      const offset = offsetOf(opts.page, limit)
      const env = run.env ?? process.env
      const found = await searchAllWithMeetings(
        run.store,
        run.account,
        {
          text: words.join(" "),
          limit,
          ...(offset === undefined ? {} : { offset }),
          ...(opts.exact ? { exact: true } : {}),
          ...(opts.timezone === undefined ? {} : { timezone: opts.timezone }),
          env,
          only,
          ...(crmKinds.length < DEAL_KINDS.length ? { crmKinds } : {}),
          ...(opts.source === undefined ? {} : { source: opts.source }),
          ...(opts.maxMeetings === undefined ? {} : { maxMeetings: opts.maxMeetings }),
          ...(run.locked ? { scope: { crm: [run.account] } } : {}),
        },
        { app, hintCommand: commandAt(rootOf(leaf), "models download") ? app.command : null },
        undefined,
        meaningLane({ env, messenger: { app }, store: async () => run.store }),
      )
      const note = (text: string) => outputFor(leaf).renderer.note(text)
      for (const { why } of denied) note(why)
      for (const { resource, source, reason } of found.skipped) note(`${resource ?? source} not searched: ${reason}`)
      if (!found.items.length) note("nothing found in what the local store holds")
      const skips = await historySkipsOf(run.store, found.accounts).catch(() => [])
      const again = {
        query: words.join(" "),
        ...(opts.only === undefined ? {} : { only: opts.only.join(",") }),
        ...(opts.source === undefined ? {} : { source: opts.source }),
        ...(opts.exact ? { exact: true } : {}),
      }
      return allAnswer(
        "search all",
        found,
        { limit, page: opts.page ?? 1, again },
        opts.exact === true,
        skips,
        denied,
      ) as Body
    })
  })
}
