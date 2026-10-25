import { CliError } from "@wirecat/cli-base"
import { annotate } from "@wirecat/cli-base/commands"
import { Command } from "commander"
import { parseLocator } from "../../domain/locator.js"
import { SAVE_HELP } from "../../meetings/index.js"
import { syncsOneChat } from "../../ports/traits.js"
import { renderMessages } from "../../render/messages.js"
import { renderThreadLinks } from "../../render/thread-context.js"
import type { SearchFound } from "../../services/messages.js"
import { environmentOf } from "../context.js"
import { REMOTE_READ } from "../effects.js"
import { renderAnswer } from "../envelope.js"
import { positiveCount } from "../paging.js"
import { archiveSummary } from "./archive-summary.js"
import { type Messenger, messengerContext } from "./context.js"
import { messagesAnswer, offsetOf } from "./search-answers.js"
import { backendOptions, backendRequest, noteServer } from "./search-backend-options.js"
import { syncOptions, syncRequest, syncsFirst } from "./search-sync-options.js"
import { threadOptions, threadRequest } from "./thread-options.js"

const PLACES = { transcript: "transcript", filename: "file name", file: "file text" } as const

/** `search messages`: this messenger's messages; mail is memo's, read by the same services with kind mail. */
export const messagesSearchCommand = (messenger: Messenger): Command => {
  const command = annotate(backendOptions(threadOptions(syncOptions(new Command("messages"), messenger)), messenger), {
    effects: REMOTE_READ,
    partial: true,
    output: { entity: "message", view: "hit" },
  })
  const syncing = syncsFirst(messenger) ? "; optionally fetches new messages with --sync-first" : ""
  return command
    .summary("find messages by words and filters")
    .description(
      messenger.serverSearch
        ? `search messenger messages in the local store and on the messenger's server (--backend)${syncing}; --discover searches the archive only`
        : `search messenger messages in the local store — what was read, fetched or kept by serve${syncing}; --discover searches the archive only`,
    )
    .argument(
      "[query...]",
      'strict Lucene query: words, "phrases", AND/OR/NOT, field groups and date ranges; with --saved, more words AND-ed to it',
    )
    .option(
      "--source <accounts>",
      "every account of this messenger held in the store; personal, bots or all — the same as in: in the query; " +
        "or a list: group:work,telegram:Alice",
    )
    .option("--limit <n>", "how many", positiveCount("--limit"))
    .option("--page <n>", "which page, starting at 1", positiveCount("--page"))
    .option("--newest", "newest first instead of best first")
    .option(
      "--exact",
      "bare words and quotes match their exact form only, as exact:word does; text: still matches every form",
    )
    .option("--context <n>", "messages before and after each hit; 2 in the terminal, 0 otherwise", wholeCount)
    .option(
      "--discover",
      "find partial word matches, eligible replies and, once messages have vectors, messages close in meaning in the " +
        "local archive; results are evidence, not confirmed answers",
    )
    .option("--timezone <zone>", "the IANA timezone for calendar date boundaries")
    .addHelpText("after", SAVE_HELP)
    .addHelpText(
      "after",
      `${
        syncsFirst(messenger)
          ? `Search reads the local archive: a chat never fetched is not searched. Prepare it once with
\`${messenger.app.command} messages sync --all --background\` (the last 90 days of every chat); the answer's
coverage says what was searched and coverage.next what would improve it.`
          : `Search reads the local archive: what \`${messenger.app.command} serve\` has kept since the account was linked.
Keep serve running so new messages are searchable.`
      } Notes are
\`${messenger.app.command} search notes\`, messages and notes at once \`${messenger.app.command} search all\`; for mail,
the separate memo CLI: \`memo search mail\`.
A bare word looks in message text, voice transcripts, file names and file text. text:, transcript:,
content: (the text of files) and filename: (their names) narrow it to one —
\`${messenger.app.command} search messages 'content:invoice'\`. chat: narrows it to one chat; has:voice, has:file and
NOT has:attachment to voice messages, files or text alone. --json: the list is items; each hit's reference is ref.
Search guide: https://github.com/WireCatLabs/cli-core/blob/main/docs/search/query-language.md`,
    )
    .option("--saved <name|id>", "run a saved search or an earlier run; options typed here replace its own")
    .action(searchAction(messenger))
}

