import { CliError } from "@wirecat/cli-base"
import { annotate } from "@wirecat/cli-base/commands"
import { Command, Option } from "commander"
import { analysisConsents } from "../../analysis/consents.js"
import { openAnalysis, providerIdentity } from "../../analysis/provider.js"
import { runAnalysis } from "../../analysis/runner.js"
import { isLocal } from "../../embeddings/remote.js"
import { renderMessages } from "../../render/messages.js"
import { BATCH_SIZE, CONVERSATION_QUERY, type ConversationItem } from "../../services/conversations.js"
import {
  type ChatReadiness,
  type EmbedStatus,
  type FoundConversation,
  type ModelChoice,
  REFRESH_BOUNDS,
  type Refreshed,
} from "../../services/embeddings.js"
import { servicesFor, storedDeps } from "../../services/index.js"
import { dateWindow } from "../../services/moment.js"
import type { AgentAnswer, ConversationSummary } from "../../store/store.js"
import { type AnalysisOptions, analysisChoice } from "../analysis-choice.js"
import {
  destroysNothing,
  LOCAL_READ,
  LOCAL_WRITE,
  REMOTE_READ,
  REMOTE_WRITE,
  reachesOtherService,
  refuseUnderReadOnly,
} from "../effects.js"
import { embeddingChoice, type ModelOptions, refuseRemoteQuery } from "../embedding-choice.js"
import { itemOf, listOf, renderAnswer, snakeKeys } from "../envelope.js"
import { listQuery, pagedList, pageOf, typedQuery, withQuery } from "../list-query.js"
import { positiveCount } from "../paging.js"
import { readsStdin } from "../stdin-field.js"
import { nextStep, rootOf, runnable, stepLine } from "../steps.js"
import { ANALYSIS_CONSENTS_QUERY, analysisConsentFilter } from "./analysis-consents-query.js"
import { answerOf as askOwner } from "./ask.js"
import { type Messenger, type MessengerContext, messengerContext, refuseLocalWrite } from "./context.js"
import { conversationShown, foundConversations, readinessList, refreshedAnswer } from "./conversation-answers.js"
import { conversationExamples } from "./conversation-examples.js"
import { messageItems } from "./message-items.js"
import { syncOptions, syncRequest } from "./search-sync-options.js"
import { readAll } from "./stdin.js"

/**
 * `conversations`: the threads inside a group chat, found by rules over the stored messages — replies,
 * mentions, one sender's messages in a row. From the store alone; nothing is built until asked (phase 3).
 */
const conversationBuildCommand = (messenger: Messenger): Command =>
  boundOptions(
    reachesOtherService(
      annotate(new Command("rebuild"), { output: { entity: "conversation_build" }, effects: REMOTE_WRITE }),
    )

      .summary("build conversation links from stored messages")
      .description(
        "find a chat's conversations in what the store holds, replacing the last build; without --chat, every " +
          "chat that changed since its build and every group never built; never asks the messenger",
      )
      .option("--chat <chat>", messenger.chatArgument)
      .option(
        "--analyze",
        "link batches using the configured analysis provider; requires --chat and remembers consent for this chat/provider",
      )
      .addOption(new Option("--analysis-provider <provider>", "analysis: agent, openai or anthropic"))

      .option("--model <model>", "analysis model; overrides models.analysis.model")
      .option("--base-url <url>", "analysis API endpoint; overrides models.analysis.base_url")
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
      refuseLocalWrite(context, messenger.app.command, "conversations.links.rebuild")
      const target = analysisChoice(options, messenger.app, context.settings, context.env, context.keyring)
      if (!isLocal(target.baseUrl)) refuseUnderReadOnly(this, `send chat text to ${new URL(target.baseUrl).host}`)
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
      renderAnswer(this, context, itemOf(snakeKeys(result)))
      return
    }
    if (
      options.analysisProvider !== undefined ||
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
      renderRefreshed(this, context, refreshed)
      return
    }
    const built = await context.withServices((services) => services.conversations.build(chat))
    renderAnswer(
      this,
      context,
      itemOf(snakeKeys(built)),
      () =>
        `${built.messages} messages → ${built.conversations} conversations, ${built.links} links (rules v${built.rulesVersion})\n`,
    )
  })

