import { CliError } from "@wirecat/cli-base"
import { Command } from "commander"
import { analysisConsents } from "../../analysis/consents.js"
import { openAnalysis, providerIdentity } from "../../analysis/provider.js"
import { runAnalysis } from "../../analysis/runner.js"
import { isLocal } from "../../embeddings/remote.js"
import { renderMessages } from "../../render/messages.js"
import { BATCH_SIZE } from "../../services/conversations.js"
import {
  type ChatReadiness,
  type EmbedStatus,
  type FoundConversation,
  type FoundConversations,
  type ModelChoice,
  REFRESH_BOUNDS,
  type Refreshed,
} from "../../services/embeddings.js"
import { servicesFor, storedDeps } from "../../services/index.js"
import { momentOf } from "../../services/moment.js"
import type { AgentAnswer, ConversationSummary } from "../../store/store.js"
import { type AnalysisOptions, analysisChoice } from "../analysis-choice.js"
import { embeddingChoice, type ModelOptions } from "../embedding-choice.js"
import { positiveCount, renderList } from "../paging.js"
import { nextStep, rootOf, runnable, stepLine } from "../steps.js"
import { answerOf as askOwner } from "./ask.js"
import { type Messenger, type MessengerContext, messengerContext, refuseLocalWrite } from "./context.js"
import { syncOptions, syncRequest } from "./search-sync-options.js"
import { readAll } from "./stdin.js"

/**
 * `conversations`: the threads inside a group chat, found by rules over the stored messages — replies,
 * mentions, one sender's messages in a row. From the store alone; nothing is built until asked (phase 3).
 */
