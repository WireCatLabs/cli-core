import { CliError, singleLine } from "@wirecat/cli-base"
import { annotate } from "@wirecat/cli-base/commands"
import { Command } from "commander"
import { formatLocator, parseLocator } from "../../domain/locator.js"
import type { ChatKind, Contact, Message, PersonCard } from "../../domain/models.js"
import { renderMessages } from "../../render/messages.js"
import { pickPerson } from "../../resolve.js"
import type { SearchFound } from "../../services/messages.js"
import { searchStore } from "../../services/messages-archive-search.js"
import type { MessageStore, StoredHit } from "../../store/store.js"
import { REMOTE_READ } from "../effects.js"
import { itemOf, listOf, renderAnswer, snakeKeys } from "../envelope.js"
import { messageItem } from "../messenger/message-items.js"
import { positiveCount } from "../paging.js"
import { asFirstWord } from "../profile.js"
import { type BotContext, botContext } from "./context.js"
import { botExamples } from "./examples.js"
import { botCan } from "./messages.js"
import type { BotMessenger } from "./port.js"
import { ChatRegistry, registryProfiles } from "./registry.js"

/** What "common chats" rests on: who has written where in this copy, not who is a member. */
const BASIS = "messages seen"

/** What a read may reach beyond this bot: `--all-bots`, or `--bots` naming some (max-cli, 2026-09-29). */
export interface Across {
  allBots?: boolean
  bots?: string[]
}

type PeopleScope = { account: string } | { accounts: string[] }

/**
 * This bot's copy, or — when the command asks and `read_other_bots` allows — other bots' copies too.
 * Identities are per provider, so a person is the same in all of them.
 */
const scopeOf = (context: BotContext, bot: BotMessenger, across: Across = {}) => {
  const own = context.registry.botId()
  const asked = across.allBots === true || (across.bots?.length ?? 0) > 0
  if (!asked) {
    if (!own) {
      throw new CliError(
        "not_found",
        `nothing is recorded for this bot on this machine — run \`${context.words} messages list <chat>\` once`,
      )
    }
    return { filter: { account: context.copy.accountOf(own) }, people: { account: own } as PeopleScope }
  }
  const { profile } = context
  const allowed = context.settings.readOtherBots
  const fix = `${bot.app.command} ${asFirstWord(profile)}config set --bot read_other_bots true, or a list of bots`
  if (allowed === false) {
    throw new CliError(
      "permission_error",
      `profile ${profile} may not read other bots' copies (read_other_bots is off, from the ` +
        `${context.settings.sources.readOtherBots}) — to allow it: ${fix}`,
    )
  }
  const named = across.allBots
    ? allowed === true
      ? registryProfiles(bot.app, context.env)
      : [...allowed]
    : (across.bots ?? [])
  if (allowed !== true) {
    const refused = named.filter((name) => !allowed.includes(name))
    if (refused.length > 0) {
      throw new CliError(
        "permission_error",
        `profile ${profile} may read only ${allowed.join(", ") || "no other bot"} (read_other_bots) — not ${refused.join(", ")}`,
      )
    }
  }
  const ids = named
    .filter((name) => name !== profile)
    .flatMap((name) => {
      const id = new ChatRegistry(bot.app, name, context.env).botId()
      if (id) return [id]
      if (across.allBots) return []
      throw new CliError("not_found", `nothing is recorded for bot ${name} on this machine`)
    })
  const accounts = [...new Set([...(own ? [own] : []), ...ids])]
  return { filter: { provider: bot.provider, accounts }, people: { accounts } as PeopleScope }
}

/** `--all-bots` and `--bots`, on every command that reads the copy by person or text. */
const acrossOptions = (command: Command): Command =>
  command
    .option("--all-bots", "also read every other bot's copy on this machine that read_other_bots allows")
    .option(
      "--bots <profiles>",
      "also read these bots' copies, comma separated — each allowed by read_other_bots",
      (value) =>
        value
          .split(",")
          .map((name) => name.trim())
          .filter(Boolean),
    )

const resolve = async (store: MessageStore, bot: BotMessenger, references: string[], scope: PeopleScope) => {
  const people = await store.people.people(bot.provider, scope)
  return references.map((reference) => pickPerson(reference, people))
}

