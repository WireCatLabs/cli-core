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
import { commandAt, lineOf, rootOf } from "../../cli/steps.js"
import { DEAL_KINDS } from "../../domain/deals.js"
import { SAVE_HELP } from "../../meetings/index.js"
import type { AppIdentity } from "../../ports/app.js"
import { meaningLane } from "../../services/messages-meaning.js"
import { crmAccounts, type SearchedResource, searchAll } from "../../services/search-all.js"
import type { CopyViewer } from "../../store/store.js"
import { crmViewerOf } from "../viewer.js"
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
    viewerOf,
    leads = true,
  }: {
    within: CrmWithin
    app: AppIdentity
    example: (command: Command, ...lines: string[]) => Command
    /** This profile's rule over its own account's copy, as the other reads of the copy take it. */
    viewerOf: (run: CrmRun) => Promise<CopyViewer | undefined>
    /** The CRM has leads. */
    leads?: boolean
  },
): void => {
  const deals = leads ? "deals and leads" : "deals"
  const all = annotate(new Command("all"), { effects: LOCAL_READ, partial: true, output: { entity: "hit" } })
    .summary(`search stored ${deals}, messages, notes, calendar events and meetings`)
    .description(
      `search the CRM's ${deals} by the words of their title, company, contacts and activities, and the ` +
        "messages, notes, calendar events and meetings other WireCat tools stored — best match first. Use it when " +
        "you do not know where something was written",
    )
    .argument(
      "<query...>",
      `words and "phrases"; ${deals} match the words of their title, company, contacts and activities`,
    )
    .addHelpText(
      "after",
      `\nIt finds ${deals} by the meaning of their activities too, in other words or another language, once ` +
        "`sync --embed` has built their vectors with a downloaded model; until then it says it searched by words " +
        "only.\n" +
        SAVE_HELP,
    )
  searches.addCommand(searchAllOptions(all, SEARCHED))
  example(all, "search all Example LLC", "search all website --only crm --json")
  all.action(async (words: string[], _opts: unknown, leaf: Command) => {
    const opts = leaf.opts<{
      only?: Exclude<SearchedResource, "business">[]
      source?: string
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
        ...(asked.includes("crm") ? [...DEAL_KINDS, "crm_file" as const, "crm_activity" as const] : []),
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
      const own = await viewerOf(run)
      // A profile limited on its own account reads no other copy; anyone else reads each as its owner's sign-in may.
      const alone = run.locked === true || own !== undefined
      const others = alone
        ? []
        : (await crmAccounts(run.store)).filter(
            (one) => one.provider !== run.account.provider || one.account !== run.account.account,
          )
      const viewers = [
        ...(own ? [own] : []),
        ...(
          await Promise.all(
            others.map(
              async (one) => (await crmViewerOf(run.store, one, (await run.store.crm.ownUser(one)) ?? null)).viewer,
            ),
          )
        ).filter((one): one is CopyViewer => one !== undefined),
      ]
      const found = await searchAll(
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
          ...(opts.only?.includes("meetings") ? { meetingsAsked: true } : {}),
          ...(crmKinds.length < DEAL_KINDS.length ? { crmKinds } : {}),
          crmViewers: viewers,
          ...(out.has("crm_file") ? { crmFiles: false } : {}),
          ...(out.has("crm_activity") ? { crmActivities: false } : {}),
          ...(opts.source === undefined ? {} : { source: opts.source }),
          ...(alone ? { scope: { crm: [run.account] } } : {}),
        },
        { app, hintCommand: commandAt(rootOf(leaf), "models download") ? app.command : null },
        undefined,
        meaningLane({ env, messenger: { app }, store: async () => run.store }),
      )
      const note = (text: string) => outputFor(leaf).renderer.note(text)
      for (const { why } of denied) note(why)
      for (const { resource, source, reason } of found.skipped) note(`${resource ?? source} not searched: ${reason}`)
      if (!found.items.length) note("nothing found in what the local store holds")
      // Agents grepped every note when this went unsaid (cli-testing performance/crm/hubspot-agents, round 2).
      // With the activities setting off, sync --embed has nothing to embed: an agent told only that would loop.
      const off = found.crm?.needsVectors && !(await run.store.crm.activitiesOn(run.account))
      const build = off
        ? `\`${lineOf(leaf, "config set activities on")}\`, then \`${lineOf(leaf, "sync --embed")}\`, copy the activities and build`
        : `\`${lineOf(leaf, "sync --embed")}\` builds`
      const vectors = found.crm?.needsVectors
        ? `deals and leads were found by words only: ${found.crm.meaningSkipped}; ` +
          `${build} the vectors that find them by the meaning of their activities`
        : undefined
      if (vectors) note(vectors)
      const skips = await historySkipsOf(run.store, found.accounts).catch(() => [])
      const again = {
        query: words.join(" "),
        ...(opts.only === undefined ? {} : { only: opts.only.join(",") }),
        ...(opts.source === undefined ? {} : { source: opts.source }),
        ...(opts.exact ? { exact: true } : {}),
      }
      const body = allAnswer(
        "search all",
        found,
        { limit, page: opts.page ?? 1, again },
        opts.exact === true,
        skips,
        denied,
      )
      return (
        vectors ? { ...body, missing: [...(body.missing ?? []), { field: "found_by", why: vectors }] } : body
      ) as Body
    })
  })
}