const embeddingStatusCommand = (messenger: Messenger): Command =>
  withModelOptions(
    annotate(new Command("status"), { output: { entity: "conversation_embedding_status" }, effects: LOCAL_READ })
      .summary("which conversation vectors are ready or stale")
      .description("how many chunks of a chat have a vector of the model, how many are left, and what is left costs")
      .option("--chat <chat>", messenger.chatArgument),
  ).action(async function (this: Command) {
    const options = this.optsWithGlobals<ModelOptions & { chat?: string }>()
    const chat = chatOf(options)
    const context = messengerContext(this, messenger)
    const model = choiceOf(options, messenger, context, { needKey: false })
    const status = await context.withServices((services) => services.embeddings.status(chat, model))
    renderAnswer(
      this,
      context,
      itemOf(snakeKeys(status)),
      () =>
        `${status.embedded} of ${status.chunks} chunks embedded with ${status.model}; ${status.left} left` +
        (status.estimateSeconds === null ? "" : `, ${minutes(status.estimateSeconds)}`) +
        (status.priceAtMost ? `, at most ${dollars(status.priceAtMost.usd)}` : "") +
        "\n",
    )
  })

const embeddingClearCommand = (messenger: Messenger): Command =>
  withModelOptions(
    destroysNothing(annotate(new Command("clear"), { output: { entity: "conversation_change" }, effects: LOCAL_WRITE }))
      .summary("remove stored conversation vectors")
      .description("drop a chat's vectors, or only one model's; messages and conversations are never touched")
      .option("--chat <chat>", messenger.chatArgument),
  ).action(async function (this: Command) {
    const options = this.optsWithGlobals<ModelOptions & { chat?: string }>()
    const chat = chatOf(options)
    const context = messengerContext(this, messenger)
    refuseLocalWrite(context, messenger.app.command, EMBED_KEY)
    const given =
      options.model !== undefined || options.embeddingProvider !== undefined || options.baseUrl !== undefined
    const model = given ? choiceOf(options, messenger, context, { needKey: false }) : undefined
    const cleared = await context.withServices((services) => services.embeddings.clear(chat, model))
    renderAnswer(this, context, itemOf(cleared), () => `${cleared.cleared} vectors dropped\n`)
  })

