import { CliError, type ErrorCode, isCliError } from "@wirecat/cli-base"
import { annotate, sharedCommand } from "@wirecat/cli-base/commands"
import type { QueryRegistry } from "@wirecat/cli-base/query"
import type { NextStep } from "@wirecat/cli-base/standards"
import { type Command, InvalidArgumentError, Option } from "commander"
import * as v from "valibot"
import { answerEntity } from "../../cli/answer-entity.js"
import { environmentOf, inCommandRun, outputFor, runBudgetOf } from "../../cli/context.js"
import type { DocumentSyncStep } from "../../cli/documents/library.js"
import { honoursDryRun } from "../../cli/dry-run-guard.js"
import { allowDeletionsOption, FETCH, LOCAL_READ, LOCAL_WRITE, NO_EFFECTS } from "../../cli/effects.js"
import { type Body, itemOf, listOf, renderAnswer } from "../../cli/envelope.js"
import { listQuery, nativeTermLists, queryTerms, termField, typedQuery, withQuery } from "../../cli/list-query.js"
import { commandAt, lineOf, nextStep, rootOf } from "../../cli/steps.js"
import { aheadOf } from "../../domain/moment.js"
import {
  STATE_TYPES,
  type StateType,
  TRACKER_KINDS,
  TRACKER_PRIORITY_LABELS,
  type TrackerKind,
  type TrackerRecords,
} from "../../domain/tracker.js"
import { chosenTextModel } from "../../embeddings/models.js"
import { count, text } from "../../entities/fields.js"
import type { AppIdentity } from "../../ports/app.js"
import { searchTracker } from "../../services/search-all-tracker.js"
import { embedTracker } from "../../services/tracker-meaning.js"
import type { TrackerFilter, TrackerItem } from "../../store/sqlite/tracker.js"
import type { MessageStore } from "../../store/store.js"
import type { AccountKey } from "../../store/types.js"
import type { TrackerSource } from "../source.js"
import { syncTracker } from "../sync.js"
import { trackerIssueTask } from "../tasks.js"
import type { TrackerWrite } from "../writer.js"
import {
  ambiguousTrackerReference,
  type TrackerNamed,
  type TrackerWrites,
  trackerMatches,
  unknownTrackerReference,
} from "../writes.js"
import { addTrackerWriteCommands } from "./writes.js"

/** The selected profile's tracker account, opened for one command and closed before its answer is printed. */
export interface TrackerRun {
  account: AccountKey
  store: MessageStore
  /** The tracker, built on first use: a command that only reads the store never reads the sign-in. */
  source: () => TrackerSource
  /** The tracker's writer and the profile's levels, built for the command run; needed by every write command. */
  writes?: (command: Command) => TrackerWrites
  close?: () => Promise<void>
}

export interface TrackerCommandOptions {
  /** The CLI itself: the first word of examples. */
  app: AppIdentity
  /** Opens the selected profile for one command; `readOnly` when the command only reads the store. */
  open: (command: Command, access: { readOnly: boolean }) => Promise<TrackerRun>
  /**
   * What the tracker's writer takes (`TrackerWriter.writes`): mounts `issues create`, `issues update` and
   * `issues comments create`.
   */
  writes?: readonly TrackerWrite[]
  /**
   * The documents half of `sync`, from `documentLibrary`, for a CLI that mounts the shared documents commands too:
   * one `sync` then brings both and answers the documents under `documents`.
   */
  documents?: DocumentSyncStep
  now?: () => number
}

const MOST = 500
// The documents' own answer has a `skipped` list of files; a part that did not run says why in a string.
const isSkipped = (item: object): boolean => typeof (item as { skipped?: unknown }).skipped === "string"
const EMBED_MAX = 600

const integer = (most: number) => (value: string) => {
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < 1 || number > most)
    throw new InvalidArgumentError(`a whole number from 1 to ${most}`)
  return number
}

const ARCHIVED = termField("archived", "enum", "archived:include", {
  values: ["include"],
  relation: "archived ones too; left out, only those not archived",
})

const listQueryOf = (kind: TrackerKind): QueryRegistry => ({
  entity: `tracker_${kind}`,
  backend: "native",
  fields: [ARCHIVED],
})

