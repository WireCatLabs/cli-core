import { randomBytes } from "node:crypto"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { CliError } from "@wirecat/cli-base"
import { annotate } from "@wirecat/cli-base/commands"
import { Command } from "commander"
import { parseDuration } from "../../domain/duration.js"
import { isCliFailure } from "../../errors/failures.js"
import { envName } from "../../ports/app.js"
import { FETCHING, type Fetched, type FetchedAll } from "../../services/archive.js"
import { JOBS_QUERY, jobItems } from "../../services/job-query.js"
import { dateWindow } from "../../services/moment.js"
import { validateCatchUpBounds } from "../../services/search-catchup.js"
import { applyTaskRulesSinceLastPass, type RuleResult } from "../../services/task-rules.js"
import { stepLines } from "../../terminal/step-lines.js"
import { type BaseEnvironment, environmentOf } from "../context.js"
import { destroysNothing, FETCH, LOCAL_READ, LOCAL_WRITE } from "../effects.js"
import { itemOf, listOf, renderAnswer, snakeKeys } from "../envelope.js"
import { listQuery, pagedList, pageOf, typedQuery, withQuery } from "../list-query.js"
import { withPaging } from "../paging.js"
import { lineOf, nextStep } from "../steps.js"
import {
  finishJob,
  type Job,
  jobDetails,
  type jobItem,
  jobStarted,
  jobsDir,
  listJobs,
  readJob,
  removeJob,
  type SpawnJob,
  saveJob,
  spawnDetached,
  stateOf,
  tracedJob,
  updateJob,
} from "./backfill-jobs.js"
import { type Messenger, type MessengerContext, messengerContext, refuseLocalWrite } from "./context.js"
import { reviewPoint } from "./mention-points.js"
import { stopOnSignal } from "./patience.js"

/**
 * A chat's history into the store, newest to oldest, **resumable**: after every page the stretch it
 * covered is recorded, so a stop — Ctrl-C, `--timeout`, `--limit`, `--since-time`, `--last`, a long FloodWait — loses
 * nothing, and the next run jumps over what is already held. Needs numeric message ids, which order
 * the chat.
 */
/** How far back `messages sync --all` goes unless told: enough for most searches, bounded for big chats. */
const ALL_SINCE = "90d"
/** What a background `--all` job is listed under; no chat argument is spelled like it. */
const ALL_CHATS = "--all"

