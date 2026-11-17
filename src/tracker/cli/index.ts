import { annotate, sharedCommand } from "@wirecat/cli-base/commands"
import type { QueryRegistry } from "@wirecat/cli-base/query"
import type { NextStep } from "@wirecat/cli-base/standards"
import { type Command, InvalidArgumentError } from "commander"
import * as v from "valibot"
import { answerEntity } from "../../cli/answer-entity.js"
import { environmentOf, inCommandRun, outputFor, runBudgetOf } from "../../cli/context.js"
import { honoursDryRun } from "../../cli/dry-run-guard.js"
import { FETCH, LOCAL_READ, LOCAL_WRITE, NO_EFFECTS } from "../../cli/effects.js"
import { type Body, itemOf, listOf, renderAnswer } from "../../cli/envelope.js"
import { queryTerms, termField, withQuery } from "../../cli/list-query.js"
import {
  STATE_TYPES,
  type StateType,
  TRACKER_KINDS,
  type TrackerKind,
  type TrackerRecords,
} from "../../domain/tracker.js"
import { count, text } from "../../entities/fields.js"
import type { AppIdentity } from "../../ports/app.js"
import type { TrackerFilter, TrackerItem } from "../../store/sqlite/tracker.js"
import type { MessageStore } from "../../store/store.js"
import type { AccountKey } from "../../store/types.js"
import type { TrackerSource } from "../source.js"
import { syncTracker } from "../sync.js"
import { trackerIssueTask } from "../tasks.js"

/** The selected profile's tracker account, opened for one command and closed before its answer is printed. */
export interface TrackerRun {
  account: AccountKey
  store: MessageStore
  /** The tracker, built on first use: a command that only reads the store never reads the sign-in. */
  source: () => TrackerSource
  close?: () => Promise<void>
}

export interface TrackerCommandOptions {
  /** The CLI itself: the first word of examples. */
  app: AppIdentity
  /** Opens the selected profile for one command; `readOnly` when the command only reads the store. */
  open: (command: Command, access: { readOnly: boolean }) => Promise<TrackerRun>
  now?: () => number
}

const MOST = 500

const integer = (most: number) => (value: string) => {
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < 1 || number > most)
    throw new InvalidArgumentError(`a whole number from 1 to ${most}`)
  return number
}