/** What `issues list` narrows by: each by its name or the tracker's id, as `issues show` and the lists name them. */
const ISSUES_QUERY = {
  entity: "tracker_issue",
  backend: "native",
  fields: [
    termField("team", "kw", "team:ENG", { relation: "the team's name, key or id, as teams list shows it" }),
    termField("project", "kw", 'project:"Billing revamp"', {
      relation: "the project's name or id, as projects list shows it",
    }),
    termField("assignee", "kw", "assignee:none", {
      relation: "the user's name, e-mail or id, as users list shows it, or none",
    }),
    termField("state", "kw", 'state:"In Progress"', {
      relation: "the state's name or id, as states list shows it; with team:, that team's",
    }),
    termField("type", "enum", "type:started", { values: [...STATE_TYPES], relation: "repeat for any of several" }),
    termField("label", "kw", "label:Bug", { relation: "the label's name or id, as labels list shows it" }),
    termField("sprint", "kw", "sprint:12", {
      relation: "the sprint's name, number or id, as sprints list shows it, or none",
    }),
    ARCHIVED,
  ],
} as const satisfies QueryRegistry

const TIMES = new Set(["createdAt", "updatedAt", "archivedAt", "completedAt", "canceledAt", "startsAt", "endsAt"])

const snake = (name: string) => name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)

/** A tracker's text is someone else's: an agent reads these fields as data, never as instructions. */
const UNTRUSTED: Record<TrackerKind, string[]> = {
  team: ["name"],
  user: ["name"],
  state: ["name"],
  label: ["name"],
  project: ["name", "description", "status"],
  sprint: ["name", "description"],
  issue: ["title", "description", "state_name", "labels_names"],
  comment: ["body"],
}

const viewOf = (item: TrackerItem, extra: Record<string, unknown> = {}) => ({
  kind: item.kind,
  ...Object.fromEntries(
    Object.entries(item.record).map(([name, value]) => [
      snake(name),
      TIMES.has(name) && typeof value === "number" ? new Date(value).toISOString() : value,
    ]),
  ),
  ...extra,
  deleted: item.deletedAt !== null,
  untrusted: UNTRUSTED[item.kind],
})

const trackerView = v.looseObject({ kind: v.picklist(TRACKER_KINDS), external_id: text, deleted: v.boolean() })

const trackerSync = v.strictObject({
  provider: text,
  account: text,
  state: v.picklist(["partial", "complete"]),
  complete: v.boolean(),
  stopped: v.optional(v.picklist(["requests", "deadline", "cancelled"])),
  synced: v.array(
    v.strictObject({
      kind: v.picklist(TRACKER_KINDS),
      round: v.picklist(["full", "changes"]),
      reset: v.boolean(),
      state: v.picklist(["partial", "complete"]),
      saved: count,
      unlisted: count,
      pass: v.optional(v.picklist(["complete", "partial", "held"])),
      held: v.optional(text),
      error: v.optional(text),
    }),
  ),
  gaps: v.array(v.strictObject({ kind: v.picklist(TRACKER_KINDS), message: text, scope: v.optional(text) })),
  progress: v.strictObject({ requests: count, saved: count, steps: count }),
  deletions: v.strictObject({ checked: v.nullable(text), due: text }),
  tasks: v.optional(
    v.union([
      v.strictObject({ opened: count, closed: count, reopened: count, renamed: count }),
      v.strictObject({ skipped: text }),
    ]),
  ),
  /** What `sync --embed` embedded of the issues, projects and comments: `embedTracker`'s answer. */
  embeddings: v.optional(
    v.strictObject({
      model: text,
      embedded: count,
      left: v.boolean(),
      stopped: v.optional(v.picklist(["deadline", "cancelled"])),
      remaining: v.optional(count),
    }),
  ),
})

const partError = v.strictObject({ code: text, reason: v.optional(text), message: text })

/** The tracker's answer as `tracker_sync` has it, or the error it failed with, and the documents' answer or error. */
const trackerDocumentsSync = v.union([
  v.strictObject({
    ...trackerSync.entries,
    documents: v.union([v.looseObject({}), v.strictObject({ error: partError })]),
  }),
  v.strictObject({
    complete: v.literal(false),
    synced: v.tuple([]),
    error: partError,
    documents: v.union([v.looseObject({}), v.strictObject({ error: partError })]),
  }),
])

