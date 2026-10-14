import { CliError } from "@wirecat/cli-base"
import { annotate } from "@wirecat/cli-base/commands"
import { Command } from "commander"
import { parseLocator } from "../../domain/locator.js"
import { SAVE_HELP } from "../../meetings/index.js"
import { renderMessages } from "../../render/messages.js"
import { renderThreadLinks } from "../../render/thread-context.js"
import type { SearchFound } from "../../services/messages.js"
import { NO_MAIL, type SearchKind } from "../../services/search-kind.js"
import { environmentOf } from "../context.js"
import { renderAnswer } from "../envelope.js"
import { positiveCount } from "../paging.js"
import { archiveSummary } from "./archive-summary.js"
import { type Messenger, messengerContext } from "./context.js"
import { messagesAnswer, offsetOf } from "./search-answers.js"
import { backendOptions, backendRequest, noteServer } from "./search-backend-options.js"
import { syncOptions, syncRequest } from "./search-sync-options.js"
import { threadOptions, threadRequest } from "./thread-options.js"

const PLACES = { transcript: "transcript", filename: "file name", file: "file text" } as const

/** `search messages`, or with `mail` the same leaf over the mailboxes only — never both, so they do not overlap. */
export const messagesSearchCommand = (messenger: Messenger, kind: SearchKind = "messages"): Command => {
  const mail = kind === "mail"
  const base = new Command(kind)
  const command = annotate(mail ? base : backendOptions(threadOptions(syncOptions(base)), messenger), {
    output: { entity: "message", view: "hit" },
  })
  command
    .description(
      mail
        ? "search the mail imported into the local store — memo sync --mail brings it in"
        : messenger.serverSearch
          ? "search messenger messages in the local store and on the messenger's server (--backend); optionally fetches new messages with --sync-first; --discover searches the archive only"
          : "search messenger messages in the local store — what was read, fetched or kept by serve; optionally fetches new messages with --sync-first; --discover searches the archive only",
    )
    .argument(
      "[query...]",
      mail
        ? 'strict Lucene query: words, "phrases", AND/OR/NOT, field groups and date ranges'
        : 'strict Lucene query: words, "phrases", AND/OR/NOT, field groups and date ranges; --language legacy keeps discovery; with --saved, more words AND-ed to it',
    )
  if (mail)
    command.option(
      "--source <accounts>",
      "only these mail accounts, separated by commas: email:<address> as a hit shows it, email, mail or " +
        "group:<name>; every mail account when unset",
    )
  else
    command.option(
      "--source <accounts>",
      "every account of this messenger held in the store; personal, bots or all — the same as in: in the query; " +
        "or a list: group:work,telegram:Alice,email:me@example.com",
    )
  command
    .option("--limit <n>", "how many", positiveCount("--limit"))
    .option("--page <n>", "which page, starting at 1", positiveCount("--page"))
    .option("--newest", "newest first instead of best first")
    .option(
      "--exact",
      "bare words and quotes match their exact form only, as exact:word does; text: still matches every form",
    )
    .option("--context <n>", "messages before and after each hit; 2 in the terminal, 0 otherwise", wholeCount)
  if (!mail) {
    command.option(
      "--discover",
      "find partial lexical matches and eligible replies in the local archive; results are evidence, not confirmed answers",
    )
    command.option("--language <lucene|legacy>", "the query language: strict Lucene or legacy discovery", languageOf)
  }
  command.option("--timezone <zone>", "the IANA timezone for calendar date boundaries")
  command.addHelpText("after", SAVE_HELP)
  if (mail)
    return command
      .addHelpText(
        "after",
        `chat: narrows it to one mail thread, by id or subject; content: to the text of attachments, filename: to their
names — \`${messenger.app.command} search mail 'content:invoice'\`. --json: the list is items; each email's reference is ref.`,
      )
      .action(searchAction(messenger, kind))
  return command
    .addHelpText(
      "after",
      `Search reads the local archive: a chat never fetched is not searched. Prepare it once with
\`${messenger.app.command} messages sync --all --background\` (the last 90 days of every chat); the answer's
coverage says what was searched and coverage.next what would improve it. Mail is \`${messenger.app.command} search mail\`;
everything at once is \`${messenger.app.command} search all\`.
A bare word looks in message text, voice transcripts, file names and file text. text:, transcript:,
content: (the text of files) and filename: (their names) narrow it to one —
\`${messenger.app.command} search messages 'content:invoice'\`. chat: narrows it to one chat; has:voice, has:file and
NOT has:attachment to voice messages, files or text alone. --json: the list is items; each hit's reference is ref.
Search guide: https://github.com/WireCatLabs/cli-core/blob/main/docs/search/query-language.md`,
    )
    .option("--regex", "the words are one regular expression, case-insensitive, tested against every stored text")
    .option("--saved <name|id>", "run a saved search or an earlier run; options typed here replace its own")
    .action(searchAction(messenger, kind))
}

