import { CliError } from "@wirecat/cli-base"
import { annotate, annotateOption } from "@wirecat/cli-base/commands"
import type { NextStep } from "@wirecat/cli-base/standards"
import { Command, Option } from "commander"
import { parseDuration } from "../../domain/duration.js"
import { FETCHING } from "../../services/archive.js"
import type { Services } from "../../services/index.js"
import type { ProjectChatFetcher } from "../../services/project-gathering.js"
import { BUILT_IN_PURPOSES, purposeList } from "../../services/project-purposes.js"
import { projectStatus, STATUS_SIGNALS } from "../../services/project-status/index.js"
import { gatherStoredProject } from "../../services/stored-project-gathering.js"
import type { AccountKey, MessageStore } from "../../store/store.js"
import { answerEntity } from "../answer-entity.js"
import { FETCH, LOCAL_READ } from "../effects.js"
import { itemOf, renderAnswer, snakeKeys } from "../envelope.js"
import { positiveCount } from "../paging.js"
import {
  projectAnswerParts,
  projectCutoffTime,
  projectEvidenceText,
  projectWindowOf,
  withSyncCommands,
} from "../project-evidence.js"
import { projectStatusAnswer, projectStatusRow, projectStatusSchema, projectStatusText } from "../project-status.js"
import { lineOf, nextStep, rootOf, stepLine } from "../steps.js"
import { type Messenger, messengerContext } from "./context.js"

const collect = (value: string, previous: string[]) => [...previous, value]
const upTo = (most: number, flag: string) => (value: string) => {
  const n = Number(value)
  if (!/^\d+$/.test(value) || n > most)
    throw new CliError("validation_error", `${flag} takes a whole number from 0 to ${most}`)
  return n
}

/** More than any chat one fetch budget can bring; the budget, not the count, ends a long chat. */
const FETCH_LIMIT = 1_000_000

/** This profile's account, the only one its connection can sync. */
const sourcesOf = async (store: MessageStore, account: AccountKey) => {
  const stored = (await store.accounts.storedAccounts()).find(
    (one) => one.provider === account.provider && one.account === account.account,
  )
  if (!stored)
    throw new CliError("not_found", "the store holds nothing of this profile's account yet; sync a chat first", {
      param: "profile",
    })
  return {
    sources: [{ kind: "message" as const, accountId: stored.id, provider: stored.provider, account: stored.account }],
    unread: [],
    scope: "explicit" as const,
  }
}

/**
 * `archive.fetch` back to the window start, one linked chat at a time. Only this profile's account is a source, so
 * the gathering never asks for another account's chat.
 */
const archiveFetcher = (
  withServices: <T>(work: (services: Services) => Promise<T>) => Promise<T>,
  messenger: Messenger,
): ProjectChatFetcher => {
  const fetching = messenger.fetching ?? FETCHING
  return {
    fetch: async ({ chatId, after, signal, onProgress }) => {
      const result = await withServices((services) =>
        services.archive.fetch(chatId, {
          limit: FETCH_LIMIT,
          pageSize: fetching.page,
          pauseMs: parseDuration(fetching.pause, "pause"),
          sinceMs: after,
          catchUp: false,
          note: () => {},
          stop: signal,
          onPage: ({ fetched, oldest }) => onProgress?.({ fetched, oldest }),
        }),
      )
      if (result.issue) return { state: "partial", reason: result.issue.code }
      if (result.stopped) return { state: "partial", reason: "fetch-budget" }
      return result.complete || result.reachedSince ? { state: "complete" } : { state: "partial", reason: "limit" }
    },
  }
}

interface Options {
  purposes: string[]
  purpose?: string[]
  includeProposed?: boolean
  alias: string[]
  contextQuery: string[]
  contact: string[]
  sinceTime: string
  beforeTime?: string
  limit?: number
  maxPages?: number
  cursor?: string
  catchUp: boolean
  beforeN: number
  afterN: number
  syncFirst?: boolean
  syncTime: string
}

/** The purposes asked: `--purposes`, and the hidden `--purpose` it replaced, kept for one version. */
const purposesAsked = (options: { purposes: string[]; purpose?: string[] }) => [
  ...options.purposes,
  ...(options.purpose ?? []),
]

const oldPurpose = () =>
  new Option("--purpose <purposes>", "replaced by --purposes; kept for one version").argParser(purposeList).hideHelp()

const purposeHelp = (messenger: Messenger) =>
  `the linked chats' purposes to read, comma separated (${(messenger.purposes?.purposes ?? BUILT_IN_PURPOSES).join(", ")}), ` +
  "or all; the configured defaults if not given, and a chat left out is counted, never dropped silently"

/** Off MCP: a tool call ends at about a minute, too soon for a sync, which would fail the whole answer. */
const cliOnly = (flags: string, description: string, value?: string) => {
  const option = new Option(flags, description)
  if (value !== undefined) option.default(value)
  return annotateOption(option, { mcp: false })
}

