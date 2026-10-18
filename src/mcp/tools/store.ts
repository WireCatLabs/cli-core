import { CliError } from "@wirecat/cli-base"
import * as v from "valibot"
import { FETCH } from "../../cli/effects.js"
import { itemOf, listOf, snakeKeys } from "../../cli/envelope.js"
import { listQuery, queryArgument } from "../../cli/list-query.js"
import type { Messenger } from "../../cli/messenger/context.js"
import { parseDuration } from "../../domain/duration.js"
import { levelFor } from "../../sends/permissions.js"
import { FETCHING } from "../../services/archive.js"
import { GAP_BOUNDS, gapsService, validateRepair } from "../../services/archive-gaps.js"
import { jobDetails, jobsDir, readJob, startArchiveJob } from "../../services/backfill-jobs.js"
import { storedDeps } from "../../services/deps.js"
import { JOBS_QUERY, jobItems } from "../../services/job-query.js"
import { validateCatchUp } from "../../services/search-catchup.js"
import { type AnyTool, chatOf, READ, tool } from "../tool.js"

const count = (maximum: number) => v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(maximum)))
export const storeTools = (messenger: Messenger): Record<string, AnyTool> => ({
  store_gaps_plan: tool({
    title: "Plan interior archive gaps",
    description:
      "Local recorded coverage only: returns inclusive uncovered ranges, ordering units, unknown edges and fingerprint. Missing message ids alone are not gaps.",
    input: v.object({ chat: chatOf(messenger) }),
    annotations: { ...READ, openWorldHint: false },
    stored: async (store, account, args, defaults) =>
      itemOf(snakeKeys(await gapsService(storedDeps(messenger, store, account, defaults.guard)).plan(args.chat))),
  }),
  store_gaps_repair: tool({
    title: "Repair interior archive gaps",
    description:
      "Explicit bounded history fetch and coverage recheck; never deletes unseen messages. Defaults5gaps,500messages,30seconds; unknown edges remain unknown. Background uses store jobs show/list.",
    key: "store.gaps.repair",
    input: v.object({
      chat: chatOf(messenger),
      catch_up: v.optional(v.boolean()),
      catch_up_chunks: count(20_000),
      catch_up_messages: count(100_000),
      catch_up_time: v.optional(v.string()),
      limit: count(10_000),
      max_gaps: count(100),
      page_size: count(100),
      repair_time: v.optional(v.string()),
      pause: v.optional(v.string()),
      fingerprint: v.optional(v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/))),
      background: v.optional(v.boolean()),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    effects: FETCH,
    stored: async (store, account, args, defaults, connect) => {
      const fetching = messenger.fetching ?? FETCHING
      const deps = {
        ...storedDeps(messenger, store, account, defaults.guard),
        offline: false,
        reads: messenger.history ?? ("server" as const),
        withConnection: connect,
        env: defaults.env,
        profile: defaults.settings.profile,
        searchCatchUp: defaults.settings.searchCatchUp,
      }
      const options = {
        limit: args.limit,
        maxGaps: args.max_gaps,
        pageSize: args.page_size,
        timeMs: args.repair_time === undefined ? undefined : parseDuration(args.repair_time, "repair_time"),
        pauseMs: parseDuration(args.pause ?? fetching.pause, "pause"),
        fingerprint: args.fingerprint,
        signal: defaults.signal,
      }
      const prepare = args.catch_up ?? defaults.settings.searchCatchUp ?? false
      const preparation = {
        maxChunks: args.catch_up_chunks,
        maxMessages: args.catch_up_messages,
        ...(args.catch_up_time === undefined ? {} : { timeMs: parseDuration(args.catch_up_time, "catch_up_time") }),
      }
      if (
        !prepare &&
        (args.catch_up_chunks !== undefined || args.catch_up_messages !== undefined || args.catch_up_time !== undefined)
      )
        throw new CliError("validation_error", "catch-up budgets need catch_up or searchCatchUp true")
      if (prepare) {
        for (const key of ["conversations.links", "conversations.embed"]) {
          const level = levelFor(defaults.settings.permissions ?? {}, key).level
          if (level === "deny" || level === "readonly")
            throw new CliError("permission_error", `profile does not let ${key} prepare search`, { permission: key })
        }
        validateCatchUp(deps, preparation)
      }
      validateRepair(messenger, options)
      defaults.guard.check({ chatId: null, key: "store.gaps.repair" }, { reserve: false })
      const service = gapsService(deps)
      if (args.background) {
        const plan = await service.plan(args.chat)
        if (args.fingerprint && args.fingerprint !== plan.fingerprint)
          throw new CliError("validation_error", "the gap plan changed; inspect it again")
        const argv = [
          "store",
          "gaps",
          "repair",
          plan.chat,
          "--fingerprint",
          plan.fingerprint,
          "--limit",
          String(args.limit ?? GAP_BOUNDS.limit),
          "--max-gaps",
          String(args.max_gaps ?? GAP_BOUNDS.maxGaps),
          "--page-size",
          String(args.page_size ?? fetching.page),
          "--repair-time",
          args.repair_time ?? "30s",
          "--pause",
          args.pause ?? fetching.pause,
          prepare ? "--catch-up" : "--no-catch-up",
          ...(args.catch_up_chunks === undefined ? [] : ["--catch-up-chunks", String(args.catch_up_chunks)]),
          ...(args.catch_up_messages === undefined ? [] : ["--catch-up-messages", String(args.catch_up_messages)]),
          ...(args.catch_up_time === undefined ? [] : ["--catch-up-time", args.catch_up_time]),
          "--json",
        ]
        return itemOf(
          snakeKeys(
            startArchiveJob(
              messenger.app,
              defaults.env,
              defaults.settings.profile,
              {
                chat: plan.chat,
                argv,
                limit: args.limit ?? GAP_BOUNDS.limit,
                pageSize: args.page_size ?? fetching.page,
              },
              defaults.spawnJob,
            ),
          ),
        )
      }
      const repaired = await service.repair(args.chat, {
        catchUp: prepare ? preparation : false,
        limit: args.limit,
        maxGaps: args.max_gaps,
        pageSize: args.page_size,
        timeMs: args.repair_time === undefined ? undefined : parseDuration(args.repair_time, "repair_time"),
        pauseMs: parseDuration(args.pause ?? fetching.pause, "pause"),
        fingerprint: args.fingerprint,
        signal: defaults.signal,
      })
      return itemOf(snakeKeys(repaired))
    },
  }),
  store_jobs_show: tool({
    title: "Show a store job",
    description: "The selected profile's own sync/repair job metadata and result, without opening its log.",
    input: v.object({ job: v.pipe(v.string(), v.minLength(1)) }),
    annotations: { ...READ, openWorldHint: false },
    local: async (args, defaults) => {
      const job = readJob(jobsDir(messenger.app, defaults.env), args.job)
      if (!job || job.profile !== defaults.settings.profile)
        throw new CliError("not_found", "no such job in this profile")
      return itemOf(snakeKeys({ ...jobDetails(job), log: job.log }))
    },
  }),
  store_jobs_list: tool({
    title: "List store jobs",
    description: "The selected profile's own sync/repair jobs, newest first.",
    input: v.object({ query: queryArgument(JOBS_QUERY), limit: count(100), page: count(10_000) }),
    annotations: { ...READ, openWorldHint: false },
    output: { entity: "job", list: true },
    local: async (args, defaults) => {
      const limit = args.limit ?? 20
      const page = args.page ?? 1
      const query = listQuery(args.query ?? "", JOBS_QUERY, "store jobs list")
      const rows = jobItems(jobsDir(messenger.app, defaults.env), defaults.settings.profile, query)
      return listOf("store jobs list", {
        items: rows.slice((page - 1) * limit, page * limit),
        limit,
        page,
        has_more: rows.length > page * limit,
      })
    },
  }),
})
