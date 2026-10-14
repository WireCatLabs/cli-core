import { CliError } from "@wirecat/cli-base"
import { annotate } from "@wirecat/cli-base/commands"
import { Command } from "commander"
import { FETCHING } from "../../services/archive.js"
import { GAP_BOUNDS } from "../../services/archive-gaps.js"
import { finishJob, jobsDir, startArchiveJob, updateJob } from "../../services/backfill-jobs.js"
import { validateCatchUpBounds } from "../../services/search-catchup.js"
import { envName } from "../app.js"
import { type BaseEnvironment, environmentOf } from "../context.js"
import { LOCAL_READ, REMOTE_READ } from "../effects.js"
import { itemOf, renderAnswer, snakeKeys } from "../envelope.js"
import { parseDuration } from "../settings.js"
import { nextStep } from "../steps.js"
import type { SpawnJob } from "./backfill-jobs.js"
import { type Messenger, messengerContext, refuseLocalWrite } from "./context.js"
import { stopOnSignal } from "./patience.js"

const count = (value: string) => {
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < 1)
    throw new CliError("validation_error", "expected a positive whole number")
  return number
}
export const gapsCommand = (messenger: Messenger) => {
  const group = new Command("gaps").description("inspect recorded interior coverage gaps and explicitly fetch them")
  annotate(group.command("plan"), { effects: LOCAL_READ })
    .description("local coverage plan; missing message ids alone do not imply missing history")
    .argument("<chat>", messenger.chatArgument)
    .action(async function (this: Command, chat: string) {
      const context = messengerContext(this, messenger)
      renderAnswer(this, context, itemOf(snakeKeys(await context.withServices((services) => services.gaps.plan(chat)))))
    })
  const fetching = messenger.fetching ?? FETCHING
  annotate(group.command("repair"), { effects: REMOTE_READ })
    .description("fetch bounded interior gaps and recheck coverage; never delete unseen messages")
    .argument("<chat>", messenger.chatArgument)
    .option("--limit <n>", "total messages in this repair, 500 by default", count)
    .option("--max-gaps <n>", "at most this many gaps, 5 by default", count)
    .option("--repair-time <duration>", "time budget for the repair, 30s by default", "30s")
    .option("--page-size <n>", "messages per provider page", count)
    .option("--pause <duration>", "provider pause between pages", fetching.pause)
    .option("--fingerprint <hash>", "refuse if this previously inspected coverage plan changed")
    .option("--catch-up", "prepare local search after repair; overrides search_catch_up")
    .option("--no-catch-up", "skip local search preparation after repair")
    .option("--catch-up-chunks <n>", "maximum local chunks prepared", count)
    .option("--catch-up-messages <n>", "maximum stored messages read for preparation", count)
    .option("--catch-up-time <duration>", "preparation time within the repair's remaining budget")
    .option("--background", "repair as an existing store job; inspect store jobs show")
    .action(async function (this: Command, chat: string) {
      const context = messengerContext(this, messenger)
      refuseLocalWrite(context, messenger.app.command, "store.gaps.repair")
      const args = this.opts<{
        catchUp?: boolean
        catchUpChunks?: number
        catchUpMessages?: number
        catchUpTime?: string
        limit?: number
        maxGaps?: number
        repairTime: string
        pageSize?: number
        pause: string
        fingerprint?: string
        background?: boolean
      }>()
      const limit = args.limit ?? GAP_BOUNDS.limit
      const maxGaps = args.maxGaps ?? GAP_BOUNDS.maxGaps
      const pageSize = args.pageSize ?? fetching.page
      const timeMs = parseDuration(args.repairTime, "--repair-time")
      const pauseMs = parseDuration(args.pause, "--pause")
      if (
        limit > 10_000 ||
        maxGaps > 100 ||
        timeMs < 1 ||
        timeMs > 300_000 ||
        pageSize > (fetching.maxPageSize ?? fetching.page)
      )
        throw new CliError("validation_error", "gap repair budgets exceed their bounds")
      const prepare = args.catchUp ?? context.settings.searchCatchUp ?? false
      const preparation = {
        maxChunks: args.catchUpChunks,
        maxMessages: args.catchUpMessages,
        ...(args.catchUpTime === undefined ? {} : { timeMs: parseDuration(args.catchUpTime, "--catch-up-time") }),
      }
      if (
        !prepare &&
        (args.catchUpChunks !== undefined || args.catchUpMessages !== undefined || args.catchUpTime !== undefined)
      )
        throw new CliError("validation_error", "catch-up budgets need --catch-up or search_catch_up true")
      if (prepare) {
        validateCatchUpBounds(preparation)
        refuseLocalWrite(context, messenger.app.command, "conversations.links")
        refuseLocalWrite(context, messenger.app.command, "conversations.embed")
      }
      if (args.background) {
        const planned = await context.withServices((services) => services.gaps.plan(chat))
        if (args.fingerprint && args.fingerprint !== planned.fingerprint)
          throw new CliError("validation_error", "the gap plan changed; inspect it again")
        const argv = [
          "store",
          "gaps",
          "repair",
          planned.chat,
          "--limit",
          String(limit),
          "--max-gaps",
          String(maxGaps),
          "--page-size",
          String(pageSize),
          "--pause",
          args.pause,
          "--repair-time",
          args.repairTime,
          "--fingerprint",
          planned.fingerprint,
          prepare ? "--catch-up" : "--no-catch-up",
          ...(args.catchUpChunks === undefined ? [] : ["--catch-up-chunks", String(args.catchUpChunks)]),
          ...(args.catchUpMessages === undefined ? [] : ["--catch-up-messages", String(args.catchUpMessages)]),
          ...(args.catchUpTime === undefined ? [] : ["--catch-up-time", args.catchUpTime]),
          "--json",
          "--timeout",
          "0",
        ]
        const spawn = environmentOf<BaseEnvironment & { spawnJob?: SpawnJob }>(this).spawnJob
        const started = startArchiveJob(
          messenger.app,
          context.env,
          context.profile,
          { chat: planned.chat, argv, limit, pageSize },
          spawn,
        )
        renderAnswer(
          this,
          context,
          itemOf(snakeKeys(started), { next: [nextStep("store.job", { args: { job: started.job } })] }),
        )
        return
      }
      const job = context.env[envName(messenger.app, "BACKFILL_JOB")]
      const dir = jobsDir(messenger.app, context.env)
      const stop = stopOnSignal(this)
      try {
        const result = await context.withServices((services) =>
          services.gaps.repair(chat, {
            catchUp: prepare ? preparation : false,
            limit,
            maxGaps,
            pageSize,
            timeMs,
            pauseMs,
            fingerprint: args.fingerprint,
            signal: stop.signal,
            note: context.renderer.note,
            onPage: (progress) => {
              if (job) updateJob(dir, job, { progress })
            },
          }),
        )
        if (job) finishJob(messenger.app, dir, job, { finishedAt: new Date().toISOString(), result: { ...result } })
        renderAnswer(this, context, itemOf(snakeKeys(result)))
      } catch (error) {
        if (job)
          finishJob(messenger.app, dir, job, {
            finishedAt: new Date().toISOString(),
            error: {
              code: error instanceof CliError ? error.code : "generic_failure",
              message: "gap repair failed; inspect a fresh plan",
            },
          })
        throw error
      } finally {
        stop.release()
      }
    })
  return group
}