export const conversationsCommand = (messenger: Messenger): Command => {
  const conversations = new Command("conversations")
    .summary("group stored messages into conversations")
    .description(
      "the conversations inside a chat, found in the stored messages by replies, mentions and who wrote next",
    )

  withQuery(
    annotate(conversations.command("list"), { effects: LOCAL_READ })
      .summary("stored conversations in one chat")
      .description("a chat's conversations, the newest first: when, how many messages, how many people")
      .argument("<chat>", messenger.chatArgument),
    CONVERSATION_QUERY,
  )
    .option("--limit <n>", "how many", positiveCount("--limit"))
    .action(async function (this: Command, chat: string, words: string[]) {
      const context = messengerContext(this, messenger)
      const query = listQuery(typedQuery(words), CONVERSATION_QUERY, "conversations list")
      const found = await context.withServices((services) =>
        services.conversations.list(chat, { ...pageOf(context.settings), ...(query ? { query } : {}) }),
      )
      renderAnswer(this, context, pagedList("conversations list", context.settings, found), () =>
        found.items.map((one) => `${itemLine(one)}\n`).join(""),
      )
      if (found.items.length === 0 && context.format === "pretty") context.renderer.note("no conversations match")
    })

  annotate(conversations.command("show"), { output: { entity: "conversation", view: "details" }, effects: LOCAL_READ })
    .summary("one conversation and its messages")
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
      const { account, summary, messages } = await context.withStore(async (store, account) => ({
        account,
        ...(await servicesFor(storedDeps(messenger, store, account, context.guard)).conversations.show(
          message === undefined ? { id: first } : { chat: first, message },
        )),
      }))
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
      } else if (context.format === "jsonl") context.renderer.stream(messageItems(messages, account))
      else renderAnswer(this, context, conversationShown(account, { summary, messages }))
    })

  withModelOptions(
    annotate(conversations.command("related"), { output: { entity: "conversation_hit" }, effects: LOCAL_READ })
      .summary("conversations nearest in meaning to a message's conversation")
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
    renderAnswer(
      this,
      context,
      foundConversations("conversations related", { ...found, meaning: "searched" }, limit, messenger),
      () => `like ${line(found.source)}\n\n${found.hits.map((hit) => `${hitLine(hit)}\n`).join("")}`,
    )
    if (found.hits.length === 0 && context.format === "pretty")
      context.renderer.note(`no other conversation has vectors of ${found.model}`)
  })

  withModelOptions(
    annotate(conversations.command("status"), { output: { entity: "conversation_readiness" }, effects: LOCAL_READ })
      .summary("which chats are ready for conversation search")
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
    renderAnswer(
      this,
      context,
      readinessList({ model: id, chats, ...(unbuiltGroups === undefined ? {} : { unbuiltGroups }) }),
      () => chats.map((one) => `${readinessLine(one, id)}\n`).join(""),
    )
    if (chats.length === 0 && !unbuiltGroups && context.format === "pretty")
      context.renderer.note("no chat has conversations yet — `conversations links rebuild --chat <chat>`")
  })

  const batches = conversations
    .command("batches")
    .summary("batches waiting for an agent's conversation links")
    .description("windows of a chat for your own AI agent to link: which earlier message each one answers")
  const sizeOption = (command: Command) =>
    command.option(
      "--size <n>",
      `messages to answer per batch, ${BATCH_SIZE.min}–${BATCH_SIZE.max}; ${BATCH_SIZE.default} by default`,
      positiveCount("--size"),
    )

  sizeOption(
    annotate(batches.command("status"), { output: { entity: "conversation_batch_status" }, effects: LOCAL_READ })
      .summary("progress of conversation-link batches")
      .description("how many messages still wait for an answer, in how many batches, and how much text")
      .requiredOption("--chat <chat>", messenger.chatArgument),
  ).action(async function (this: Command) {
    const { chat, size = BATCH_SIZE.default } = this.opts<{ chat: string; size?: number }>()
    const context = messengerContext(this, messenger)
    const status = await context.withServices((services) => services.conversations.batchStatus(chat, size))
    renderAnswer(
      this,
      context,
      itemOf(snakeKeys(status)),
      () =>
        `${status.messages} messages to answer, about ${status.batches} batches, ` +
        `${status.characters} characters (about ${status.tokensEstimate} tokens)\n`,
    )
  })

  sizeOption(
    annotate(batches.command("show"), { output: { entity: "conversation_batch" }, effects: LOCAL_READ })

      .summary("get the next batch of messages to link")
      .description("the next window to answer, with the messages before it; message text goes to stdout only")
      .requiredOption("--chat <chat>", messenger.chatArgument),
  ).action(async function (this: Command) {
    const { chat, size = BATCH_SIZE.default } = this.opts<{ chat: string; size?: number }>()
    const context = messengerContext(this, messenger)
    const batch = await context.withServices((services) => services.conversations.nextBatch(chat, size))
    if (!batch) {
      if (context.format === "pretty") context.renderer.note("every message of this chat has an answer")
      else renderAnswer(this, context, itemOf({ batch: null }))
      return
    }
    if (context.format !== "pretty") {
      renderAnswer(this, context, itemOf(snakeKeys(batch)))
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

  const links = conversations.command("links").description("message links and the conversations derived from them")
  links.addCommand(conversationBuildCommand(messenger))

  readsStdin(annotate(links.command("add"), { output: { entity: "conversation_change" }, effects: LOCAL_WRITE }), {
    name: "answer",
    description: '{ "model", "skill"?, "answers": [{ "message", "parent", "confidence" }] }',
    json: true,
  })
    .summary("save an agent's conversation-link answers")
    .description(
      'store your agent\'s answer to a batch, read as JSON from stdin: { "model", "answers": [{ "message", ' +
        '"parent", "confidence" }] }; all or nothing',
    )
    .requiredOption("--batch <id>", "the batch id `conversations batches show` printed")
    .action(async function (this: Command) {
      const { batch } = this.opts<{ batch: string }>()
      const context = messengerContext(this, messenger)
      refuseLocalWrite(context, messenger.app.command, LINKS_KEY)
      const answer = answerOf(await readAll(context.stdin))
      const stored = await context.withServices((services) => services.conversations.addAnswers(batch, answer))
      renderAnswer(
        this,
        context,
        itemOf(stored, { next: [nextStep("conversations.build", { args: { chat: stored.chat } })] }),
        () => `${stored.stored} answers stored\n`,
      )
    })

  annotate(links.command("clear"), { output: { entity: "conversation_change" }, effects: LOCAL_WRITE })
    .summary("remove an agent's saved conversation-link answers")
    .description("drop your agent's answers for a chat, or only one model's; messages are never touched")
    .requiredOption("--chat <chat>", messenger.chatArgument)
    .addOption(new Option("--answer-model <model>", "only the stored answers this model gave"))

    .action(async function (this: Command) {
      const { chat, model, answerModel } = this.opts<{ chat: string; model?: string; answerModel?: string }>()
      const context = messengerContext(this, messenger)
      refuseLocalWrite(context, messenger.app.command, LINKS_KEY)
      const cleared = await context.withServices((services) =>
        services.conversations.clearAnswers(chat, answerModel ?? model),
      )
      renderAnswer(this, context, itemOf(cleared), () => `${cleared.cleared} answers dropped\n`)
    })

  const embed = withModelOptions(
    reachesOtherService(
      annotate(new Command("embed"), { output: { entity: "conversation_embedding" }, effects: REMOTE_WRITE }),
    )
      .summary("prepare conversation vectors for meaning search")
      .description(
        "compute a vector for each chunk of a chat's conversations for search by meaning — on this machine, or " +
          "with --embedding-provider through a service and your key; resumes where it stopped; without --chat, every " +
          "built chat with chunks left, on this machine only",
      )
      .option("--chat <chat>", messenger.chatArgument),
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
          ...(options.threads ? { threads: options.threads } : {}),
          progress: (note) => context.renderer.note(note),
        }),
      )
      renderRefreshed(this, context, refreshed)
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
        refuseUnderReadOnly(this, `send chat text to ${new URL(model.remote.baseUrl).host}`)
        await consent(this, status, model.remote.baseUrl, options)
      }
      return services.embeddings.embed(chat, {
        model,
        ...(options.threads ? { threads: options.threads } : {}),
        ...(options.maxChunks ? { maxChunks: options.maxChunks } : {}),
        progress: (embedded, left) => context.renderer.note(`${embedded} embedded, ${left} left`),
      })
    })
    renderAnswer(
      this,
      context,
      itemOf(snakeKeys(done), {
        next: done.skipped ? [nextStep("conversations.build", { args: { chat } })] : [],
      }),
      () =>
        `${done.embedded} chunks embedded with ${done.model}${done.skipped ? `, ${done.skipped} changed since the build` : ""}\n`,
    )
  })

  const embeddings = new Command("embeddings").description("stored conversation vectors")
  embeddings.addCommand(embeddingStatusCommand(messenger)).addCommand(embeddingClearCommand(messenger))
  conversations.addCommand(embeddings)

  boundOptions(
    destroysNothing(
      annotate(conversations.command("rebuild"), {
        output: { entity: "conversation_preparation" },
        effects: LOCAL_WRITE,
        examples: [`${messenger.app.command} conversations rebuild --max-chats 5`],
      }),
    )
      .summary("build and embed the chats that changed, on this machine only")
      .description(
        "build, then embed with the model on this machine, the chats that changed since their build and the group " +
          "chats never built — or only --chat; with the default model, also each message on its own, which " +
          "`search messages --discover` reads; bounded per run, so run it again for the rest; never asks the " +
          "messenger, downloads no model and sends no text anywhere",
      )
      .option("--chat <chat>", messenger.chatArgument),
  ).action(async function (this: Command) {
    const options = this.optsWithGlobals<{ chat?: string } & BoundOptions>()
    const context = messengerContext(this, messenger)
    refuseLocalWrite(context, messenger.app.command, EMBED_KEY)
    const refreshed = await context.withServices((services) =>
      services.embeddings.refresh({
        ...(options.chat === undefined ? {} : { chat: options.chat }),
        ...bounds(options),
        progress: (note) => context.renderer.note(note),
      }),
    )
    renderRefreshed(this, context, refreshed)
  })

  const consents = conversations
    .command("consents")
    .description("remembered analysis permissions for this account's chats and provider endpoints")
  withQuery(annotate(consents.command("list"), { effects: LOCAL_READ }), ANALYSIS_CONSENTS_QUERY)
    .description("which chats and provider endpoints you allowed to analyse, and when")
    .action(async function (this: Command, words: string[]) {
      const filter = analysisConsentFilter(words)
      const context = messengerContext(this, messenger)
      const items = await context.withStore((store, account) => analysisConsents(store, account).list(filter))
      renderAnswer(
        this,
        context,
        listOf("conversations consents list", {
          items: items.map(snakeKeys),
          limit: Math.max(1, items.length),
          has_more: false,
        }),
      )
    })
  annotate(consents.command("remove"), {
    effects: LOCAL_WRITE,
    output: { entity: "analysis_consent_revocation" },
  })

    .description("forget analysis permissions so the next analysis asks again")
    .option("--chat <chat>", "revoke only this chat's consents; defaults to every chat")
    .addOption(
      new Option(
        "--consent-provider <identity>",
        "exact provider identity from consents list; defaults to every provider",
      ),
    )

    .action(async function (this: Command) {
      const { chat, consentProvider } = this.opts<{ chat?: string; consentProvider?: string }>()
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
        await analysisConsents(store, account).revoke(chatId, consentProvider)
      })
      renderAnswer(this, context, itemOf({ revoked: true }))
    })

  conversations.addCommand(embed)

  conversationExamples(conversations, messenger.app.command)
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
    .option("--model <model>", "local: a model id from `models list` (default: e5-small); remote: the provider's model")
    .addOption(
      new Option(
        "--embedding-provider <provider>",
        "embedding provider: local or openai; flags override profile settings",
      ),
    )

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
      `${what} uses the model on this machine only — drop --embedding-provider and --base-url, or embed one chat with --chat`,
    )
  }
}