const searchAction = (messenger: Messenger, kind: SearchKind) =>
  async function (this: Command, given: string[]) {
    const context = messengerContext(this, messenger)
    const words = given
    const {
      source,
      regex,
      language,
      discover,
      timezone,
      newest,
      exact,
      context: around,
      limit: typedLimit,
      page,
      saved,
    } = this.opts<{
      source?: string
      regex?: boolean
      discover?: boolean
      language?: "lucene" | "legacy"
      timezone?: string
      newest?: boolean
      exact?: boolean
      context?: number
      limit?: number
      page?: number
      saved?: string
    }>()
    if (saved === undefined && words.length === 0)
      throw new CliError("validation_error", "give a query, or --saved <name> to run a saved search")
    if (saved !== undefined && regex)
      throw new CliError("validation_error", "--regex is kept with the saved search; not with --saved")
    const controller = new AbortController()
    context.track({ close: async () => controller.abort() })
    const external = environmentOf(this).signal
    const signal = external ? AbortSignal.any([external, controller.signal]) : controller.signal
    const typed = {
      ...(source === undefined ? {} : { source }),
      ...(discover === undefined ? {} : { discover }),
      ...(language === undefined ? {} : { language }),
      ...(timezone === undefined ? {} : { timezone }),
      ...(newest ? { newest: true } : {}),
      ...(exact ? { exact: true } : {}),
      ...(around === undefined ? {} : { context: around }),
      ...(typedLimit === undefined ? {} : { limit: typedLimit }),
    }
    let limit = context.settings.limit
    const found: SearchFound = await context
      .withServices(async (services) => {
        if (saved === undefined) {
          const pattern = regex ? patternOf(words.join(" ")) : undefined
          return services.messages.search({
            kind,
            ...syncRequest(this, context),
            ...backendRequest(this),
            ...threadRequest(this),
            ...typed,
            ...(pattern ? { pattern } : { text: words.join(" ") }),
            limit,
            ...withOffset(page, limit),
            signal,
            language: language ?? (pattern ? "legacy" : "lucene"),
            newest: newest === true,
            context: around ?? (context.format === "pretty" ? 2 : 0),
          })
        }
        const { id, params, pattern } = await services.searches.resolve(saved, { ...typed, text: words.join(" ") })
        limit = params.limit ?? limit
        return services.messages.search({
          kind,
          ...syncRequest(this, context),
          ...backendRequest(this),
          ...threadRequest(this),
          ...(pattern ? { pattern } : params.text === undefined ? {} : { text: params.text }),
          ...(params.ast === undefined ? {} : { ast: params.ast }),
          ...(params.chat === undefined ? {} : { chat: params.chat }),
          ...(params.source === undefined ? {} : { source: params.source }),
          ...(params.timezone === undefined ? {} : { timezone: params.timezone }),
          limit,
          ...withOffset(page, limit),
          signal,
          language: params.language ?? (pattern ? "legacy" : "lucene"),
          newest: params.newest === true,
          ...(params.discover === undefined ? {} : { discover: params.discover }),
          ...(params.exact ? { exact: true } : {}),
          context: params.context ?? (context.format === "pretty" ? 2 : 0),
          saved: id,
        })
      })
      .catch((error: unknown) => {
        // Nothing to search is an empty answer, as `search all` treats it, not a failure.
        if (!(error instanceof CliError && error.details.reason === NO_MAIL)) throw error
        context.renderer.note(error.message)
        return { items: [], hasMore: false, corrections: [], completeness: [], wordsReady: true }
      })
    for (const hit of found.items) {
      if (hit.thread?.fallback) context.renderer.note(`thread context uses time neighbours: ${hit.thread.fallback}`)
      if (hit.thread?.stale) context.renderer.note("thread graph may be stale; stale links were not followed")
      if (hit.thread?.stopped.length) context.renderer.note(`thread context stopped: ${hit.thread.stopped.join(", ")}`)
    }
    noteServer(context, found.server)
    const { command } = messenger.app
    for (const { from, to } of found.corrections) context.renderer.note(`${from} → ${to.join(", ")}`)
    for (const { source, reason } of found.skipped ?? []) context.renderer.note(`${source} not searched: ${reason}`)
    if (found.picturesSkipped) context.renderer.note(`pictures not searched: ${found.picturesSkipped}`)
    const stemming = found.query?.stemming
    const forms = (stemming?.applied ? stemming.terms : []).filter(({ stemmer }) => stemmer !== "none")
    if (forms.length > 0)
      context.renderer.note(
        `also found other forms: ${forms.map(({ word, stem, stemmer }) => `${word} → ${stem}* (${stemmer})`).join(", ")} — --exact for the exact words only`,
      )
    if (stemming?.applied === false)
      context.renderer.note(
        stemming.reason === "building"
          ? `other forms of words are not searched yet: the stems are ${Math.floor((stemming.done / Math.max(stemming.total, 1)) * 100)}% built — \`${command} store migrate\` finishes them`
          : "other forms of words are not searched: the store asks for stemmers this tool does not know — upgrade this tool",
      )
    if (!found.wordsReady) {
      context.renderer.note(
        found.query
          ? `the word index is still being built, so a search by words fails until \`${command} store migrate\` finishes it`
          : `the word index is still being built, so a search by words reads pieces of words until \`${command} store migrate\` finishes it`,
      )
    }
    const incomplete = found.completeness.filter((chat) => chat.state !== "complete")
    const chats = incomplete.filter((chat) => chat.provider !== "email").length
    const summary = found.coverage ? archiveSummary(found.coverage, found.items.length) : undefined
    if (summary) context.renderer.note(summary)
    else if (!found.coverage && chats > 0) {
      context.renderer.note(
        `${chats} of the chats searched are not held in full — \`${command} messages sync <chat>\` syncs one`,
      )
    }
    if (kind === "mail" || incomplete.some((chat) => chat.provider === "email")) {
      context.renderer.note(
        "mail search covers imported messages only; older or unimported mail may be missing — `memo sync --mail --since-time <time>` imports more",
      )
    }
    const view = () => {
      const options = {
        color: context.color,
        verbosity: context.settings.detail,
        senderColors: context.settings.senderColors,
        profile: context.profile,
        provider: messenger.provider,
        locale: messenger.app.locale,
      }
      const hits = found.items.map((hit) => ({ hit, at: parseLocator(hit.locator) }))
      const spans = new Set(hits.map(({ at }) => `${at.provider}/${at.account}`)).size > 1
      const lines = hits
        .map(({ hit, at }) => {
          const title = hit.chatTitle ?? hit.chatId
          const links = hit.thread ? renderThreadLinks(hit.thread) : ""
          const place =
            hit.matchedIn && hit.matchedIn !== "text" && "excerpt" in hit
              ? `\n  found in the ${PLACES[hit.matchedIn]}: ${String(hit.excerpt)}`
              : ""
          return `${spans ? `${at.provider} · ${title}` : title}  ${hit.locator}\n${renderMessages(hit.thread?.items ?? hit.context ?? [hit], options)}${place}${links ? `\n${links}` : ""}`
        })
        .join("\n\n")
      const elsewhere = [...new Set(hits.map(({ at }) => at.provider))].filter((one) => one !== messenger.provider)
      if (elsewhere.length > 0) {
        context.renderer.note(
          `hits in ${elsewhere.join(", ")} open in that messenger's own CLI, by the locator: messages context msg:…`,
        )
      }
      if (found.items.length === 0)
        context.renderer.note(
          found.server && !found.server.skipped
            ? "nothing found in the local store or on the messenger's server"
            : "nothing found — only what is in the local store is searched",
        )
      const pictures = found.pictures?.length
        ? `\n\nPictures, by what they show (an English query matches best):\n${found.pictures
            .map(({ locator, score }) => `  ${locator}  ${score.toFixed(2)}`)
            .join("\n")}\n`
        : ""
      return `${lines}${pictures}`
    }
    const again = {
      ...(given.length ? { query: given.join(" ") } : {}),
      ...(saved === undefined ? {} : { saved }),
      ...(source === undefined ? {} : { source }),
      ...(regex ? { regex: true } : {}),
      ...(discover ? { discover: true } : {}),
      ...(language === undefined ? {} : { language }),
      ...(exact ? { exact: true } : {}),
      ...(newest ? { newest: true } : {}),
      ...(timezone === undefined ? {} : { timezone }),
    }
    renderAnswer(
      this,
      context,
      messagesAnswer(`search ${kind}`, found, { limit, page: page ?? 1, again }, given.join(" ")),
      view,
    )
  }

const withOffset = (page: number | undefined, limit: number) => {
  const offset = offsetOf(page, limit)
  return offset === undefined ? {} : { offset }
}

const patternOf = (source: string): RegExp => {
  try {
    return new RegExp(source, "iu")
  } catch {
    throw new CliError("validation_error", "not a regular expression — check JavaScript syntax or use Lucene regex")
  }
}

export const wholeCount = (value: string): number => {
  if (!/^\d+$/.test(value.trim())) {
    throw new CliError("validation_error", `--context takes a whole number from 0 upwards, not "${value}"`)
  }
  return Number(value)
}

export const languageOf = (value: string): "lucene" | "legacy" => {
  if (value !== "lucene" && value !== "legacy")
    throw new CliError("validation_error", "--language takes lucene or legacy")
  return value
}