interface SyncOptions {
  maxPages?: number
  rescan?: boolean
  allowDeletions?: number
  embed?: boolean
}

type TrackerReport = Awaited<ReturnType<typeof syncTracker>> & { embeddings?: Awaited<ReturnType<typeof embedTracker>> }
type DocumentsOutcome = Awaited<ReturnType<DocumentSyncStep>>
type Settled<T> = { value: T } | { error: unknown }

const resumeStep = (opts: SyncOptions, why: string, extra: Record<string, unknown> = {}): NextStep => ({
  kind: "command",
  step: "tracker.sync",
  command: "sync",
  args: {
    ...(opts.maxPages === undefined ? {} : { max_pages: opts.maxPages }),
    ...(opts.embed ? { embed: true } : {}),
    ...extra,
  },
  why,
  safe_to_auto_execute: true,
})

// Not a failure of the run: a key without the scope lacks it on every sync, so it must not mark the sync partial.
const UNREAD = "tracker.kind-unread"

const trackerIssues = (report: TrackerReport) => [
  ...report.gaps.map((gap) => ({ code: "permission_error" as const, reason: UNREAD, source: `tracker:${gap.kind}` })),
  ...report.synced
    .filter((one) => one.error !== undefined)
    .map((one) => ({ code: "provider_error" as const, reason: "sync.partial", source: `tracker:${one.kind}` })),
  ...report.synced
    .filter((one) => one.pass === "held")
    .map((one) => ({
      code: "validation_error" as const,
      reason: "tracker.unlisted-held",
      source: `tracker:${one.kind}`,
    })),
]

const trackerNext = (report: TrackerReport, opts: SyncOptions): NextStep[] =>
  report.state === "partial" && report.progress.steps > 0
    ? [
        resumeStep(
          opts,
          report.synced.some((one) => one.error !== undefined)
            ? "a kind failed to sync; running sync again retries it"
            : "the sync stopped before its end; running it again goes on from there",
        ),
      ]
    : []

/** Why `--embed` failed after the sync saved its report: a model not downloaded. */
const embeddingIssue = (error: unknown) => {
  const { code, reason } = errorOf(error)
  return { code, reason: reason ?? "sync.failed", source: "tracker:embeddings" }
}

const trackerAnswer = (report: TrackerReport, opts: SyncOptions, embedError?: unknown): Body => {
  const issues = [...trackerIssues(report), ...(embedError === undefined ? [] : [embeddingIssue(embedError)])]
  const next = trackerNext(report, opts)
  return itemOf(report, {
    ...(report.state === "partial" || issues.length
      ? { meta: { complete: false, ...(issues.length ? { issues } : {}) } }
      : {}),
    ...(next.length ? { next } : {}),
  })
}

const errorOf = (error: unknown): { code: ErrorCode; reason?: string; message: string } => {
  if (!isCliError(error))
    return {
      code: "provider_error",
      reason: "sync.failed",
      message: error instanceof Error ? error.message : String(error),
    }
  const reason = error.details.reason
  return { code: error.code, ...(typeof reason === "string" ? { reason } : {}), message: error.message }
}

/**
 * Both parts in one answer: the tracker's report as `tracker_sync` has it, the documents' under `documents`. A part
 * that fails is named in its place and in `meta.issues`, so the other's answer still shows; `complete` is both parts'.
 */