const renderRefreshed = (command: Command, context: MessengerContext, refreshed: Refreshed) => {
  const root = rootOf(command)
  if (context.format === "pretty") {
    context.streams.data(
      [
        ...refreshed.built.map(
          (one) => `${one.chat}  built: ${one.messages} messages → ${one.conversations} conversations\n`,
        ),
        ...refreshed.embedded.map((one) => `${one.chat}  ${one.embedded} chunks embedded with ${one.model}\n`),
        refreshed.messages?.embedded
          ? `${refreshed.messages.embedded} messages embedded with ${refreshed.model}\n`
          : "",
      ].join(""),
    )
    if (
      refreshed.built.length + refreshed.embedded.length === 0 &&
      refreshed.left.length === 0 &&
      !refreshed.messages?.embedded &&
      !refreshed.messages?.left
    ) {
      context.renderer.note("every chat is up to date")
    }
  } else renderAnswer(command, context, refreshedAnswer(refreshed))
  for (const note of leftNotes(refreshed, root)) context.renderer.note(note)
}

/** Names the download only where this CLI has the command; a host without `models` gets the fact alone. */
const notDownloaded = (root: Command, model: string, lead: string): string => {
  const [step] = runnable(root, [nextStep("models.download", { args: { model } })])
  return `${lead}: ${model} is not downloaded${step?.kind === "command" ? ` — \`${stepLine(root, step)}\`` : ""}`
}

const leftNotes = ({ model, modelAvailable, embedded, left, messages }: Refreshed, root: Command) => {
  const of = (needs: "build" | "embed") => left.filter((one) => one.needs === needs).map(({ chat }) => chat)
  const build = of("build")
  const embed = of("embed")
  return [
    build.length > 0 ? `still to build: chat ${build.join(", ")} — run it again, or raise --max-chats` : "",
    embed.length > 0 && modelAvailable
      ? `still to embed: chat ${embed.join(", ")} — run it again, or raise --max-chats and --max-chunks`
      : "",
    embed.length > 0 && !modelAvailable && embedded.length === 0 ? notDownloaded(root, model, "nothing embedded") : "",
    messages?.left ? `still to embed: ${messages.left} messages — run it again, or raise --max-chunks` : "",
  ].filter(Boolean)
}

const choiceOf = (
  options: ModelOptions,
  messenger: Messenger,
  context: MessengerContext,
  extra?: { needKey?: boolean },
): ModelChoice =>
  embeddingChoice(options, messenger.app, context.settings, context.env, { ...extra, keyring: context.keyring })

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
const EMBED_KEY = "conversations.embeddings"

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
  annotate(new Command("links"), {
    output: { entity: "message_links" },
    examples: [`${messenger.app.command} personal messages links "Book club" 101`],
    effects: LOCAL_READ,
  })
    .summary("why a message belongs to its conversation")
    .description("why a message is in its conversation: each link it has, and the chain of answers back to the start")
    .argument("<chat>", messenger.chatArgument)
    .argument("<message>", "the message id")
    .action(async function (this: Command, chat: string, message: string) {
      const context = messengerContext(this, messenger)
      const found = await context.withServices((services) => services.conversations.links(chat, message))
      if (context.format !== "pretty") {
        renderAnswer(this, context, itemOf(snakeKeys(found)))
        return
      }
      if (found.links.length === 0) {
        context.renderer.note(
          "no links: it starts a conversation, or the chat is not built — `conversations links rebuild`",
        )
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

const itemLine = (one: ConversationItem) =>
  `${one.id}  ${one.started_at.slice(0, 16).replace("T", " ")}–${one.ended_at.slice(11, 16)}  ` +
  `${one.messages_count} messages · ${one.senders_count} people · from ${one.first_message}`

const hitLine = ({ summary, chunk, score, stale, locator }: FoundConversation) =>
  `${score === null ? "  —  " : score.toFixed(3)}  ${line(summary)}  ` +
  `(messages ${chunk.firstMessageId}–${chunk.lastMessageId})${locator ? `  ${locator}` : ""}${stale ? "  stale" : ""}`

const readinessLine = ({ chat, state, graph, pending, vectors }: ChatReadiness, model: string) =>
  graph === null
    ? `${chat}  ${state} — \`conversations links rebuild --chat ${chat}\``
    : `${chat}  ${state}  built ${graph.builtAt.slice(0, 16).replace("T", " ")}, rules v${graph.rulesVersion}` +
      `${graph.outdatedRules ? " (outdated)" : ""} · not in the build: ${pending.new} new, ${pending.edited} edited, ` +
      `${pending.deleted} deleted · ${model}: ${vectors.current} current, ${vectors.stale} stale, ` +
      `${vectors.missing} missing of ${vectors.chunks} chunks`