const searchAction = (messenger: Messenger) =>
  async function (this: Command, given: string[]) {
    const context = messengerContext(this, messenger)
    const words = given
    const {
      source,
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
      discover?: boolean
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
    const controller = new AbortController()
    context.track({ close: async () => controller.abort() })
    const external = environmentOf(this).signal
    const signal = external ? AbortSignal.any([external, controller.signal]) : controller.signal
    const typed = {
      ...(source === undefined ? {} : { source }),
      ...(discover === undefined ? {} : { discover }),
      ...(timezone === undefined ? {} : { timezone }),
      ...(newest ? { newest: true } : {}),
      ...(exact ? { exact: true } : {}),
      ...(around === undefined ? {} : { context: around }),
      ...(typedLimit === undefined ? {} : { limit: typedLimit }),
    }
    let limit = context.settings.limit
    const found: SearchFound = await context.withServices(async (services) => {
      if (saved === undefined) {
        return services.messages.search({
          kind: "messages",
          ...syncRequest(this, context),
          ...backendRequest(this),
          ...threadRequest(this),
          ...typed,
          text: words.join(" "),
          limit,
          ...withOffset(page, limit),
          signal,
          newest: newest === true,
          context: around ?? (context.format === "pretty" ? 2 : 0),
        })
      }
      const { id, params } = await services.searches.resolve(saved, { ...typed, text: words.join(" ") })
      limit = params.limit ?? limit
      return services.messages.search({
        kind: "messages",
        ...syncRequest(this, context),
        ...backendRequest(this),
        ...threadRequest(this),
        ...(params.text === undefined ? {} : { text: params.text }),
        ...(params.ast === undefined ? {} : { ast: params.ast }),
        ...(params.chat === undefined ? {} : { chat: params.chat }),
        ...(params.source === undefined ? {} : { source: params.source }),
        ...(params.timezone === undefined ? {} : { timezone: params.timezone }),
        limit,
        ...withOffset(page, limit),
        signal,
        newest: params.newest === true,
        ...(params.discover === undefined ? {} : { discover: params.discover }),
        ...(params.exact ? { exact: true } : {}),
        context: params.context ?? (context.format === "pretty" ? 2 : 0),
        saved: id,
      })
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
    const meaning = found.meaningSkipped
    if (meaning) {
      const step =
        meaning.step === "models.download"
          ? ` — \`${command} models download ${meaning.model}\`, then \`${command} conversations rebuild\` gives messages their vectors`
          : meaning.step === "conversations.rebuild"
            ? ` — \`${command} conversations rebuild\` gives messages their vectors, a batch a run`
            : ""
      context.renderer.note(`meaning search not used: ${meaning.reason}${step}`)
    }
    if (found.picturesSkipped && found.picturesModel === undefined)
      context.renderer.note(`pictures not searched: ${found.picturesSkipped}`)
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
        `the word index is still being built, so a search by words fails until \`${command} store migrate\` finishes it`,
      )
    }
    const incomplete = found.completeness.filter((chat) => chat.state !== "complete")
    const chats = incomplete.length
    const summary = found.coverage ? archiveSummary(found.coverage, found.items.length) : undefined
    if (summary) context.renderer.note(summary)
    else if (!found.coverage && chats > 0 && syncsOneChat(messenger)) {
      context.renderer.note(
        `${chats} of the chats searched are not held in full — \`${command} messages sync <chat>\` syncs one`,
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
      ...(discover ? { discover: true } : {}),
      ...(exact ? { exact: true } : {}),
      ...(newest ? { newest: true } : {}),
      ...(timezone === undefined ? {} : { timezone }),
    }
    renderAnswer(
      this,
      context,
      messagesAnswer("search messages", found, { limit, page: page ?? 1, again }, given.join(" ")),
      view,
    )
  }

const withOffset = (page: number | undefined, limit: number) => {
  const offset = offsetOf(page, limit)
  return offset === undefined ? {} : { offset }
}

export const wholeCount = (value: string): number => {
  if (!/^\d+$/.test(value.trim())) {
    throw new CliError("validation_error", `--context takes a whole number from 0 upwards, not "${value}"`)
  }
  return Number(value)
}