const combinedAnswer = (
  tracker: Settled<TrackerReport>,
  documents: Settled<DocumentsOutcome>,
  opts: SyncOptions & { timeout?: string },
  embedError?: unknown,
): Body => {
  const failed = (part: string, error: { code: ErrorCode; reason?: string }) => ({
    code: error.code,
    reason: error.reason ?? "sync.failed",
    source: part,
  })
  const trackerError = "error" in tracker ? errorOf(tracker.error) : undefined
  const documentsError = "error" in documents ? errorOf(documents.error) : undefined
  const report = "value" in tracker ? tracker.value : undefined
  const outcome = "value" in documents ? documents.value : undefined
  const issues = [
    ...(report ? trackerIssues(report) : []),
    ...(trackerError ? [failed("tracker", trackerError)] : []),
    ...(embedError === undefined ? [] : [embeddingIssue(embedError)]),
    ...(outcome?.meta.issues ?? []),
    ...(documentsError ? [failed("documents", documentsError)] : []),
  ]
  const complete =
    report?.state === "complete" &&
    outcome !== undefined &&
    outcome.meta.complete !== false &&
    issues.every((one) => one.reason === UNREAD)
  const [trackerStep] = report ? trackerNext(report, opts) : []
  const resume = trackerStep !== undefined || outcome?.next.some(({ step }) => step === "sync.run")
  const next: NextStep[] = [
    ...(resume
      ? [
          resumeStep(opts, trackerStep?.why ?? "the sync stopped before its end; running it again goes on from there", {
            ...(opts.timeout === undefined ? {} : { timeout: opts.timeout }),
          }),
        ]
      : []),
    ...(outcome?.next.filter(({ step }) => step !== "sync.run") ?? []),
  ]
  const documentsPart = outcome ? outcome.item : { error: documentsError }
  const item = report
    ? { ...report, complete, documents: documentsPart }
    : { complete: false as const, synced: [], error: trackerError, documents: documentsPart }
  return itemOf(item, {
    ...(complete && !issues.length ? {} : { meta: { complete: false, ...(issues.length ? { issues } : {}) } }),
    ...(next.length ? { next } : {}),
  })
}

const trackerWrite = v.strictObject({
  operation_id: text,
  issue: v.optional(trackerView),
  comment: v.optional(trackerView),
  untrusted: v.array(text),
})

const trackerTask = v.strictObject({ task_id: text, key: v.optional(text), issue: text, created: v.boolean() })

/** Each issue with its state's name and type, and its assignee's name and person, read from the same copy. */
const withNames = async (run: TrackerRun, items: TrackerItem<"issue">[]) => {
  const ids = (kind: "state" | "user", pick: (issue: TrackerRecords["issue"]) => string | null | undefined) =>
    [...new Set(items.map((one) => pick(one.record)).filter((one): one is string => typeof one === "string"))].map(
      async (id) => [id, (await run.store.tracker.get(run.account, kind, id))?.record] as const,
    )
  const states = new Map(await Promise.all(ids("state", (issue) => issue.state)))
  const users = new Map(await Promise.all(ids("user", (issue) => issue.assignee)))
  const people = new Map(
    (await run.store.tracker.people(run.account, [...users.keys()])).map((one) => [one.user, one.person]),
  )
  return items.map((item) => {
    const state = item.record.state ? (states.get(item.record.state) as TrackerRecords["state"] | undefined) : undefined
    const assignee = item.record.assignee
      ? (users.get(item.record.assignee) as TrackerRecords["user"] | undefined)
      : undefined
    const { priority } = item.record
    return viewOf(item, {
      ...(state ? { state_name: state.name, state_type: state.type } : {}),
      // Beside the tracker's number, the family's word, which --priority takes back.
      ...(typeof priority === "number" ? { priority_label: TRACKER_PRIORITY_LABELS[priority] ?? null } : {}),
      ...(assignee ? { assignee_name: assignee.name } : {}),
      ...(item.record.assignee && people.has(item.record.assignee)
        ? { assignee_person: people.get(item.record.assignee) }
        : {}),
    })
  })
}

const issueOf = async (run: TrackerRun, reference: string) => {
  const found =
    (await run.store.tracker.get(run.account, "issue", reference)) ??
    (await run.store.tracker.issueByKey(run.account, reference))
  if (!found) throw new InvalidArgumentError(`no issue ${reference} in the copy; run sync, then try again`)
  return found
}