export const syncCommand = (messenger: Messenger): Command => {
  const fetching = messenger.fetching ?? FETCHING
  return annotate(new Command("sync"), {
    output: { entity: "message_sync" },
    examples: [`${messenger.app.command} personal messages sync "Book club" --last 100`],
    effects: FETCH,
    cooperative: true,
  })
    .summary("fetch and save a chat's message history")
    .description(
      "bring a chat's history in the local store up to date, newest first; run it again to continue; --all syncs every chat; " +
        'with --json, stderr carries progress lines: {"event":"progress","step":"sync","chats","chats_done","fetched"}, counts only',
    )
    .argument("[chat]", messenger.chatArgument)
    .option(
      "--all",
      `every chat, most recently active first — what search needs; the last ${ALL_SINCE} unless --since-time or --last`,
    )
    .option(
      "--limit <n>",
      `at most this many messages in this run, per chat with --all; ${fetching.maxPages * fetching.page} if not given`,
      wholeNumber,
    )
    .option("--page-size <n>", `how many messages one request asks for; ${fetching.page} if not given`, wholeNumber)
    .option(
      "--pause <duration>",
      fetching.jitter
        ? "the least pause between pages, to stay under the provider's limits; each is up to twice that"
        : "pause between pages, to stay under the provider's limits",
      fetching.pause,
    )
    .option("--since-time <time>", "stop once it reaches messages older than this: ISO 8601, or 2h / 1d ago")
    .option("--last <n>", "stop once the newest n messages are held", wholeNumber)
    .option("--catch-up", "prepare local search after this run; overrides search_catch_up")
    .option("--no-catch-up", "skip local preparation after this run")
    .option("--catch-up-chunks <n>", "at most this many local vector chunks", wholeNumber)
    .option("--catch-up-messages <n>", "skip a graph rebuild larger than this many messages", wholeNumber)
    .option("--catch-up-time <duration>", "local preparation time budget, 30s by default")
    .option("--background", "run as a job that outlives this command; `store jobs show` follows it")
    .option(
      "--dry-run",
      "only estimate how many messages, requests and minutes a full fetch would still take — from the store, no request",
    )
    .action(async function (this: Command, chat: string | undefined) {
      const {
        all,
        pause,
        sinceTime: since,
        last,
        background,
        dryRun: estimate,
        catchUp,
        catchUpChunks,
        catchUpMessages,
        catchUpTime,
        ...sizes
      } = this.opts<{
        all?: boolean
        limit?: number
        pageSize?: number
        pause: string
        sinceTime?: string
        last?: number
        background?: boolean
        dryRun?: boolean
        catchUp?: boolean
        catchUpChunks?: number
        catchUpMessages?: number
        catchUpTime?: string
      }>()
      if ((chat === undefined) === (all !== true))
        throw new CliError("validation_error", "name a chat, or --all for every chat")
      if (all && estimate) throw new CliError("validation_error", "--dry-run prices one chat; not with --all")
      if (all && messenger.history === "store") {
        throw new CliError(
          "validation_error",
          `--all walks the messenger's chat list, and ${messenger.name ?? messenger.app.command} pushes its chats ` +
            `instead — keep \`${lineOf(this, "serve")}\` running${messenger.historyOnDemand ? ", or name one chat" : ""}`,
        )
      }
      if (since !== undefined && last !== undefined) {
        throw new CliError("validation_error", "give --since-time or --last, not both: how far back the fetch goes")
      }
      const pageSize = sizes.pageSize ?? fetching.page
      // Above the cap every full page comes back short, and an adapter may read a short page as the chat's start.
      if (fetching.maxPageSize !== undefined && pageSize > fetching.maxPageSize) {
        throw new CliError(
          "validation_error",
          `--page-size takes at most ${fetching.maxPageSize}: ${messenger.name ?? messenger.app.command} returns no more per request`,
        )
      }
      const limit = sizes.limit ?? fetching.maxPages * fetching.page
      const pauseMs = parseDuration(pause, "--pause")
      const from = since ?? (all && last === undefined ? ALL_SINCE : undefined)
      const window = dateWindow(from === undefined ? {} : { sinceTime: from })
      const sinceMs = window.since
      const context = messengerContext(this, messenger)
      const prepare = catchUp ?? context.settings.searchCatchUp ?? false
      const preparation = {
        ...(catchUpChunks === undefined ? {} : { maxChunks: catchUpChunks }),
        ...(catchUpMessages === undefined ? {} : { maxMessages: catchUpMessages }),
        ...(catchUpTime === undefined ? {} : { timeMs: parseDuration(catchUpTime, "--catch-up-time") }),
      }
      if (!prepare && (catchUpChunks !== undefined || catchUpMessages !== undefined || catchUpTime !== undefined))
        throw new CliError("validation_error", "catch-up budgets need --catch-up or search_catch_up true")
      if (estimate) {
        if (since !== undefined || last !== undefined) {
          throw new CliError(
            "validation_error",
            "--dry-run prices a full fetch; --since-time and --last do not narrow it",
          )
        }
        const named = chat as string
        const answer = await context.withServices((services) =>
          services.archive.estimate(named, { limit, pageSize, pauseMs }),
        )
        renderAnswer(this, context, itemOf(snakeKeys(answer)))
        if (answer.missing === null) {
          context.renderer.note(
            `nothing held of this chat to measure by — \`${lineOf(this, `messages sync ${chat} --limit ${pageSize}`)}\` gives the estimate something to go on`,
          )
        } else if (answer.missing > 0) context.renderer.note("an estimate: provider waits (FloodWait) come on top")
        return
      }
      if (prepare) {
        validateCatchUpBounds(preparation)
        refuseLocalWrite(context, messenger.app.command, "conversations.links")
        refuseLocalWrite(context, messenger.app.command, "conversations.embeddings")
      }
      if (background) {
        const named = chat ?? ALL_CHATS
        const argv = fetchArgv(this, {
          chat: named,
          limit,
          pageSize,
          pause,
          catchUp: prepare,
          ...(catchUpChunks === undefined ? {} : { catchUpChunks }),
          ...(catchUpMessages === undefined ? {} : { catchUpMessages }),
          ...(catchUpTime === undefined ? {} : { catchUpTime }),
          ...(last === undefined ? {} : { last }),
          ...(sinceMs === undefined ? {} : { since: new Date(sinceMs).toISOString() }),
        })
        const started = launchJob(this, context, messenger, {
          chat: named,
          argv,
          limit,
          pageSize,
          ...(last === undefined ? {} : { last }),
        })
        renderAnswer(
          this,
          context,
          itemOf(snakeKeys(started), {
            next: [nextStep("store.job", { args: { job: started.job } })],
            meta: window.meta,
          }),
        )
        return
      }
      const jobs = jobsDir(messenger.app, context.env)
      const jobId = context.env[envName(messenger.app, "BACKFILL_JOB")]
      const stop = stopOnSignal(this)
      const progress = syncProgress(stepLines(context.streams.diagnostic, context.format !== "pretty"))
      try {
        const options = {
          limit,
          pageSize,
          pauseMs,
          catchUp: prepare ? preparation : (false as const),
          ...(sinceMs === undefined ? {} : { sinceMs }),
          ...(last === undefined ? {} : { last }),
          note: context.renderer.note,
          stop: stop.signal,
          onPage: (page: { fetched: number; chatId: string; oldest: number }) => {
            if (jobId) updateJob(jobs, jobId, { progress: { ...page, at: new Date().toISOString() } })
            if (chat !== undefined) progress({ chats: null, chats_done: null, fetched: page.fetched })
          },
          onChat: ({ chats, done, fetched }: { chats: number; done: number; fetched: number }) =>
            progress({ chats, chats_done: done, fetched }, done === 0 || done === chats),
        }
        const result = await context.withServices(
          (services): Promise<Fetched | FetchedAll> =>
            chat === undefined ? services.archive.fetchAll(options) : services.archive.fetch(chat, options),
        )
        if (jobId) finishJob(messenger.app, jobs, jobId, { finishedAt: new Date().toISOString(), result })
        const tasks = await taskRulesAfterSync(context)
        const prepared = "prepared" in result ? result.prepared : undefined
        const unprepared = prepared && !prepared.complete && "chat" in result && result.chat !== null
        const point = reviewPoint(messenger.app, context.settings.profile, context.env)
        const review = await context.withServices((services) => services.mentions.newCount(point.after))
        const toReview = review.count
        const shown = `${toReview}${review.more ? "+" : ""}`
        renderAnswer(
          this,
          context,
          itemOf(
            snakeKeys(tasks && tasks.added + tasks.closed + (tasks.held ?? 0) > 0 ? { ...result, tasks } : result),
            {
              next: [
                ...(unprepared
                  ? [
                      nextStep("conversations.build", { args: { chat: result.chat } }),
                      nextStep("conversations.embed", { args: { chat: result.chat } }),
                    ]
                  : []),
                ...(toReview > 0 ? [nextStep("mentions.review", { args: { new: true }, values: { shown } })] : []),
              ],
              meta: window.meta,
            },
          ),
        )
        if (tasks?.held)
          context.renderer.note(
            `the first sync left ${tasks.held} possible task(s) in ${tasks.heldChats ?? 0} chat(s) unopened ` +
              `(config task_first_pass_per_chat) — ask the owner, then \`${lineOf(this, "tasks scan <chat>")}\``,
          )
        if (toReview > 0)
          context.renderer.note(
            `${shown} mention${toReview === 1 ? "" : "s"} found since the last review — ` +
              `\`${lineOf(this, "mentions list --new")}\``,
          )
      } catch (error) {
        if (jobId) {
          const code = isCliFailure(error) ? error.code : "generic_failure"
          // The job file outlives the run; the message can name a chat, so only the job's log keeps it.
          const message = `${code} — \`store jobs show ${jobId}\` names the log with the whole error`
          finishJob(messenger.app, jobs, jobId, { finishedAt: new Date().toISOString(), error: { code, message } })
        }
        throw error
      } finally {
        stop.release()
      }
    })
}