export const projectsCommand = (messenger: Messenger): Command => {
  const projects = new Command("projects").description("what the store holds about the owner's projects")
  const app = messenger.app.command
  projects.addCommand(
    annotate(new Command("evidence"), {
      output: { entity: "project_evidence" },
      examples: [`${app} personal projects evidence "Harbour" --since-time 30d --sync-first`],
      // Declared as a fetch for --sync-first; without it nothing leaves this machine, and a fetch is never a write elsewhere.
      effects: FETCH,
      cooperative: true,
      partial: true,
    })
      .summary("what this account's stored messages hold about a project, linked chats included")
      .description(
        "cited references about a project in this profile's stored messages. The project's name, key, each alias and " +
          "each --alias, --context-query and --contact name is its own search; their hits are joined. Every message of " +
          "a chat confirmed as the project's is read too, and so is what a confirmed person member wrote. Reads what the " +
          "store holds; with --sync-first it first syncs the project's linked chats the store does not hold for the window",
      )
      .argument("<project>", "an existing project's id, key, exact name or alias, or a new project's name")
      .option("--alias <name>", "another name of the project, searched on its own; repeat for more", collect, [])
      .option("--context-query <words>", "more words that all appear in one text; repeat for another", collect, [])
      .option("--contact <person>", "a name to search, or person:<id> to read what that person wrote", collect, [])
      .option("--purposes <purposes>", purposeHelp(messenger), purposeList, [])
      .addOption(oldPurpose())
      .option(
        "--include-proposed",
        "also read chats and members proposed for the project and not yet confirmed; each item they bring is marked",
      )
      .option("--since-time <time>", "how far back: days (90d, at most 730d) or a start date (2026-09-01)", "60d")
      .option("--before-time <time>", "fixed exclusive end: ISO 8601 timestamp with UTC offset")
      .option("--limit <n>", "new references at most, up to 500; 100 if not given", positiveCount("--limit"))
      .option("--max-pages <pages>", "store pages read at most this run, up to 512", positiveCount("--max-pages"))
      .option("--cursor <cursor>", "continue a stopped search from its checkpoint, with the same options")
      .option("--before-n <n>", "messages before each message hit, at most 5", upTo(5, "--before-n"), 2)
      .option("--after-n <n>", "messages after each message hit, at most 5", upTo(5, "--after-n"), 2)
      .option("--no-catch-up", "read the search index as it is, without indexing new text first")
      .addOption(
        cliOnly(
          "--sync-first",
          "first sync the linked chats this account does not hold back to --since-time; off by default",
        ),
      )
      .addOption(
        cliOnly("--sync-time <duration>", "time for all of --sync-first's syncs together; 3m if not given", "3m"),
      )
      .action(async function (this: Command, project: string) {
        const options = this.opts<Options>()
        const context = messengerContext(this, messenger)
        const maxFetchMs = parseDuration(options.syncTime, "--sync-time")
        const gather = (store: MessageStore, account: AccountKey, fetcher?: ProjectChatFetcher) =>
          sourcesOf(store, account).then((sources) =>
            gatherStoredProject(store, {
              project,
              sources,
              ...projectWindowOf(options.sinceTime),
              ...(options.beforeTime === undefined ? {} : { asOf: projectCutoffTime(options.beforeTime) }),
              limit: options.limit ?? 100,
              catchUp: options.catchUp,
              beforeN: options.beforeN,
              afterN: options.afterN,
              ...(options.alias.length ? { aliases: options.alias } : {}),
              ...(options.contextQuery.length ? { keywords: options.contextQuery } : {}),
              ...(options.contact.length ? { people: options.contact } : {}),
              ...(options.maxPages === undefined ? {} : { maxReads: options.maxPages }),
              ...(options.cursor === undefined ? {} : { checkpoint: options.cursor }),
              ...(purposesAsked(options).length ? { purposes: purposesAsked(options) } : {}),
              ...(messenger.purposes ? { purposeConfig: messenger.purposes } : {}),
              ...(options.includeProposed ? { includeProposed: true } : {}),
              ...(fetcher ? { fetcher, maxFetchMs, onFetchProgress: progressNote(context.renderer.note) } : {}),
            }),
          )
        const fetcher = options.syncFirst
          ? archiveFetcher((work) => context.withServices(work, { name: "projects evidence fetch" }), messenger)
          : undefined
        let profile: AccountKey | undefined
        const found = await context.withStore((store, account) => {
          profile = account
          return gather(store, account, fetcher)
        })
        const root = rootOf(this)
        const hints = {
          sync: (one: { provider: string }, since: string) =>
            one.provider === messenger.provider
              ? lineOf(this, `projects evidence ${quote(project)} --since-time ${since} --sync-first`)
              : null,
          read: (one: { provider: string; account: string; chat: string }, since: string) =>
            one.provider === profile?.provider && one.account === profile.account
              ? lineOf(this, wordsOf(root, readStep(one.chat, since) as Extract<NextStep, { kind: "command" }>))
              : null,
          showDocument: "the notes app that imported it",
        }
        const parts = projectAnswerParts(options.sinceTime, found, hints)
        renderAnswer(this, context, itemOf(snakeKeys(withSyncCommands(found, hints.sync, hints.read)), parts), () =>
          projectEvidenceText(found, hints),
        )
      }),
  )
  projects.addCommand(statusCommand(messenger))
  return projects
}