const addTrackerCommandsDefinition = (program: Command, options: TrackerCommandOptions): void => {
  const now = () => options.now?.() ?? Date.now()
  const within = (command: Command, readOnly: boolean, work: (run: TrackerRun) => Promise<Body>) =>
    inCommandRun(command, async () => {
      const run = await options.open(command, { readOnly })
      let body: Body
      try {
        body = await work(run)
      } finally {
        await run.close?.()
      }
      renderAnswer(command, outputFor(command), body)
    })
  const example = (command: Command, ...lines: string[]) =>
    annotate(command, { examples: lines.map((line) => `${options.app.command} work ${line}`) })
  const paging = (command: Command) =>
    command
      .option("--limit <n>", `rows per page, 1–${MOST}`, integer(MOST), 50)
      .option("--page <n>", "which page, starting at 1", integer(1_000_000), 1)

  const syncOf = (command: Command, opts: SyncOptions) => (run: TrackerRun) => {
    const { signal } = environmentOf(command)
    return syncTracker(run.source(), run.store, run.account, {
      now: now(),
      budget: runBudgetOf(command, opts.maxPages),
      ...(signal ? { signal } : {}),
      ...(opts.rescan ? { rescan: true } : {}),
      ...(opts.allowDeletions ? { allowDeletions: opts.allowDeletions } : {}),
    })
  }
  // A run its budget stopped has no time left for the model; the run that finishes the round embeds.
  const embedOf = async (command: Command, run: TrackerRun, report: TrackerReport): Promise<TrackerReport> => {
    if (report.stopped) return report
    const { signal, env } = environmentOf(command)
    const deadline = environmentOf(command).deadline?.()
    const embeddings = await embedTracker(run.store, {
      maxChunks: EMBED_MAX,
      ...(deadline ? { deadline } : {}),
      ...(signal ? { signal } : {}),
      ...(env ? { env } : {}),
      command: options.app.command,
    })
    return { ...report, embeddings }
  }
  const trackerPart = (command: Command, opts: SyncOptions, opened: (account: AccountKey) => void = () => {}) =>
    inCommandRun(command, async () => {
      const run = await options.open(command, { readOnly: false })
      opened(run.account)
      try {
        return await syncOf(command, opts)(run)
      } finally {
        await run.close?.()
      }
    })
  const { documents } = options
  const sync = example(
    answerEntity(
      annotate(program.command("sync"), { effects: FETCH, offline: false, cooperative: true, partial: true }),
      documents ? "tracker_documents_sync" : "tracker_sync",
      documents ? trackerDocumentsSync : trackerSync,
    ).description(
      "bring the tracker's copy in the local store up to date: teams, users, states, labels, projects, sprints, " +
        "issues and comments that changed since the last sync, or everything with --rescan; once a day it also finds " +
        "what the tracker deleted, and says when it next will. Open issues assigned to you become your tasks, " +
        "and close when the issue is done, canceled, a duplicate, deleted or goes to someone else. " +
        (documents
          ? "It also imports what changed in the chosen document folders, answered under documents; a part that " +
            "fails leaves the other's answer. "
          : "") +
        "A run stops before its deadline or --max-pages and the next one goes on from there",
    ),
    "sync",
    "sync --rescan",
  )
    .option(
      "--rescan",
      documents
        ? "list everything again, issues and documents, dropping a round in progress; a rescan of the documents " +
            "starts their walk over each time, so run it once and continue with a plain sync"
        : "list everything again, every id too, dropping a round in progress",
    )
    .addOption(allowDeletionsOption())
    .option(
      "--max-pages <pages>",
      documents
        ? "at most this many requests for the issues in this run, and as many for the documents"
        : "at most this many requests to the tracker in this run",
      integer(100_000),
    )
  if (!documents)
    sync
      .option(
        "--embed",
        "also index new issues, projects and comments for meaning search, with a model already downloaded",
      )
      .action(async (opts: SyncOptions, command: Command) => {
        await within(command, false, async (run) => {
          const report = await syncOf(command, opts)(run)
          if (!opts.embed) return trackerAnswer(report, opts)
          try {
            return trackerAnswer(await embedOf(command, run, report), opts)
          } catch (error) {
            // What the sync saved is answered; a cancel still ends the command.
            if (environmentOf(command).signal?.aborted) throw error
            return trackerAnswer(report, opts, error)
          }
        })
      })
  else
    sync
      .option(
        "--embed",
        "also index new issues, projects and comments and the documents' pending text for meaning search, with a " +
          "model already downloaded",
      )
      .addOption(
        new Option("--limit <n>", "refused: it would count documents only").hideHelp().argParser(() => {
          throw new InvalidArgumentError(
            "--limit counts documents only, and this sync brings the issues too; --max-pages bounds both parts",
          )
        }),
      )
      .action(async (opts: SyncOptions & { embed?: boolean }, command: Command) => {
        const settled = async <T>(part: () => Promise<T>): Promise<Settled<T>> => {
          try {
            return { value: await part() }
          } catch (error) {
            // A cancel ends the whole command: it is not one part's failure.
            if (environmentOf(command).signal?.aborted) throw error
            return { error }
          }
        }
        let account: AccountKey | undefined
        const tracker = await settled(() => trackerPart(command, opts, (one) => (account = one)))
        const deadline = environmentOf(command).deadline?.()
        const docs = await settled(() =>
          documents(command, {
            budget: runBudgetOf(command, opts.maxPages),
            ...(account ? { account } : {}),
            ...(opts.rescan ? { rescan: true } : {}),
            ...(opts.embed ? { embed: true } : {}),
            ...(deadline ? { deadline } : {}),
          }),
        )
        // A skipped documents part did not run, so a failed tracker part is the whole answer, as without documents.
        if ("error" in tracker && "value" in docs && isSkipped(docs.value.item)) throw tracker.error
        // After both parts, so the documents get their sync's time first; outside the tracker's run, which has ended.
        const embedded =
          opts.embed && "value" in tracker
            ? await settled(async () => {
                const run = await options.open(command, { readOnly: false })
                try {
                  return await embedOf(command, run, tracker.value)
                } finally {
                  await run.close?.()
                }
              })
            : undefined
        if ("error" in tracker && "error" in docs) {
          const failed = errorOf(docs.error)
          // An error envelope has no meta and keeps only the details its reason registers, so the documents'
          // failure is told in the message of the tracker's error, which answers as a tracker-only sync's would.
          throw isCliError(tracker.error)
            ? new CliError(
                tracker.error.code,
                `${tracker.error.message}; the documents failed too ` +
                  `(${failed.reason ?? failed.code}): ${failed.message}`,
                tracker.error.details,
              )
            : tracker.error
        }
        const timeout = command.optsWithGlobals<{ timeout?: string }>().timeout
        const answer = combinedAnswer(
          embedded && "value" in embedded ? embedded : tracker,
          docs,
          { ...opts, ...(timeout === undefined ? {} : { timeout }) },
          embedded && "error" in embedded ? embedded.error : undefined,
        )
        renderAnswer(command, outputFor(command), answer)
        if ("value" in docs) for (const line of docs.value.diagnostics) outputFor(command).streams.diagnostic(line)
      })

  const issues = annotate(program.command("issues"), { effects: NO_EFFECTS }).description(
    "the tracker's issues as last synced: state, team, project, assignee and labels",
  )
  example(
    paging(
      withQuery(
        answerEntity(annotate(issues.command("list"), { effects: LOCAL_READ }), "tracker_issue", trackerView),
        ISSUES_QUERY,
      ).description("issues copied from the tracker, newest change first; run sync to bring them up to date"),
    ),
    "issues list type:started",
    "issues list label:Bug assignee:none --json",
  ).action(async (words: string[], opts: { limit: number; page: number }, command: Command) => {
    const lists = nativeTermLists(listQuery(typedQuery(words), ISSUES_QUERY, "issues list"), "issues list", ["type"])
    if ([...lists.values()].flat().some((one) => one.operator !== "term" && one.operator !== "phrase"))
      throw new InvalidArgumentError("issues list takes field:value terms, each one whole value")
    const types = (lists.get("type") ?? []).map((one) => one.value.toLowerCase() as StateType)
    const terms = new Map(
      [...lists].filter(([field]) => field !== "type").map(([field, [one]]) => [field, one?.value as string]),
    )
    await within(command, true, async (run) => {
      const TEAMED = new Set<TrackerNamed>(["state", "label", "sprint"])
      // A name every team's state or sprint has matches each of them; only the team itself must be one row.
      const rowsOf = async (field: string, kind: TrackerNamed, team?: string): Promise<TrackerItem[] | undefined> => {
        const given = terms.get(field)
        if (given === undefined) return undefined
        const scoped = team !== undefined && TEAMED.has(kind) ? " for that team" : ""
        const found = await trackerMatches(run, kind, given, team)
        if (found.length) return found
        throw await unknownTrackerReference(run, kind, given, `${field}:`, {
          ...(team === undefined ? {} : { team }),
          scoped,
        })
      }
      const idsOf = async (field: string, kind: TrackerNamed, team?: string) =>
        (await rowsOf(field, kind, team))?.map(({ record }) => record.externalId)
      const teams = await rowsOf("team", "team")
      if (teams && teams.length > 1)
        throw ambiguousTrackerReference(
          "team",
          terms.get("team") as string,
          teams.map(({ record }) => record as TrackerRecords["team"]),
          "team:",
        )
      const team = teams?.[0]?.record.externalId
      const noneOr = async (field: string, kind: TrackerNamed) =>
        terms.get(field)?.toLowerCase() === "none" ? null : await idsOf(field, kind, team)
      const project = await idsOf("project", "project")
      const assignee = await noneOr("assignee", "user")
      const state = await idsOf("state", "state", team)
      const label = await idsOf("label", "label", team)
      const sprint = await noneOr("sprint", "sprint")
      const filter: TrackerFilter = {
        ...(team !== undefined ? { parent: team } : {}),
        ...(project ? { project } : {}),
        ...(assignee !== undefined ? { assignee } : {}),
        ...(state ? { state } : {}),
        ...(types.length ? { stateTypes: types } : {}),
        ...(label ? { label } : {}),
        ...(sprint !== undefined ? { sprint } : {}),
        ...(terms.has("archived") ? { archived: true } : {}),
        limit: opts.limit,
        offset: (opts.page - 1) * opts.limit,
      }
      const found = await run.store.tracker.list(run.account, "issue", filter)
      return listOf("issues list", {
        items: await withNames(run, found.items),
        limit: opts.limit,
        page: opts.page,
        has_more: found.hasMore,
        ...(words.length ? { args: { query: words } } : {}),
      })
    })
  })
  example(
    answerEntity(annotate(issues.command("show"), { effects: LOCAL_READ }), "tracker_issue_detail", trackerView)
      .description("one issue with its state, assignee and comments")
      .argument("<issue>", "the issue's key (ENG-12) or id"),
    "issues show ENG-12",
  ).action(async (reference: string, _opts: unknown, command: Command) => {
    await within(command, true, async (run) => {
      const found = await issueOf(run, reference)
      const [issue] = await withNames(run, [found])
      const comments = await run.store.tracker.list(run.account, "comment", {
        parent: found.record.externalId,
        limit: MOST,
      })
      return itemOf(
        { ...issue, comments: comments.items.map((one) => viewOf(one)) },
        comments.hasMore ? { meta: { complete: false } } : {},
      )
    })
  })
  example(
    paging(
      answerEntity(annotate(issues.command("search"), { effects: LOCAL_READ }), "tracker_hit", trackerView)
        .description(
          "find issues, projects and comments in the copy by their words, and by meaning once sync --embed built " +
            "their vectors",
        )
        .argument(
          "<words...>",
          'every word must match, in any form and any order; a word of four letters or more finds the words it begins; "a phrase" in quote marks inside the query keeps its words together; a question finds what holds some of its words',
        ),
    ),
    "issues search invoice currency",
    'issues search "why do refunds round wrong?"',
  ).action(async (words: string[], opts: { limit: number; page: number }, command: Command) => {
    const { env } = environmentOf(command)
    const download = commandAt(rootOf(command), "models download") !== undefined
    await within(command, true, async (run) => {
      const found = await searchTracker(run.store, {
        text: words.join(" "),
        accounts: [run.account],
        limit: opts.limit,
        offset: (opts.page - 1) * opts.limit,
        now: now(),
        ...(download ? { command: options.app.command } : {}),
        ...(env ? { env } : {}),
      })
      const noVectors = found.meaningReason === "tracker.no-vectors"
      const why =
        found.meaningSkipped === undefined
          ? undefined
          : `found by words only: ${found.meaningSkipped}` +
            (noVectors ? `; \`${lineOf(command, "sync --embed")}\` builds the vectors that find them by meaning` : "")
      if (why) outputFor(command).renderer.note(why)
      const next: NextStep[] = noVectors
        ? [resumeStep({ embed: true }, "builds the vectors that find issues, projects and comments by meaning")]
        : download && found.meaningReason === "model.not-downloaded"
          ? [nextStep("models.download", { args: { model: chosenTextModel(env).id } })]
          : []
      return listOf("issues search", {
        items: found.items.map(({ hit, item }) => viewOf(item, { excerpt: hit.text, found_by: hit.foundBy })),
        limit: opts.limit,
        page: opts.page,
        has_more: found.hasMore,
        args: { words },
        ...(why ? { missing: [{ field: "found_by", why }] } : {}),
        ...(next.length ? { next } : {}),
      })
    })
  })
  example(
    answerEntity(annotate(issues.command("assign"), { effects: LOCAL_WRITE }), "tracker_issue_task", trackerTask)
      .description(
        "make an issue the owner's task, whoever it is assigned to: the task points at the issue and shows its key and " +
          "title, which each sync keeps current; the same issue again answers its existing task",
      )
      .argument("<issue>", "the issue's key (ENG-12) or id")
      .option(
        "--due <time>",
        "when it is due: an ISO 8601 time, a day, today, or 3d from now",
        (typed: string) => new Date(aheadOf(typed, "--due", Date.now(), { end: true })),
      ),
    "issues assign ENG-12 --due 2026-12-01",
  ).action(async (reference: string, opts: { due?: Date }, command: Command) => {
    await within(command, false, async (run) => {
      const { task, created } = await trackerIssueTask(run.store, run.account, reference, {
        now: now(),
        ...(opts.due ? { dueAt: opts.due } : {}),
      })
      return itemOf({ task_id: task.id, ...(task.key ? { key: task.key } : {}), issue: task.source, created })
    })
  })

  if (options.writes?.length)
    addTrackerWriteCommands(issues, {
      writes: options.writes,
      within,
      example,
      view: async (run, item) =>
        item.kind === "issue" ? ((await withNames(run, [item as TrackerItem<"issue">]))[0] as never) : viewOf(item),
      answer: trackerWrite,
      now,
    })

  for (const [kind, plural, what] of [
    ["project", "projects", "the tracker's projects: status, lead, teams and target date"],
    ["sprint", "sprints", "each team's sprints (Linear's cycles): number, start, end and when completed"],
    ["team", "teams", "the tracker's teams"],
    ["user", "users", "the tracker's users, each with the person the store knows by the same e-mail"],
    ["state", "states", "each team's workflow states and their type"],
    ["label", "labels", "the tracker's labels"],
  ] as const) {
    const group = annotate(program.command(plural), { effects: NO_EFFECTS }).description(what)
    const query = listQueryOf(kind)
    example(
      paging(
        withQuery(
          answerEntity(annotate(group.command("list"), { effects: LOCAL_READ }), `tracker_${kind}`, trackerView),
          query,
        ).description(`${plural} copied from the tracker, newest change first`),
      ),
      `${plural} list`,
      `${plural} list archived:include`,
    ).action(async (words: string[], opts: { limit: number; page: number }, command: Command) => {
      const terms = queryTerms(words, query, `${plural} list`)
      await within(command, true, async (run) => {
        const found = await run.store.tracker.list(run.account, kind, {
          limit: opts.limit,
          offset: (opts.page - 1) * opts.limit,
          ...(terms.has("archived") ? { archived: true } : {}),
        })
        const people =
          kind === "user"
            ? new Map(
                (
                  await run.store.tracker.people(
                    run.account,
                    found.items.map((one) => one.record.externalId),
                  )
                ).map((one) => [one.user, one.person]),
              )
            : new Map<string, string>()
        return listOf(`${plural} list`, {
          items: found.items.map((one) =>
            viewOf(one, people.has(one.record.externalId) ? { person: people.get(one.record.externalId) } : {}),
          ),
          limit: opts.limit,
          page: opts.page,
          has_more: found.hasMore,
          ...(words.length ? { args: { query: words } } : {}),
        })
      })
    })
  }
}

/**
 * The tracker's commands: `sync`, `issues list|show|search|assign`, `issues create|update` and
 * `issues comments create` for the writes in `writes`, and a `list` of each other kind.
 */
export const addTrackerCommands = honoursDryRun(sharedCommand(addTrackerCommandsDefinition))