/** Two bots in one group keep a copy each; the reader wants the message once. */
const once = <T extends Message>(messages: T[]): T[] => {
  const seen = new Set<string>()
  return messages.filter((message) => {
    const key = `${message.chatId} ${message.id}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

const byTime = (a: Message, b: Message) => a.timestamp.localeCompare(b.timestamp)

const messagesText = (context: BotContext, bot: BotMessenger, messages: Message[]) =>
  renderMessages(messages, {
    verbosity: context.settings.detail,
    color: context.color,
    profile: context.profile,
    provider: bot.provider,
    locale: bot.app.locale,
  })

/** Telegram's ids say it: a person is positive, a group negative. */
const kindByNumber = (hit: StoredHit): ChatKind => (hit.chatId.startsWith("-") ? "group" : "dialog")

const nameLine = (person: Contact) =>
  singleLine(
    [person.name ?? "(no name)", person.username && `@${person.username}`, person.id].filter(Boolean).join("  "),
  )

const cardOf = async (
  store: MessageStore,
  context: BotContext,
  bot: BotMessenger,
  who: string,
  across: Across,
  limit: number,
) => {
  const { filter, people } = scopeOf(context, bot, across)
  const [person] = (await resolve(store, bot, [who], people)) as [Contact]
  const rows = (await store.messages.find({ ...filter, senders: [person.id], perChat: true, limit: 1 })).items
  const latest = rows.filter((hit, index) => rows.findIndex((other) => other.chatId === hit.chatId) === index)
  const kindOf = bot.chatKindOf ?? kindByNumber
  const dialogs = latest.filter((hit) => kindOf(hit) === "dialog")
  const pages = await Promise.all(
    dialogs.map(async (hit) => {
      const { account } = parseLocator(hit.locator)
      const page = await store.messages.messages({ provider: bot.provider, account }, hit.chatId, { limit })
      return page.items.map((message) => ({
        ...message,
        locator: formatLocator({ provider: bot.provider, account, chat: message.chatId, message: message.id }),
      }))
    }),
  )
  const messages = pages.flat().toSorted(byTime)
  const card: PersonCard & { messages: (Message & { locator: string })[] } = {
    ...person,
    chats: latest.map((hit) => ({
      id: hit.chatId,
      title: hit.chatTitle,
      kind: kindOf(hit),
      lastMessageAt: hit.timestamp,
    })),
    messages: messages.slice(-limit),
  }
  return { card, dialogs }
}

/** `bot contacts show`: one person this bot has seen write, from the local copy. */
export const botContactsCommand = (bot: BotMessenger): Command => {
  const command = new Command("contacts")
    .description(
      `people this bot has seen write — from the local copy on this machine, never asking ${bot.name ?? "the messenger"} unless told to`,
    )
    .summary("the people this bot has seen write, from the local copy")
  acrossOptions(
    annotate(command.command("show"), { effects: REMOTE_READ, examples: botExamples(bot, "contacts show @ann") }),
  )
    .argument("<who>", "an id, @username or part of a name")
    .option("--limit <n>", "how many messages from the private chat", positiveCount("--limit"))
    .option("--sync-first", "read the private chat with them again from the messenger first — one request")
    .description(
      "one person: the chats they wrote in (with their last message there) and the latest messages of their " +
        "private chat with the bot",
    )
    .summary("one person: the chats they wrote in and their chat with the bot")
    .action(async function (this: Command, who: string, options: Across & { syncFirst?: boolean; limit?: number }) {
      const context = botContext(this, bot)
      const across = { allBots: options.allBots === true, bots: options.bots ?? [] }
      const limit = options.limit ?? context.settings.limit
      const read = () => context.copy.read((store) => cardOf(store, context, bot, who, across, limit))
      await context.run(async (events) => {
        let { card, dialogs } = await read()
        if (options.syncFirst) {
          if (context.settings.offline)
            throw new CliError("validation_error", "--sync-first asks the messenger; drop --offline")
          const adapter = await context.authenticated({ events })
          const history = botCan(adapter, "history", bot, "read a chat back")
          const self = context.registry.botId()
          const ours = dialogs.find((hit) => self && parseLocator(hit.locator).account === self)
          if (!self || !ours) {
            context.renderer.note("no private chat with them is recorded for this bot — nothing to refresh")
          } else {
            const fresh = await history(ours.chatId, { limit: Math.min(limit, 100) })
            await context.copy.keep(self, fresh, "history", context.renderer.warn, adapter.senders?.())
            ;({ card } = await read())
          }
        }
        const { messages, ...person } = card
        const chats = card.chats.map(
          (chat) => `  ${chat.id}  ${chat.kind}  ${singleLine(chat.title ?? "")}  ${chat.lastMessageAt ?? ""}`,
        )
        renderAnswer(
          this,
          context,
          itemOf({
            ...(snakeKeys(person) as object),
            messages: messages.map((message) => messageItem(message, context.copy.accountOf(""))),
          }),
          () => [nameLine(card), ...chats, "", messagesText(context, bot, card.messages)].join("\n"),
        )
      })
    })
  return command
}

const search = (
  context: BotContext,
  bot: BotMessenger,
  text: string,
  from: string[],
  options: Across & { newest?: boolean; limit?: number; offset?: number },
): Promise<SearchFound> => {
  if (text.trim() === "" && from.length === 0) {
    throw new CliError("validation_error", "say what to find: some text, or who wrote it with --from")
  }
  const { people } = scopeOf(context, bot, options)
  const own = context.registry.botId()
  if (!own)
    throw new CliError(
      "not_found",
      `nothing is recorded for this bot on this machine — run \`${context.words} messages list <chat>\` once`,
    )
  const accounts = ("account" in people ? [people.account] : people.accounts).map(context.copy.accountOf)
  return context.copy.read(async (store) => {
    const senders = (await resolve(store, bot, from, people)).map(({ id }) => ({ provider: bot.provider, id }))
    return searchStore(store, context.copy.accountOf(own), {
      ...(text.trim() === "" ? {} : { text }),
      accounts,
      ...(senders.length > 0 ? { senders } : {}),
      limit: options.limit ?? context.settings.limit,
      ...(options.offset ? { offset: options.offset } : {}),
      newest: options.newest === true,
    })
  })
}

/** `bot search messages`: the messages this bot's local copy holds. */
export const botSearchCommand = (bot: BotMessenger): Command => {
  const group = new Command("search").description("find what this bot's local copy holds, by text")
  acrossOptions(
    annotate(group.command("messages"), {
      effects: REMOTE_READ,
      examples: botExamples(bot, "search messages refund", "search messages invoice --from @ann"),
    }),
  )
    .argument("[query...]", "the words to find")
    .option("--limit <n>", "how many", positiveCount("--limit"))
    .option("--page <n>", "which page, starting at 1", positiveCount("--page"))
    .option("--newest", "newest first instead of best first")
    .option(
      "--from <who>",
      "only what this person wrote — an id, @username or part of a name; repeat it for any of several",
      (value: string, previous: string[] = []) => [...previous, value],
    )
    .description(
      "search the messages this bot has read, sent or received on this machine — the local copy only, best " +
        'match first; a Lucene query: every word must appear; "a phrase", -word, a OR b, from: chat: date: has:; ' +
        "by text, by --from, or both",
    )
    .summary("search the messages this bot has seen, in the local copy, by text")
    .action(async function (
      this: Command,
      query: string[],
      options: Across & { from?: string[]; newest?: boolean; limit?: number; page?: number },
    ) {
      const context = botContext(this, bot)
      const limit = options.limit ?? context.settings.limit
      const page = options.page ?? 1
      await context.run(async () => {
        const found = await search(context, bot, query.join(" "), options.from ?? [], {
          ...options,
          limit,
          offset: (page - 1) * limit,
        })
        renderAnswer(
          this,
          context,
          listOf("bot search messages", {
            items: found.items.map((hit) => messageItem(hit, context.copy.accountOf(""))),
            limit,
            page,
            has_more: found.hasMore,
            args: {
              query: query.join(" "),
              ...(options.from ? { from: options.from } : {}),
              ...(options.newest ? { newest: true } : {}),
            },
          }),
          () => messagesText(context, bot, found.items),
        )
      })
    })
  return group
}

/** `bot messages between`, over the local copy, added to the shared `messages` group. */
export const addBotCopyReads = (messages: Command, bot: BotMessenger): void => {
  acrossOptions(
    annotate(messages.command("between"), {
      effects: REMOTE_READ,
      examples: botExamples(bot, "messages between @ann @bob"),
    }),
  )
    .argument("<people...>", "two or more people — an id, @username or part of a name each")
    .option("--limit <n>", "how many of the latest messages from each chat", positiveCount("--limit"))
    .description(
      "what two or more people wrote in the chats they have all written in — from the local copy, grouped by " +
        "chat, oldest first; --limit counts per chat. Common chats are the ones this copy saw each of them " +
        `write in, not a member list from ${bot.name ?? "the messenger"}`,
    )
    .summary("what two or more people wrote in the chats they share, from the local copy")
    .action(async function (this: Command, references: string[], options: Across & { limit?: number }) {
      const context = botContext(this, bot)
      if (references.length < 2) throw new CliError("validation_error", "name at least two people")
      const limit = options.limit ?? context.settings.limit
      await context.run(async () => {
        const { filter, people } = scopeOf(context, bot, options)
        const page = await context.copy.read(async (store) => {
          const senders = (await resolve(store, bot, references, people)).map(({ id }) => id)
          return store.messages.find({ ...filter, senders, together: true, perChat: true, limit })
        })
        const chats = new Map<string, { id: string; title: string | null; messages: StoredHit[] }>()
        for (const hit of once(page.items)) {
          const chat = chats.get(hit.chatId) ?? { id: hit.chatId, title: hit.chatTitle, messages: [] }
          chat.messages.push(hit)
          chats.set(hit.chatId, chat)
        }
        const grouped = [...chats.values()].map((chat) => ({
          ...chat,
          messages: chat.messages.toSorted(byTime).slice(-limit),
        }))
        const blocks = grouped.map(
          (chat) => `${chat.id}  ${singleLine(chat.title ?? "")}\n${messagesText(context, bot, chat.messages)}`,
        )
        renderAnswer(
          this,
          context,
          itemOf(
            {
              basis: BASIS,
              chats: grouped.map(({ id, title, messages }) => ({
                id,
                title,
                messages: messages.map((hit) => messageItem(hit, context.copy.accountOf(""))),
              })),
            },
            page.hasMore ? { meta: { truncated: true } } : {},
          ),
          () => blocks.join("\n\n"),
        )
      })
    })
}