/** Where a project stands from this profile's stored messages: no model call, nothing leaves the machine. */
const statusCommand = (messenger: Messenger): Command =>
  answerEntity(
    annotate(new Command("status"), {
      examples: [`${messenger.app.command} personal projects status HRB --context-query 1C`],
      effects: LOCAL_READ,
      partial: true,
    })
      .summary("where a project stands in this account's linked chats: whose move, open asks, money")
      .description(
        "per chat confirmed as the project's (and its child projects'), from what the store holds: the last message, " +
          "who replies next, open questions both ways, promises, amounts with their direction, payments recorded, " +
          "how long each --context-query has been quiet on their side, and how much of the chat is held. Amounts, " +
          "directions and promises found by words are marked pattern: read the cited message before trusting one. " +
          "Others' questions in a group with no role, and others' word-found promises in a group, are counted on " +
          "the chat's row as unlisted, not listed. " +
          "Only this profile's account is read; the other linked chats are named, and memo projects status reads them",
      )
      .argument("<project>", "an existing project's id, key, exact name or alias")
      .option("--since-time <time>", "how far back: days (60d, at most 730d) or a start date (2026-09-01)", "60d")
      .option("--before-time <time>", "fixed exclusive end: ISO 8601 timestamp with UTC offset")
      .option("--purposes <purposes>", purposeHelp(messenger), purposeList, [])
      .addOption(oldPurpose())
      .option(
        "--context-query <words>",
        "words that all appear in one text; reports their last mention per side. Repeat for another",
        collect,
        [],
      )
      .action(async function (this: Command, project: string) {
        const options = this.opts<{
          sinceTime: string
          beforeTime?: string
          contextQuery: string[]
          purposes: string[]
          purpose?: string[]
        }>()
        const context = messengerContext(this, messenger)
        let profile: AccountKey | undefined
        const found = await context.withStore((store, account) => {
          profile = account
          return projectStatus(store, {
            project,
            accounts: [account],
            ...projectWindowOf(options.sinceTime),
            ...(options.beforeTime === undefined ? {} : { asOf: projectCutoffTime(options.beforeTime) }),
            contextQueries: options.contextQuery,
            ...(purposesAsked(options).length ? { purposes: purposesAsked(options) } : {}),
            ...(messenger.purposes ? { purposeConfig: messenger.purposes } : {}),
          })
        })
        const root = rootOf(this)
        const hints = {
          sync: (chat: { chatId: string }, since: string) =>
            nextStep("messages.sync", { args: { chat: chat.chatId, since_time: since } }),
          read: (chat: { chatId: string }, since: string) => readStep(chat.chatId, since),
          readChat: (chat: { account: AccountKey; chatId: string }, since: string) =>
            chat.account.provider === profile?.provider && chat.account.account === profile.account
              ? readStep(chat.chatId, since)
              : null,
          line: (step: NextStep) => (step.kind === "command" ? lineOf(this, wordsOf(root, step)) : step.why),
        }
        const { item, ...parts } = projectStatusAnswer(found, hints)
        renderAnswer(this, context, itemOf(item, parts), () => projectStatusText(found, hints))
      }),
    "project_status",
    projectStatusSchema,
    { row: projectStatusRow(STATUS_SIGNALS) },
  )

const readStep = (chat: string, since: string) => nextStep("messages.list", { args: { chat, query: `date>=${since}` } })

/** A step's words after the tool and the profile, so `lineOf` names the profile the run used. */
const wordsOf = (root: Command, step: Extract<NextStep, { kind: "command" }>) => {
  const profile: unknown = root.getOptionValue("profile")
  const typed = typeof profile === "string" && profile !== "" ? 2 : 1
  return stepLine(root, step).split(" ").slice(typed).join(" ")
}

const quote = (text: string) => (/^[\w:.-]+$/.test(text) ? text : `"${text.replace(/(["\\$`])/g, "\\$1")}"`)

/** A line per saved page, counts only; a timed heartbeat with titles is the sync-progress work's (cli-core#2121). */
const progressNote =
  (note: (text: string) => void) =>
  ({ chat, index, of, fetched }: { chat: string; index: number; of: number; fetched: number }) =>
    note(`chat ${index + 1} of ${of} · ${chat} · ${fetched} messages so far`)