export const conversationsCommand = (messenger: Messenger): Command => {
  const conversations = new Command("conversations").description(
    "the conversations inside a chat, found in the stored messages by replies, mentions and who wrote next",
  )

  boundOptions(
    conversations
      .command("build")
      .description(
        "find a chat's conversations in what the store holds, replacing the last build; without --chat, every " +
          "chat that changed since its build and every group never built; never asks the messenger",
      )
      .option("--chat <chat>", messenger.chatArgument)
      .option(
        "--analyze",
        "link batches using the configured analysis provider; requires --chat and remembers consent for this chat/provider",
      )
      .option("--provider <provider>", "analysis: agent, openai or anthropic")
      .option("--model <model>", "analysis model; overrides analysisModel")
      .option("--base-url <url>", "analysis API endpoint; overrides analysisBaseUrl")
      .option("--size <n>", "analysis answer messages per batch, 10–200; default 50", positiveCount("--size"))
      .option(
        "--max-tokens <n>",
        "analysis input/output reservation cap per run; default 100000",
        positiveCount("--max-tokens"),
      ),
    { chunks: false },
  ).action(async function (this: Command) {
    const options = this.optsWithGlobals<
      AnalysisOptions & {
        chat?: string
        maxChats?: number
        analyze?: boolean
        size?: number
        maxTokens?: number
        yes?: boolean
      }
    >()
    const { chat, maxChats } = options
    const context = messengerContext(this, messenger)
    if (options.analyze) {
      if (!chat) throw new CliError("validation_error", "--analyze requires --chat")
      refuseLocalWrite(context, messenger.app.command, LINKS_KEY)
      refuseLocalWrite(context, messenger.app.command, "conversations.build")
      const target = analysisChoice(options, messenger.app, context.settings, context.env)
      const controller = new AbortController()
      context.track({ close: async () => controller.abort() })
      const maxTokens = options.maxTokens ?? 100_000
      const size = options.size ?? BATCH_SIZE.default
      const result = await context.withStore(async (store, account) => {
        const services = servicesFor({
          ...storedDeps(messenger, store, account, context.guard),
          env: context.env,
          profile: context.profile,
        })
        const status = await services.conversations.batchStatus(chat, size)
        const consents = analysisConsents(store, account)
        const identity = providerIdentity(target)
        if (status.messages && !(await consents.has(status.chat, identity))) {
          const what = `${status.messages} messages, ${status.characters} characters (about ${status.tokensEstimate} message tokens, plus prompt and batch context), go to ${target.model} at ${target.baseUrl}; this run reserves at most ${maxTokens} input/output tokens. Consent is remembered for this chat and provider until revoked`
          if (!options.yes) {
            const answer = await askOwner(this, `${what}. Allow analysis? [y/N] `)
            if (answer === null) throw new CliError("confirmation_required", `${what} — add --yes`)
            if (!/^y(es)?$/i.test(answer.trim())) throw new CliError("cancelled", "cancelled — nothing was sent")
          }
          await consents.remember(status.chat, identity)
        }
        await services.conversations.build(chat)
        const request = openAnalysis(target, controller.signal)
        return runAnalysis(
          services.conversations,
          chat,
          async (...args) => {
            if (!(await consents.has(status.chat, identity)))
              throw new CliError("permission_error", "analysis consent was revoked; no further batch was sent")
            return request(...args)
          },
          {
            model: target.model,
            command: messenger.app.command,
            size,
            maxTokens,
          },
        )
      })
      context.renderer.result(result)
      return
    }
    if (
      options.provider !== undefined ||
      options.model !== undefined ||
      options.baseUrl !== undefined ||
      options.size !== undefined ||
      options.maxTokens !== undefined
    )
      throw new CliError("validation_error", "analysis options require --analyze")
    if (chat === undefined) {
      const refreshed = await context.withServices((services) =>
        services.embeddings.refresh({
          embed: false,
          ...(maxChats ? { maxChats } : {}),
          progress: (note) => context.renderer.note(note),
        }),
      )
      renderRefreshed(context, refreshed, rootOf(this))
      return
    }
    const built = await context.withServices((services) => services.conversations.build(chat))
    if (context.format === "pretty") {
      context.streams.data(
        `${built.messages} messages → ${built.conversations} conversations, ${built.links} links (rules v${built.rulesVersion})\n`,
      )
    } else context.renderer.result(built)
  })

  conversations
    .command("list")
    .description("a chat's conversations, the newest first: when, how many messages, how many people")
    .requiredOption("--chat <chat>", messenger.chatArgument)
    .option("--since-time <time>", "only those that started at this ISO 8601 time, or 30m / 2h / 1d ago, or later")
    .option("--limit <n>", "how many", positiveCount("--limit"))
    .action(async function (this: Command) {
      const { chat, sinceTime: since } = this.opts<{ chat: string; sinceTime?: string }>()
      const context = messengerContext(this, messenger)
      const { limit } = context.settings
      const page = await context.withServices((services) =>
        services.conversations.list(chat, {
          limit,
          ...(since === undefined ? {} : { since: new Date(momentOf(since, "--since-time")).toISOString() }),
        }),
      )
      if (context.format === "pretty") {
        context.streams.data(page.items.map((one) => `${line(one)}\n`).join(""))
        if (page.items.length === 0) context.renderer.note("no conversations in that window")
      } else if (context.format === "jsonl") context.renderer.stream(page.items)
      else context.renderer.result({ items: page.items, limit, hasMore: page.hasMore })
    })

  conversations
    .command("show")
    .description("one conversation's messages, oldest first — by its id, or the one a message is in")
    .argument(
      "<conversation>",
      `a conversation id from \`conversations list\`; or ${messenger.chatArgument}, with a message`,
    )
    .argument("[message]", "a message id in that chat: show the conversation it is in")
    .action(async function (this: Command, first: string, message: string | undefined) {
      const context = messengerContext(this, messenger)
      if (message === undefined && !/^\d+$/.test(first)) {
        throw new CliError("validation_error", "a conversation id is a number; for a chat, name a message too")
      }
      const { summary, messages } = await context.withServices((services) =>
        services.conversations.show(message === undefined ? { id: first } : { chat: first, message }),
      )
      if (context.format === "pretty") {
        context.streams.data(
          `${line(summary)}\n\n${renderMessages(messages, {
            color: context.color,
            verbosity: context.settings.detail,
            senderColors: context.settings.senderColors,
            profile: context.profile,
            provider: messenger.provider,
            locale: messenger.app.locale,
          })}`,
        )
      } else if (context.format === "jsonl") context.renderer.stream(messages)
      else context.renderer.result({ ...summary, messages })
    })

  withModelOptions(
    conversations
      .command("related")
      .description(
        "the conversations nearest in meaning to the one a message is in, in every built chat, best first — " +
          "from the vectors `conversations embed` stored; runs no model",
      )
      .argument("<chat>", messenger.chatArgument)
      .argument("<message>", "a message id in that chat")
      .option("--limit <n>", "how many", positiveCount("--limit")),
  ).action(async function (this: Command, chat: string, message: string) {
    const options = this.opts<ModelOptions>()
    const context = messengerContext(this, messenger)
    const model = choiceOf(options, messenger, context, { needKey: false })
    const { limit } = context.settings
    const found = await context.withServices((services) => services.embeddings.related(chat, message, { model, limit }))
    if (context.format === "pretty") {
      context.streams.data(`like ${line(found.source)}\n\n${found.hits.map((hit) => `${hitLine(hit)}\n`).join("")}`)
      if (found.hits.length === 0) context.renderer.note(`no other conversation has vectors of ${found.model}`)
    } else if (context.format === "jsonl") context.renderer.stream(found.hits)
    else {
      const { model: id, source, hits, readiness } = found
      context.renderer.result({ model: id, source, items: hits, limit, readiness })
    }
    const command = messenger.app.command
    const unseen = found.readiness.wordsOnly
    if (unseen.length > 0) {
      context.renderer.note(
        `not searched, no vector of ${found.model}: chat ${unseen.join(", ")} — \`${command} conversations embed --chat <chat>\``,
      )
    }
    // `unavailable` keeps out the note about word matches: related searches no words.
    for (const note of readinessNotes({ ...found, meaning: "unavailable", embeddedOnlyElsewhere: [] }, command)) {
      context.renderer.note(note)
    }
  })

  withModelOptions(
    conversations
      .command("status")
      .description(
        "how fresh each built chat's conversations and vectors are: messages the build has not seen, chunks " +
          "with a current, stale or missing vector",
      )
      .option("--chat <chat>", `only this chat: ${messenger.chatArgument}`),
  ).action(async function (this: Command) {
    const options = this.opts<ModelOptions & { chat?: string }>()
    const context = messengerContext(this, messenger)
    const model = choiceOf(options, messenger, context, { needKey: false })
    const {
      model: id,
      chats,
      unbuiltGroups,
    } = await context.withServices((services) =>
      services.embeddings.readiness({ ...(options.chat === undefined ? {} : { chat: options.chat }), model }),
    )
    if (unbuiltGroups)
      context.renderer.note(
        `${unbuiltGroups} group chat${unbuiltGroups === 1 ? " was" : "s were"} never built — \`${messenger.app.command} conversations build\` builds them`,
      )
    if (context.format !== "pretty") {
      renderList(context.renderer, context.format, chats, {
        model: id,
        ...(unbuiltGroups === undefined ? {} : { unbuiltGroups }),
      })
      return
    }
    context.streams.data(chats.map((one) => `${readinessLine(one, id)}\n`).join(""))
    if (chats.length === 0 && !unbuiltGroups)
      context.renderer.note("no chat has conversations yet — `conversations build --chat <chat>`")
  })

  const batches = conversations
    .command("batches")
    .description("windows of a chat for your own AI agent to link: which earlier message each one answers")
  const sizeOption = (command: Command) =>
    command.option(
      "--size <n>",
      `messages to answer per batch, ${BATCH_SIZE.min}–${BATCH_SIZE.max}; ${BATCH_SIZE.default} by default`,
      positiveCount("--size"),
    )

  sizeOption(
    batches
      .command("status")
      .description("how many messages still wait for an answer, in how many batches, and how much text")
      .requiredOption("--chat <chat>", messenger.chatArgument),
  ).action(async function (this: Command) {
    const { chat, size = BATCH_SIZE.default } = this.opts<{ chat: string; size?: number }>()
    const context = messengerContext(this, messenger)
    const status = await context.withServices((services) => services.conversations.batchStatus(chat, size))
    if (context.format === "pretty") {
      context.streams.data(
        `${status.messages} messages to answer, about ${status.batches} batches, ` +
          `${status.characters} characters (about ${status.tokensEstimate} tokens)\n`,
      )
    } else context.renderer.result(status)
  })

  sizeOption(
    batches
      .command("next")
      .description("the next window to answer, with the messages before it; message text goes to stdout only")
      .requiredOption("--chat <chat>", messenger.chatArgument),
  ).action(async function (this: Command) {
    const { chat, size = BATCH_SIZE.default } = this.opts<{ chat: string; size?: number }>()
    const context = messengerContext(this, messenger)
    const batch = await context.withServices((services) => services.conversations.nextBatch(chat, size))
    if (!batch) {
      if (context.format === "pretty") context.renderer.note("every message of this chat has an answer")
      else context.renderer.result(null)
      return
    }
    if (context.format !== "pretty") {
      context.renderer.result(batch)
      return
    }
    context.streams.data(
      `${batch.batch}\n${batch.messages
        .map(
          (one) =>
            `${one.answer ? "?" : " "} ${one.id}  ${one.at.slice(0, 16).replace("T", " ")}  ${one.sender.name ?? one.sender.id ?? ""}` +
            `${one.replyTo ? `  ↳ ${one.replyTo}` : ""}\n    ${one.text.replaceAll("\n", "\n    ")}\n`,
        )
        .join("")}`,
    )
    context.renderer.note(`${batch.remaining.messages} messages left after this batch`)
  })

  const links = conversations
    .command("links")
    .description("your agent's answers: which earlier message each message of a batch answers")

  links
    .command("add")
    .description(
      'store your agent\'s answer to a batch, read as JSON from stdin: { "model", "answers": [{ "message", ' +
        '"parent", "confidence" }] }; all or nothing',
    )
    .requiredOption("--batch <id>", "the batch id `conversations batches next` printed")
    .action(async function (this: Command) {
      const { batch } = this.opts<{ batch: string }>()
      const context = messengerContext(this, messenger)
      refuseLocalWrite(context, messenger.app.command, LINKS_KEY)
      const answer = answerOf(await readAll(context.stdin))
      const stored = await context.withServices((services) => services.conversations.addAnswers(batch, answer))
      if (context.format === "pretty") {
        context.streams.data(
          `${stored.stored} answers stored — \`conversations build --chat ${stored.chat}\` uses them\n`,
        )
      } else context.renderer.result(stored)
    })

  links
    .command("clear")
    .description("drop your agent's answers for a chat, or only one model's; messages are never touched")
    .requiredOption("--chat <chat>", messenger.chatArgument)
    .option("--model <model>", "only the answers this model gave")
    .action(async function (this: Command) {
      const { chat, model } = this.opts<{ chat: string; model?: string }>()
      const context = messengerContext(this, messenger)
      refuseLocalWrite(context, messenger.app.command, LINKS_KEY)
      const cleared = await context.withServices((services) => services.conversations.clearAnswers(chat, model))
      if (context.format === "pretty") context.streams.data(`${cleared.cleared} answers dropped\n`)
      else context.renderer.result(cleared)
    })

  const embed = withModelOptions(
    new Command("embed")
      .description(
        "compute a vector for each chunk of a chat's conversations for search by meaning — on this machine, or " +
          "with --provider through a service and your key; resumes where it stopped; without --chat, every " +
          "built chat with chunks left, on this machine only",
      )
      .option("--chat <chat>", messenger.chatArgument),
  )
    .option(
      "--workers <n>",
      "local: sessions in parallel, each with its own copy of the model (~0.7 GB each)",
      positiveCount("--workers"),
    )
    .option("--threads <n>", "local: threads in all (default: min(8, cores))", positiveCount("--threads"))
    .option("--concurrency <n>", "remote: requests at once (default: 4)", positiveCount("--concurrency"))
    .option(
      "--max-tokens <n>",
      "remote: stop before a run that could send more tokens than this",
      positiveCount("--max-tokens"),
    )
  boundOptions(embed, { oneChatUnbounded: true })
  embed.action(async function (this: Command) {
    const options = this.optsWithGlobals<
      ModelOptions & {
        chat?: string
        workers?: number
        threads?: number
        maxTokens?: number
        yes?: boolean
      } & BoundOptions
    >()
    const context = messengerContext(this, messenger)
    refuseLocalWrite(context, messenger.app.command, EMBED_KEY)
    const model = choiceOf(options, messenger, context)
    if (options.chat === undefined) {
      localOnly(model, "embedding without --chat")
      const refreshed = await context.withServices((services) =>
        services.embeddings.refresh({
          build: false,
          model: model as string,
          ...bounds(options),
          ...(options.workers ? { workers: options.workers } : {}),
          ...(options.threads ? { threads: options.threads } : {}),
          progress: (note) => context.renderer.note(note),
        }),
      )
      renderRefreshed(context, refreshed, rootOf(this))
      return
    }
    const chat = options.chat
    const done = await context.withServices(async (services) => {
      const status = await services.embeddings.status(chat, model)
      context.renderer.note(
        `${status.left} of ${status.chunks} chunks to embed with ${status.model}` +
          (status.estimateSeconds === null ? "" : `, ${minutes(status.estimateSeconds)} on one session`),
      )
      if (typeof model !== "string" && status.left > 0 && !isLocal(model.remote.baseUrl)) {
        await consent(this, status, model.remote.baseUrl, options)
      }
      return services.embeddings.embed(chat, {
        model,
        ...(options.workers ? { workers: options.workers } : {}),
        ...(options.threads ? { threads: options.threads } : {}),
        ...(options.maxChunks ? { maxChunks: options.maxChunks } : {}),
        progress: (embedded, left) => context.renderer.note(`${embedded} embedded, ${left} left`),
      })
    })
    if (context.format === "pretty") {
      context.streams.data(
        `${done.embedded} chunks embedded with ${done.model}${done.skipped ? `, ${done.skipped} changed since the build — run \`conversations build\` again` : ""}\n`,
      )
    } else context.renderer.result(done)
  })

  withModelOptions(
    embed
      .command("status")
      .description("how many chunks of a chat have a vector of the model, how many are left, and what is left costs")
      .option("--chat <chat>", messenger.chatArgument),
  ).action(async function (this: Command) {
    const options = this.optsWithGlobals<ModelOptions & { chat?: string }>()
    const chat = chatOf(options)
    const context = messengerContext(this, messenger)
    const model = choiceOf(options, messenger, context, { needKey: false })
    const status = await context.withServices((services) => services.embeddings.status(chat, model))
    if (context.format === "pretty") {
      context.streams.data(
        `${status.embedded} of ${status.chunks} chunks embedded with ${status.model}; ${status.left} left` +
          (status.estimateSeconds === null ? "" : `, ${minutes(status.estimateSeconds)}`) +
          (status.priceAtMost ? `, at most ${dollars(status.priceAtMost.usd)}` : "") +
          "\n",
      )
    } else context.renderer.result(status)
  })

  withModelOptions(
    embed
      .command("clear")
      .description("drop a chat's vectors, or only one model's; messages and conversations are never touched")
      .option("--chat <chat>", messenger.chatArgument),
  ).action(async function (this: Command) {
    const options = this.optsWithGlobals<ModelOptions & { chat?: string }>()
    const chat = chatOf(options)
    const context = messengerContext(this, messenger)
    refuseLocalWrite(context, messenger.app.command, EMBED_KEY)
    const given = options.model !== undefined || options.provider !== undefined || options.baseUrl !== undefined
    const model = given ? choiceOf(options, messenger, context, { needKey: false }) : undefined
    const cleared = await context.withServices((services) => services.embeddings.clear(chat, model))
    if (context.format === "pretty") context.streams.data(`${cleared.cleared} vectors dropped\n`)
    else context.renderer.result(cleared)
  })

  const consents = conversations
    .command("consents")
    .description("remembered analysis permissions for this account's chats and provider endpoints")
  consents.command("list").action(async function (this: Command) {
    const context = messengerContext(this, messenger)
    const items = await context.withStore((store, account) => analysisConsents(store, account).list())
    context.renderer.result({ items })
  })
  consents
    .command("revoke")
    .option("--chat <chat>", "revoke only this chat's consents; defaults to every chat")
    .option("--provider <identity>", "exact provider identity from consents list; defaults to every provider")
    .action(async function (this: Command) {
      const { chat, provider } = this.opts<{ chat?: string; provider?: string }>()
      const context = messengerContext(this, messenger)
      refuseLocalWrite(context, messenger.app.command, LINKS_KEY)
      await context.withStore(async (store, account) => {
        const chatId =
          chat === undefined
            ? undefined
            : (
                await servicesFor(storedDeps(messenger, store, account, context.guard)).conversations.batchStatus(
                  chat,
                  BATCH_SIZE.default,
                )
              ).chat
        await analysisConsents(store, account).revoke(chatId, provider)
      })
      context.renderer.result({ revoked: true })
    })

  conversations.addCommand(embed)

  return conversations
}

/**
 * `embed` and its subcommands all take `--chat` and the model options, and commander gives each value to
 * the group: a subcommand reads them with the group's (`optsWithGlobals`) and checks `--chat` itself.
 */
const chatOf = ({ chat }: { chat?: string }): string => {
  if (!chat) throw new CliError("validation_error", "--chat is required: the chat whose conversations to embed")
  return chat
}

const withModelOptions = (command: Command): Command =>
  command
    .option(
      "--model <model>",
      "local: a model id from `models text list` (default: e5-small); remote: the provider's model",
    )
    .option("--provider <provider>", "embedding provider: local or openai; flags override profile settings")
    .option(
      "--base-url <url>",
      "a server with OpenAI's /v1/embeddings: Gemini, Jina, or Ollama and LM Studio on this machine",
    )
    .option(
      "--dims <n>",
      "remote: the vector size — needed with --base-url; shortens an OpenAI model's",
      positiveCount("--dims"),
    )

interface BoundOptions {
  maxChats?: number
  maxChunks?: number
}

/** How much one run over many chats may do: the owner's machine, not a background job, pays for it. */
const boundOptions = (
  command: Command,
  { chunks = true, oneChatUnbounded = false }: { chunks?: boolean; oneChatUnbounded?: boolean } = {},
): Command => {
  command.option(
    "--max-chats <n>",
    `at most this many chats in one run; ${REFRESH_BOUNDS.maxChats} if not given`,
    positiveCount("--max-chats"),
  )
  if (chunks) {
    command.option(
      "--max-chunks <n>",
      `at most this many chunks embedded in one run; ${REFRESH_BOUNDS.maxChunks} if not given` +
        (oneChatUnbounded ? ", and no limit with --chat" : ""),
      positiveCount("--max-chunks"),
    )
  }
  return command
}

const bounds = ({ maxChats, maxChunks }: BoundOptions) => ({
  ...(maxChats ? { maxChats } : {}),
  ...(maxChunks ? { maxChunks } : {}),
})

/** Work nobody named chat by chat never sends chat text off the machine. */
const localOnly = (model: ModelChoice, what: string) => {
  if (typeof model !== "string") {
    throw new CliError(
      "validation_error",
      `${what} uses the model on this machine only — drop --provider and --base-url, or embed one chat with --chat`,
    )
  }
}

const renderRefreshed = (context: MessengerContext, refreshed: Refreshed, root: Command) => {
  if (context.format === "pretty") {
    context.streams.data(
      [
        ...refreshed.built.map(
          (one) => `${one.chat}  built: ${one.messages} messages → ${one.conversations} conversations\n`,
        ),
        ...refreshed.embedded.map((one) => `${one.chat}  ${one.embedded} chunks embedded with ${one.model}\n`),
      ].join(""),
    )
    if (refreshed.built.length + refreshed.embedded.length === 0 && refreshed.left.length === 0) {
      context.renderer.note("every chat is up to date")
    }
  } else context.renderer.result(refreshed)
  for (const note of leftNotes(refreshed, root)) context.renderer.note(note)
}

/** Names the download only where this CLI has the command; a host without `models` gets the fact alone. */
const notDownloaded = (root: Command, model: string, lead: string): string => {
  const [step] = runnable(root, [nextStep("models.download", { args: { model } })])
  return `${lead}: ${model} is not downloaded${step ? ` — \`${stepLine(root, step)}\`` : ""}`
}

const leftNotes = ({ model, modelAvailable, embedded, left }: Refreshed, root: Command) => {
  const of = (needs: "build" | "embed") => left.filter((one) => one.needs === needs).map(({ chat }) => chat)
  const build = of("build")
  const embed = of("embed")
  return [
    build.length > 0 ? `still to build: chat ${build.join(", ")} — run it again, or raise --max-chats` : "",
    embed.length > 0 && modelAvailable
      ? `still to embed: chat ${embed.join(", ")} — run it again, or raise --max-chats and --max-chunks`
      : "",
    embed.length > 0 && !modelAvailable && embedded.length === 0 ? notDownloaded(root, model, "nothing embedded") : "",
  ].filter(Boolean)
}

const choiceOf = (
  options: ModelOptions,
  messenger: Messenger,
  context: MessengerContext,
  extra?: { needKey?: boolean },
): ModelChoice => embeddingChoice(options, messenger.app, context.settings, context.env, extra)

/**
 * The messages leave the machine: say where, how much and what it may cost, and wait for a yes — `--yes`
 * in machine mode (E11). Every run asks again.
 */
const consent = async (
  command: Command,
  status: EmbedStatus,
  baseUrl: string,
  { yes, maxTokens }: { yes?: boolean; maxTokens?: number },
) => {
  if (maxTokens !== undefined && status.tokensAtMost > maxTokens) {
    throw new CliError(
      "validation_error",
      `this run could send up to ${status.tokensAtMost} tokens, above --max-tokens ${maxTokens} — nothing was sent`,
    )
  }
  const price = status.priceAtMost
    ? `, at most ${dollars(status.priceAtMost.usd)} at the price read ${status.priceAtMost.read}`
    : ""
  const what =
    `${status.left} chunks of chat ${status.chat}, up to ${status.tokensAtMost} tokens${price}, ` +
    `go to ${status.model} (${new URL(baseUrl).host})`
  if (yes) return
  const answer = await askOwner(command, `${what}. Send them? [y/N] `)
  if (answer === null) throw new CliError("confirmation_required", `${what} — add --yes to send them`)
  if (!/^y(es)?$/i.test(answer.trim())) throw new CliError("cancelled", "cancelled — nothing was sent")
}

const LINKS_KEY = "conversations.links"
const EMBED_KEY = "conversations.embed"

const dollars = (usd: number) => (usd < 0.0001 ? "under $0.0001" : `$${usd.toFixed(4)}`)

const minutes = (seconds: number) => (seconds < 90 ? `about ${seconds} s` : `about ${Math.round(seconds / 60)} min`)

/** The agent's JSON, shaped enough for the store to check the rest against the batch. */
const answerOf = (text: string): AgentAnswer => {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new CliError("validation_error", "the answer on stdin is not JSON — see `conversations links add --help`")
  }
  const answer = parsed as Partial<AgentAnswer> | null
  if (!answer || typeof answer !== "object" || !Array.isArray(answer.answers)) {
    throw new CliError(
      "validation_error",
      'the answer needs "answers": a list of { "message", "parent", "confidence" }',
    )
  }
  return answer as AgentAnswer
}

/** `messages links`: why a message sits where it does in its conversation. */
export const linksCommand = (messenger: Messenger): Command =>
  new Command("links")
    .description("why a message is in its conversation: each link it has, and the chain of answers back to the start")
    .argument("<chat>", messenger.chatArgument)
    .argument("<message>", "the message id")
    .action(async function (this: Command, chat: string, message: string) {
      const context = messengerContext(this, messenger)
      const found = await context.withServices((services) => services.conversations.links(chat, message))
      if (context.format !== "pretty") {
        context.renderer.result(found)
        return
      }
      if (found.links.length === 0) {
        context.renderer.note("no links: it starts a conversation, or the chat is not built — `conversations build`")
      }
      context.streams.data(
        found.links
          .map(
            (link) =>
              `${link.chosen ? "→" : " "} ${link.parentId ?? "(starts)"}  ${link.source} ${link.kind} ` +
              `${link.confidence}  ${link.method}${link.stale ? "  stale" : ""}\n`,
          )
          .join("") + (found.chain.length > 0 ? `chain: ${[message, ...found.chain].join(" ← ")}\n` : ""),
      )
    })

const line = (one: ConversationSummary) =>
  `${one.id}  ${one.firstAt.slice(0, 16).replace("T", " ")}–${one.lastAt.slice(11, 16)}  ` +
  `${one.messageCount} messages · ${one.senders} people · from message ${one.firstMessageId}`

const hitLine = ({ summary, chunk, score, stale, locator }: FoundConversation) =>
  `${score === null ? "  —  " : score.toFixed(3)}  ${line(summary)}  ` +
  `(messages ${chunk.firstMessageId}–${chunk.lastMessageId})${locator ? `  ${locator}` : ""}${stale ? "  stale" : ""}`

const readinessLine = ({ chat, state, graph, pending, vectors }: ChatReadiness, model: string) =>
  graph === null
    ? `${chat}  ${state} — \`conversations build --chat ${chat}\``
    : `${chat}  ${state}  built ${graph.builtAt.slice(0, 16).replace("T", " ")}, rules v${graph.rulesVersion}` +
      `${graph.outdatedRules ? " (outdated)" : ""} · not in the build: ${pending.new} new, ${pending.edited} edited, ` +
      `${pending.deleted} deleted · ${model}: ${vectors.current} current, ${vectors.stale} stale, ` +
      `${vectors.missing} missing of ${vectors.chunks} chunks`

/** What the search could not see, and the command that fixes each. */
const readinessNotes = (
  {
    meaning,
    model,
    readiness,
    embeddedOnlyElsewhere,
  }: Pick<FoundConversations, "meaning" | "model" | "readiness" | "embeddedOnlyElsewhere">,
  command: string,
) => {
  const chats = (ids: string[]) => `chat ${ids.join(", ")}`
  const elsewhere = new Set(embeddedOnlyElsewhere)
  const neverEmbedded = readiness.wordsOnly.filter((id) => !elsewhere.has(id))
  return [
    embeddedOnlyElsewhere.length > 0
      ? `not searched by meaning, embedded only with another model: ${chats(embeddedOnlyElsewhere)} — ` +
        "give that model with --model, or `conversations embed` them with this one"
      : "",
    meaning === "searched" && neverEmbedded.length > 0
      ? `searched by words only, no vector of ${model}: ${chats(neverEmbedded)} — \`${command} conversations embed --chat <chat>\``
      : "",
    readiness.partial.length > 0
      ? `some chunks have no vector yet: ${chats(readiness.partial)} — \`${command} conversations embed --chat <chat>\``
      : "",
    readiness.stale.length > 0
      ? `changed since the last build: ${chats(readiness.stale)} — \`${command} conversations build --chat <chat>\``
      : "",
    readiness.notBuilt.length > 0
      ? `never built, so their matches are not shown: ${chats(readiness.notBuilt)} — ` +
        `\`${command} conversations build --chat <chat>\``
      : "",
  ].filter(Boolean)
}

/** `search conversations`: the conversations nearest to a query, in meaning and in words. */
export const conversationsSearchCommand = (messenger: Messenger): Command =>
  syncOptions(boundOptions(withModelOptions(new Command("conversations"))))
    .description(
      "the conversations nearest to a query in meaning and in words, best first, in one chat or every one — " +
        "meaning after `conversations embed`; runs on this machine",
    )
    .argument("<query>", "what to look for, in your own words, in any language the model reads")
    .option("--chat <chat>", `only this chat: ${messenger.chatArgument}`)
    .option("--since-time <time>", "only those still going at this ISO 8601 time, or 30m / 2h / 1d ago, or later")
    .option(
      "--filter <query>",
      "strict Lucene filter: any message in a conversation must match; does not change the meaning query",
    )
    .option(
      "--source <accounts>",
      "accounts to search: personal, bots, all, a provider, or a list like group:work,telegram:Alice,email:me@example.com; " +
        "defaults to the active account",
    )
    .option("--timezone <zone>", "IANA timezone for filter dates; system timezone by default")
    .option("--limit <n>", "how many", positiveCount("--limit"))
    .option(
      "--refresh",
      "first build and embed, on this machine, the chats in scope that changed or were never built — within " +
        "--max-chats and --max-chunks",
    )
    .action(async function (this: Command, query: string) {
      const options = this.opts<
        ModelOptions & {
          chat?: string
          sinceTime?: string
          refresh?: boolean
          filter?: string
          source?: string
          timezone?: string
        } & BoundOptions
      >()
      const { chat, sinceTime: since } = options
      const context = messengerContext(this, messenger)
      const model = choiceOf(options, messenger, context)
      if (options.refresh) {
        if (options.filter !== undefined || options.source !== undefined)
          throw new CliError(
            "validation_error",
            "--refresh cannot be combined with --filter or --source; build and embed the chosen chats separately",
          )
        localOnly(model, "--refresh")
        refuseLocalWrite(context, messenger.app.command, EMBED_KEY)
      }
      const { limit } = context.settings
      const { found, refreshed } = await context.withServices(async (services) => {
        const syncing = syncRequest(this, context)
        const found = await services.embeddings.search(query, {
          ...syncing,
          ...(options.refresh
            ? {
                refresh: {
                  ...(chat === undefined ? {} : { chat }),
                  model: model as string,
                  ...bounds(options),
                  progress: (note: string) => context.renderer.note(note),
                },
              }
            : {}),
          limit,
          ...(options.filter === undefined ? {} : { filter: options.filter }),
          ...(options.source === undefined ? {} : { source: options.source }),
          ...(options.timezone === undefined ? {} : { timezone: options.timezone }),
          ...(chat === undefined ? {} : { chat }),
          model,
          ...(since === undefined ? {} : { since: new Date(momentOf(since, "--since-time")).toISOString() }),
        })
        return { found, refreshed: found.prepared }
      })
      if (refreshed) for (const note of leftNotes(refreshed, rootOf(this))) context.renderer.note(note)
      if (context.format === "pretty") {
        context.streams.data(found.hits.map((hit) => `${hitLine(hit)}\n`).join(""))
        if (found.hits.length === 0) {
          context.renderer.note(
            found.meaning === "unavailable"
              ? "nothing matches in words"
              : `nothing matches in words, nor in meaning among the chats embedded with ${found.model} — ` +
                  "`conversations embed --chat <chat>` for meaning",
          )
        }
      } else if (context.format === "jsonl") context.renderer.stream(found.hits)
      else {
        const { accounts, model, meaning, hits, readiness, embeddedOnlyElsewhere } = found
        context.renderer.result({
          model,
          meaning,
          items: hits,
          accounts,
          limit,
          readiness,
          embeddedOnlyElsewhere,
          ...(refreshed ? { refreshed } : {}),
          ...(found.refreshed
            ? {
                ...(refreshed ? { networkRefreshed: found.refreshed } : { refreshed: found.refreshed }),
                coverage: found.coverage,
              }
            : {}),
        })
      }
      const command = messenger.app.command
      if (found.meaning === "unavailable") {
        context.renderer.note(notDownloaded(rootOf(this), found.model, "searched by words only"))
      }
      for (const note of readinessNotes(found, command)) context.renderer.note(note)
    })