/** A due time as the vocabulary's `<time>`: a day, or a moment in ISO 8601. */
const dueTime = (value: string) => {
  const at = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00Z` : value)
  if (Number.isNaN(at)) throw new InvalidArgumentError("a day as YYYY-MM-DD, or a time in ISO 8601")
  return new Date(at)
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

/** What `issues list` narrows by: each by the tracker's id, as `issues show` and the lists name them. */
const ISSUES_QUERY = {
  entity: "tracker_issue",
  backend: "native",
  fields: [
    termField("team", "kw", "team:team-1", { relation: "the team's id, as teams list shows it" }),
    termField("project", "kw", "project:project-1", { relation: "the project's id, as projects list shows it" }),
    termField("assignee", "kw", "assignee:none", { relation: "the user's id, as users list shows it, or none" }),
    termField("state", "kw", "state:state-1", { relation: "the state's id, as states list shows it" }),
    termField("type", "enum", "type:started", { values: [...STATE_TYPES] }),
    termField("label", "kw", "label:label-1", { relation: "the label's id, as labels list shows it" }),
    ARCHIVED,
  ],
} as const satisfies QueryRegistry

const TIMES = new Set(["createdAt", "updatedAt", "archivedAt", "completedAt", "canceledAt"])

const snake = (name: string) => name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)

/** A tracker's text is someone else's: an agent reads these fields as data, never as instructions. */
const UNTRUSTED: Record<TrackerKind, string[]> = {
  team: ["name"],
  user: ["name"],
  state: ["name"],
  label: ["name"],
  project: ["name", "description", "status"],
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
    return viewOf(item, {
      ...(state ? { state_name: state.name, state_type: state.type } : {}),
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

  example(
    answerEntity(
      annotate(program.command("sync"), { effects: FETCH, offline: false, cooperative: true, partial: true }),
      "tracker_sync",
      trackerSync,
    ).description(
      "bring the tracker's copy in the local store up to date: teams, users, states, labels, projects, issues and " +
        "comments that changed since the last sync, or everything with --rescan; once a day it also finds what the " +
        "tracker deleted. A run stops before its deadline or --max-pages and the next one goes on from there",
    ),
    "sync",
    "sync --rescan",
  )
    .option("--rescan", "list everything again, every id too, dropping a round in progress")
    .option("--max-pages <pages>", "at most this many requests to the tracker in this run", integer(100_000))
    .action(async (opts: { maxPages?: number; rescan?: boolean }, command: Command) => {
      const { signal } = environmentOf(command)
      await within(command, false, async (run) => {
        const report = await syncTracker(run.source(), run.store, run.account, {
          now: now(),
          budget: runBudgetOf(command, opts.maxPages),
          ...(signal ? { signal } : {}),
          ...(opts.rescan ? { rescan: true } : {}),
        })
        const failed = report.synced.filter((one) => one.error !== undefined)
        const next: NextStep[] | undefined =
          report.state === "partial" && report.progress.steps > 0
            ? [
                {
                  kind: "command",
                  step: "tracker.sync",
                  command: "sync",
                  args: opts.maxPages === undefined ? {} : { max_pages: opts.maxPages },
                  why: failed.length
                    ? "a kind failed to sync; running sync again retries it"
                    : "the sync stopped before its end; running it again goes on from there",
                  safe_to_auto_execute: true,
                },
              ]
            : undefined
        const issues = [
          ...failed.map((one) => ({
            code: "provider_error" as const,
            reason: "sync.partial",
            source: `tracker:${one.kind}`,
          })),
          ...report.synced
            .filter((one) => one.pass === "held")
            .map((one) => ({
              code: "validation_error" as const,
              reason: "tracker.unlisted-held",
              source: `tracker:${one.kind}`,
            })),
        ]
        return itemOf(report, {
          ...(report.state === "partial" || issues.length
            ? { meta: { complete: false, ...(issues.length ? { issues } : {}) } }
            : {}),
          ...(next ? { next } : {}),
        })
      })
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
    "issues list assignee:none --json",
  ).action(async (words: string[], opts: { limit: number; page: number }, command: Command) => {
    const terms = queryTerms(words, ISSUES_QUERY, "issues list")
    const assignee = terms.get("assignee")
    await within(command, true, async (run) => {
      const filter: TrackerFilter = {
        ...(terms.has("team") ? { parent: terms.get("team") as string } : {}),
        ...(terms.has("project") ? { project: terms.get("project") as string } : {}),
        ...(assignee !== undefined ? { assignee: assignee === "none" ? null : assignee } : {}),
        ...(terms.has("state") ? { state: terms.get("state") as string } : {}),
        ...(terms.has("type") ? { stateTypes: [terms.get("type") as StateType] } : {}),
        ...(terms.has("label") ? { label: terms.get("label") as string } : {}),
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
        .description("find issues, projects and comments in the copy by their words")
        .argument("<words...>", "every word must match; prefixes of three letters or more match too"),
    ),
    'issues search "invoice currency"',
  ).action(async (words: string[], opts: { limit: number; page: number }, command: Command) => {
    await within(command, true, async (run) => {
      const found = await run.store.tracker.find({
        words,
        accounts: [run.account],
        kinds: ["issue", "project", "comment"],
        limit: opts.limit,
        offset: (opts.page - 1) * opts.limit,
      })
      return listOf("issues search", {
        items: found.items.map((hit) => viewOf(hit.item, { excerpt: hit.excerpt })),
        limit: opts.limit,
        page: opts.page,
        has_more: found.hasMore,
        args: { words },
      })
    })
  })
  example(
    answerEntity(annotate(issues.command("assign"), { effects: LOCAL_WRITE }), "tracker_issue_task", trackerTask)
      .description(
        "make an issue the owner's task: the task points at the issue and copies none of its text; the same issue " +
          "again answers its existing task",
      )
      .argument("<issue>", "the issue's key (ENG-12) or id")
      .option("--due <time>", "when it is due: a day as YYYY-MM-DD, or a time in ISO 8601", dueTime),
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

  for (const [kind, plural, what] of [
    ["project", "projects", "the tracker's projects: status, lead, teams and target date"],
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

/** The tracker's commands: `sync`, `issues list|show|search|assign`, and a `list` of each other kind. */
export const addTrackerCommands = honoursDryRun(sharedCommand(addTrackerCommandsDefinition))