/** `search conversations`: the conversations nearest to a query, in meaning and in words. */
export const conversationsSearchCommand = (messenger: Messenger): Command =>
  syncOptions(
    boundOptions(
      withModelOptions(
        reachesOtherService(
          annotate(new Command("conversations"), { output: { entity: "conversation_hit" }, effects: REMOTE_READ }),
        ),
      ),
    ),
    messenger,
  )
    .summary("find conversations by words and meaning")
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
      "--catch-up",
      "first build and embed, on this machine, the chats in scope that changed or were never built — within " +
        "--max-chats and --max-chunks",
    )
    .action(async function (this: Command, query: string) {
      const options = this.opts<
        ModelOptions & {
          chat?: string
          sinceTime?: string
          catchUp?: boolean
          filter?: string
          source?: string
          timezone?: string
        } & BoundOptions
      >()
      const { chat, sinceTime: since } = options
      const context = messengerContext(this, messenger)
      const model = choiceOf(options, messenger, context)
      refuseRemoteQuery(model, messenger.app, context.env)
      if (options.catchUp) {
        if (options.filter !== undefined || options.source !== undefined)
          throw new CliError(
            "validation_error",
            "--catch-up cannot be combined with --filter or --source; build and embed the chosen chats separately",
          )
        localOnly(model, "--catch-up")
        refuseLocalWrite(context, messenger.app.command, EMBED_KEY)
      }
      const { limit } = context.settings
      const window = dateWindow({
        ...(since === undefined ? {} : { sinceTime: since }),
        ...(options.timezone === undefined ? {} : { zone: options.timezone }),
      })
      const { found, refreshed } = await context.withServices(async (services) => {
        const syncing = syncRequest(this, context)
        const found = await services.embeddings.search(query, {
          ...syncing,
          ...(options.catchUp
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
          ...(window.since === undefined ? {} : { since: new Date(window.since).toISOString() }),
        })
        return { found, refreshed: found.prepared }
      })
      if (refreshed) for (const note of leftNotes(refreshed, rootOf(this))) context.renderer.note(note)
      renderAnswer(
        this,
        context,
        foundConversations("search conversations", found, limit, messenger, chat, window.meta),
        () => found.hits.map((hit) => `${hitLine(hit)}\n`).join(""),
      )
      if (found.hits.length === 0 && context.format === "pretty")
        context.renderer.note(
          found.meaning === "unavailable"
            ? "nothing matches in words"
            : `nothing matches in words, nor in meaning among the chats embedded with ${found.model}`,
        )
      if (found.embeddedOnlyElsewhere.length > 0 && context.format === "pretty")
        context.renderer.note(
          `embedded only with another model: chat ${found.embeddedOnlyElsewhere.join(", ")} — give that model with --model`,
        )
    })