/** At most this often a progress line, so a run of fast pages or of chats already current does not flood the window. */
const PROGRESS_EVERY_MS = 500

/**
 * `messages sync`'s progress for a window to draw a bar by: counts only, because the lines reach a desktop app and
 * its logs — never a chat's id or title. `always` keeps the first and the last line of `--all` through the throttle.
 */
const syncProgress = (emit: ReturnType<typeof stepLines>) => {
  let last = Number.NEGATIVE_INFINITY
  return (counts: { chats: number | null; chats_done: number | null; fetched: number }, always = false) => {
    const now = Date.now()
    if (!always && now - last < PROGRESS_EVERY_MS) return
    last = now
    emit({ event: "progress", step: "sync", ...counts })
  }
}

/**
 * What the sync stored, through the task rules (owner, 2026-10-14). A failure is noted, never the sync's failure:
 * the messages are already kept, and the next sync's pass starts from the same stop point.
 */
const taskRulesAfterSync = async (context: MessengerContext): Promise<RuleResult | undefined> => {
  try {
    return await context.withStore((store, account) => applyTaskRulesSinceLastPass(store, account), {
      name: "sync tasks",
    })
  } catch (error) {
    context.renderer.note(`task rules skipped: ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
}

/** `store jobs`: the background runs `messages sync --background` started. */
export const jobsCommand = (messenger: Messenger): Command => {
  const command = new Command("jobs").description("background sync jobs")

  withQuery(
    withPaging(
      annotate(command.command("list"), { effects: LOCAL_READ }).description("background sync jobs, newest first"),
    ),
    JOBS_QUERY,
  ).action(function (this: Command, words: string[]) {
    const context = messengerContext(this, messenger)
    const query = listQuery(typedQuery(words), JOBS_QUERY, "store jobs list")
    const jobs = jobItems(jobsDir(messenger.app, context.env), context.profile, query)
    const { limit, offset } = pageOf(context.settings)
    const items = jobs.slice(offset, offset + limit)
    renderAnswer(
      this,
      context,
      pagedList("store jobs list", context.settings, { items, has_more: jobs.length > offset + limit }),
      () => items.map((one) => `${jobLine(one)}\n`).join(""),
    )
    if (jobs.length === 0 && context.format === "pretty")
      context.renderer.note(`no ${query ? "matching " : ""}background sync jobs for this profile`)
  })

  annotate(command.command("show"), { output: { entity: "store_job_details" }, effects: LOCAL_READ })
    .summary("one archive job's status and log")
    .description("one background job — the newest when none is named — and what the store now holds of its chat")
    .argument("[job]", "the job id `messages sync --background` printed")
    .action(async function (this: Command, id: string | undefined) {
      const context = messengerContext(this, messenger)
      const job = findJob(messenger, context, id)
      const chatId = job.progress?.chatId
      const held =
        chatId === undefined
          ? undefined
          : await context.withServices((services) => services.archive.held(chatId)).catch(() => undefined)
      renderAnswer(this, context, itemOf(snakeKeys({ ...jobDetails(job), ...(held ? { held } : {}), log: job.log })))
    })

  destroysNothing(annotate(command.command("cancel"), { output: { entity: "store_job_cancel" }, effects: LOCAL_WRITE }))
    .summary("cancel a queued or running archive job")
    .description("stop a running background job after its current page; a later sync resumes where it stopped")
    .argument("<job>", "the job id")
    .action(function (this: Command, id: string) {
      const context = messengerContext(this, messenger)
      const job = findJob(messenger, context, id)
      if (stateOf(job) !== "running") {
        throw new CliError("validation_error", `job ${job.id} is not running — it is ${stateOf(job)}`)
      }
      updateJob(jobsDir(messenger.app, context.env), job.id, { cancelRequestedAt: new Date().toISOString() })
      process.kill(job.pid, "SIGTERM")
      renderAnswer(this, context, itemOf({ job: job.id, cancelled: true }))
    })

  destroysNothing(annotate(command.command("retry"), { output: { entity: "store_job_retry" }, effects: LOCAL_WRITE }))
    .summary("retry an archive job")
    .description("start a partial, failed or died job again, as a new job; the sync resumes where the store stopped")
    .argument("[job]", "the job id")
    .option("--failed", "every chat whose newest job partial, failed or died")
    .action(function (this: Command, id: string | undefined) {
      const context = messengerContext(this, messenger)
      const { failed } = this.opts<{ failed?: boolean }>()
      if ((id === undefined) === (failed !== true))
        throw new CliError("validation_error", "name a job, or --failed for every partial or failed one")
      const broken = (job: Job) => ["partial", "failed", "died"].includes(stateOf(job))
      if (id !== undefined) {
        const job = findJob(messenger, context, id)
        if (!broken(job)) throw new CliError("validation_error", `job ${job.id} did not fail — it is ${stateOf(job)}`)
        renderAnswer(this, context, itemOf(snakeKeys(retryJob(this, context, messenger, job))))
        return
      }
      const newest = new Map<string, Job>()
      for (const job of listJobs(jobsDir(messenger.app, context.env)))
        if (job.profile === context.profile && !newest.has(job.chat)) newest.set(job.chat, job)
      const items = []
      for (const job of [...newest.values()].filter(broken)) {
        try {
          items.push(retryJob(this, context, messenger, job))
        } catch (error) {
          if (!(error instanceof CliError)) throw error
          items.push({ retried: job.id, chat: job.chat, error: { code: error.code, message: error.message } })
        }
      }
      renderAnswer(
        this,
        context,
        listOf("store jobs retry", {
          items: items.map(snakeKeys),
          limit: Math.max(1, items.length),
          has_more: false,
        }),
      )
      if (items.length === 0 && context.format === "pretty")
        context.renderer.note("no partial, failed or died jobs to retry")
    })

  destroysNothing(annotate(command.command("clear"), { output: { entity: "store_job_clear" }, effects: LOCAL_WRITE }))
    .description("forget finished jobs and remove their logs; a running job is kept")
    .action(function (this: Command) {
      const context = messengerContext(this, messenger)
      const dir = jobsDir(messenger.app, context.env)
      const finished = listJobs(dir).filter((job) => job.profile === context.profile && stateOf(job) !== "running")
      for (const job of finished) removeJob(dir, job)
      renderAnswer(this, context, itemOf({ cleared: finished.map((job) => job.id) }))
    })

  return command
}

const jobLine = (one: ReturnType<typeof jobItem>) =>
  `${one.id}  ${one.state.padEnd(9)}  ${one.started_at.slice(0, 16).replace("T", " ")}  ${one.chat}  ` +
  `${one.fetched} fetched${one.issue ? `  ${one.issue.message}` : ""}${one.error ? `  ${one.error.message}` : ""}`

const findJob = (messenger: Messenger, context: MessengerContext, id: string | undefined): Job => {
  const dir = jobsDir(messenger.app, context.env)
  const job = id === undefined ? listJobs(dir).find((each) => each.profile === context.profile) : readJob(dir, id)
  if (!job || job.profile !== context.profile) {
    throw new CliError(
      "not_found",
      id === undefined ? "no background sync jobs for this profile" : `no sync job ${id} for this profile`,
    )
  }
  return job
}

const fetchArgv = (
  command: Command,
  {
    chat,
    limit,
    pageSize,
    pause,
    since,
    last,
    catchUp,
    catchUpChunks,
    catchUpMessages,
    catchUpTime,
  }: {
    chat: string
    limit: number
    pageSize: number
    pause: string
    since?: string
    last?: number
    catchUp?: boolean
    catchUpChunks?: number
    catchUpMessages?: number
    catchUpTime?: string
  },
): string[] => {
  const { timeout } = command.optsWithGlobals<{ timeout?: string }>()
  return [
    "messages",
    "sync",
    chat,
    "--limit",
    String(limit),
    "--page-size",
    String(pageSize),
    "--pause",
    pause,
    ...(since === undefined ? [] : ["--since-time", since]),
    ...(last === undefined ? [] : ["--last", String(last)]),
    ...(catchUp === undefined ? [] : [catchUp ? "--catch-up" : "--no-catch-up"]),
    ...(catchUpChunks === undefined ? [] : ["--catch-up-chunks", String(catchUpChunks)]),
    ...(catchUpMessages === undefined ? [] : ["--catch-up-messages", String(catchUpMessages)]),
    ...(catchUpTime === undefined ? [] : ["--catch-up-time", catchUpTime]),
    "--json",
    ...(timeout ? ["--timeout", timeout] : []),
  ]
}

const launchJob = (
  command: Command,
  context: MessengerContext,
  messenger: Messenger,
  {
    chat,
    argv,
    limit,
    pageSize,
    last,
  }: { chat: string; argv: string[]; limit: number; pageSize: number; last?: number },
) => {
  const { app } = messenger
  const dir = jobsDir(app, context.env)
  const running = listJobs(dir).find(
    (job) => job.profile === context.profile && job.chat === chat && stateOf(job) === "running",
  )
  if (running) {
    throw new CliError(
      "validation_error",
      `job ${running.id} is already fetching ${chat} (PID ${running.pid}) — \`${app.command} ${context.profile} store jobs show ${running.id}\``,
    )
  }
  const now = new Date()
  const id = `${now.toISOString().replace(/[-:]/g, "").slice(0, 15)}-${randomBytes(3).toString("hex")}`
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const log = join(dir, `${id}.log`)
  // A shell's --timeout default would cut a job short that was asked to outlive the shell.
  const { [envName(app, "TIMEOUT")]: _timeout, ...inherited } = context.env
  const traced = tracedJob({
    ...inherited,
    [envName(app, "PROFILE")]: context.profile,
    [envName(app, "BACKFILL_JOB")]: id,
  })
  const job: Job = {
    id,
    chat,
    profile: context.profile,
    pid: 0,
    startedAt: now.toISOString(),
    limit,
    pageSize,
    ...(last === undefined ? {} : { last }),
    argv,
    log,
  }
  saveJob(dir, job)
  const spawnJob = environmentOf<BaseEnvironment & { spawnJob?: SpawnJob }>(command).spawnJob ?? spawnDetached
  const pid = spawnJob(argv, traced.env, log)
  jobStarted(app, dir, { ...job, pid, traceId: traced.traceId })
  return { job: id, pid, chat, log }
}

/** A job recorded before it kept its argv: what it did keep, the pause and window back at their defaults. */
const argvOf = (command: Command, messenger: Messenger, job: Job): string[] => {
  if (job.argv) return [...job.argv]
  const fetching = messenger.fetching ?? FETCHING
  return fetchArgv(command, {
    chat: job.chat,
    limit: job.limit ?? fetching.maxPages * fetching.page,
    pageSize: job.pageSize ?? fetching.page,
    pause: fetching.pause,
    ...(job.last === undefined ? {} : { last: job.last }),
  })
}

const retryJob = (command: Command, context: MessengerContext, messenger: Messenger, job: Job) => {
  const fetching = messenger.fetching ?? FETCHING
  const limit = job.limit ?? fetching.maxPages * fetching.page
  const started = launchJob(command, context, messenger, {
    chat: job.chat,
    argv: argvOf(command, messenger, job),
    limit,
    pageSize: job.pageSize ?? fetching.page,
    ...(job.last === undefined ? {} : { last: job.last }),
  })
  return { retried: job.id, ...started }
}

const wholeNumber = (value: string): number => {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1) throw new CliError("validation_error", `"${value}" is not a count`)
  return parsed
}
