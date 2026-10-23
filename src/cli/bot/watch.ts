import { CliError } from "@wirecat/cli-base"
import { annotate } from "@wirecat/cli-base/commands"
import { Command } from "commander"
import type { Message, MessageHit } from "../../domain/models.js"
import { portOf, publicUrlOf } from "../../http/public-url.js"
import { renderMessages } from "../../render/messages.js"
import { environmentOf } from "../context.js"
import { REMOTE_WRITE } from "../effects.js"
import { withoutProviderRefs } from "../provider-refs.js"
import { type BotContext, botContext, online } from "./context.js"
import { botCan, botIdOf } from "./messages.js"
import type { BotEvent, BotMessenger, BotNotice } from "./port.js"
import { botFiles } from "./registry.js"
import { PressLog, UpdatesCursor } from "./updates.js"
import { receiveWebhooks, WEBHOOK_PORT } from "./webhook-receiver.js"

/** Under Telegram's transport timeout of 30 s, so a quiet poll ends as an answer, not as a failure. */
const WAIT_SECONDS = 25
const FIRST_RETRY_MS = 1_000
const LONGEST_RETRY_MS = 60_000
/** Waiting cannot help these: the token, the profile's rules or the request itself is wrong. */
const FINAL = new Set(["authentication_error", "permission_error", "validation_error", "configuration_error"])
const CHAT_ID = /^-?\d+$/

const pause = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms)
    function done() {
      clearTimeout(timer)
      signal.removeEventListener("abort", done)
      resolve()
    }
    signal.addEventListener("abort", done, { once: true })
  })

const messagesOf = (events: readonly BotEvent[]): Message[] =>
  events.flatMap((event) => (event.event === "message" || event.event === "edit" ? [event.message] : []))

const chatOf = (event: BotEvent): string | null => {
  if (event.event === "message" || event.event === "edit") return event.message.chatId
  return event.chatId
}

const who = (person: { name: string | null; username: string | null } | null) =>
  person ? ` by ${person.name ?? (person.username ? `@${person.username}` : "someone")}` : ""

const noticeLine = (notice: BotNotice, title: (chatId: string | null) => string): string => {
  switch (notice.event) {
    case "callback":
      return `button pressed${who(notice.from)} in ${title(notice.chatId)}: ${notice.data} (callback ${notice.callbackId})\n`
    case "joined":
    case "left":
    case "added":
    case "removed":
      return `${notice.event}${who(notice.person)} in ${title(notice.chatId)}\n`
    case "started":
      return `bot started${who(notice.person)}\n`
    case "other":
      return `${notice.type} in ${title(notice.chatId)}\n`
  }
}

/**
 * Keeps a batch before it is printed: the messages in the copy, the button presses for `callbacks
 * answer`, and what the CLI keeps itself. `false` holds the cursor, so the batch comes again.
 */
const keep = async (
  command: Command,
  context: BotContext,
  bot: BotMessenger,
  botId: string,
  events: BotEvent[],
  senders: Parameters<BotContext["copy"]["keep"]>[4],
) => {
  const warn = context.renderer.warn
  if (!(await context.copy.keep(botId, messagesOf(events), "update", warn, senders))) return false
  for (const event of events) {
    if (
      event.event === "delete" &&
      event.chatId &&
      !(await context.copy.forget(botId, event.chatId, [event.messageId], warn))
    )
      return false
  }
  try {
    new PressLog(botFiles(bot.app, context.profile, context.env).presses).add(
      events.flatMap((event) =>
        event.event === "callback" && event.chatId && event.messageId
          ? [{ callbackId: event.callbackId, chatId: event.chatId, messageId: event.messageId }]
          : [],
      ),
    )
    bot.keepUpdates?.(command, context.profile, events)
    return true
  } catch (error) {
    warn(`the updates were not kept: ${error instanceof Error ? error.message : String(error)}`)
    return false
  }
}

/**
 * `bot watch`: what happens in the bot's chats, as it arrives, until Ctrl-C or `--timeout` — both a
 * normal end. Each batch is kept before it is printed, and the cursor moves only after that: an end
 * at any moment never loses a batch. An update the messenger names by id is recorded and skipped when it
 * comes again after being handled; one without an id may print twice. A read: it changes nothing anyone sees.
 * With `--public-url` the messenger pushes each batch to a local receiver behind the owner's tunnel
 * instead, and a batch is acknowledged only once kept, so the messenger sends again what was not.
 */
export const botWatchCommand = (bot: BotMessenger): Command =>
  annotate(new Command("watch"), { effects: REMOTE_WRITE, lifetime: "persistent" })
    .description("print new messages as they arrive and keep them, until Ctrl-C or --timeout (either ends it normally)")
    .option(
      "--events",
      "also edits, deletions, buttons pressed and people coming and going; every line names its event",
    )
    .option("--types <types>", "only these update types, comma-separated, in the messenger's words")
    .option(
      "--public-url <url>",
      "receive by webhook at your tunnel's https address instead of polling, e.g. https://<name>.ts.net",
    )
    .option("--port <port>", `the local port behind the tunnel for --public-url (default ${WEBHOOK_PORT})`)
    .action(async function (this: Command) {
      const flags = this.opts<{ events?: boolean; types?: string; publicUrl?: string; port?: string }>()
      const { events: everything, types: typed } = flags
      const context = online(botContext(this, bot), this)
      if (context.format === "json") {
        throw new CliError("validation_error", "watch is a stream — use --jsonl for one update per line")
      }
      if (flags.port !== undefined && flags.publicUrl === undefined)
        throw new CliError("validation_error", "--port is the local port behind --public-url; give both")
      const publicUrl =
        flags.publicUrl === undefined
          ? undefined
          : publicUrlOf(flags.publicUrl, {
              missing: "--public-url",
              reaches: `${bot.name ?? "the messenger"} delivers the bot's updates`,
            })
      const port = portOf(flags.port, WEBHOOK_PORT)
      const types = typed
        ?.split(",")
        .map((one) => one.trim())
        .filter(Boolean)

      const stop = new AbortController()
      const given = environmentOf(this).signal
      const end = () => stop.abort()
      given?.addEventListener("abort", end, { once: true })
      const signals = given ? [] : (["SIGINT", "SIGTERM"] as const)
      for (const name of signals) process.on(name, end)
      const closed = (error: NodeJS.ErrnoException) => {
        if (error.code === "EPIPE") end()
      }
      if (!given) process.stdout.on("error", closed)
      const timeoutMs = context.settings.commandTimeoutMs
      const timer = timeoutMs === undefined ? undefined : setTimeout(end, timeoutMs)

      const title = (chatId: string | null) =>
        chatId === null ? "a chat" : (context.registry.list().find((chat) => chat.id === chatId)?.title ?? chatId)
      const hit = (message: Message): MessageHit => ({ ...message, chatTitle: title(message.chatId) })
      const print = (event: BotEvent) => {
        if (!everything && event.event !== "message") return
        if (context.format === "jsonl") {
          context.streams.data(
            JSON.stringify(withoutProviderRefs(everything ? event : hit((event as { message: Message }).message))),
          )
          return
        }
        if (event.event === "message" || event.event === "edit") {
          const rendered = renderMessages([event.message], {
            color: context.color,
            verbosity: context.settings.detail,
            senderColors: context.settings.senderColors,
            profile: context.profile,
            provider: bot.provider,
            locale: bot.app.locale,
          })
          context.streams.data(
            `${event.event === "edit" ? "edited — " : ""}${title(event.message.chatId)}\n${rendered}`,
          )
        } else if (event.event === "delete") {
          context.streams.data(`deleted in ${title(event.chatId)}: message ${event.messageId}\n`)
        } else if (event.event === "reaction" || event.event === "person_reaction") {
          context.streams.data(`reactions in ${title(event.chatId)} on message ${event.messageId}\n`)
        } else if (event.event === "vote") {
          context.streams.data(`vote in ${title(event.chatId)} on poll ${event.messageId}\n`)
        } else if (event.event === "star") {
          context.streams.data(
            `${event.starred ? "starred" : "unstarred"} in ${title(event.chatId)}: message ${event.messageId}\n`,
          )
        } else if (event.event === "delivery") {
          context.streams.data(`${event.delivery} in ${title(event.chatId)}: message ${event.messageId}\n`)
        } else if (event.event === "chat_event") {
          context.streams.data(`${event.change.event} in ${title(event.chatId)}\n`)
        } else context.streams.data(noticeLine(event, title))
      }

      try {
        await context.run(
          async (events) => {
            const adapter = await context.authenticated({ events, stop: stop.signal })
            const warn = context.renderer.warn
            /** Keeps, prints and settles one batch; `false` when it was not kept and must come again. */
            const take = async (botId: string, batch: BotEvent[]): Promise<boolean> => {
              const handled = await context.copy.received(botId, batch, warn)
              const fresh = batch.filter((event) => !(event.update && handled.has(event.update.id)))
              if (fresh.length > 0 && !(await keep(this, context, bot, botId, fresh, adapter.senders?.()))) {
                await context.copy.settle(botId, fresh, "not_kept", warn)
                return false
              }
              for (const event of fresh) print(event)
              await context.copy.settle(botId, fresh, null, warn)
              const seen = [...new Set(batch.flatMap((event) => chatOf(event) ?? []))].filter((id) => CHAT_ID.test(id))
              if (seen.length > 0) context.registry.observe(seen.map((id) => ({ id })))
              return true
            }

            if (publicUrl) {
              const intake = {
                webhookHandshake: botCan(adapter, "webhookHandshake", bot, "receive its updates by webhook"),
                webhookAuthentic: botCan(adapter, "webhookAuthentic", bot, "receive its updates by webhook"),
                webhookEvents: botCan(adapter, "webhookEvents", bot, "receive its updates by webhook"),
              }
              const botId = await botIdOf(context, adapter)
              const wanted = (event: BotEvent) =>
                !types || (event.update !== undefined && types.includes(event.update.kind))
              await receiveWebhooks({
                intake,
                publicUrl,
                port,
                take: (batch) => take(botId, batch.filter(wanted)),
                signal: stop.signal,
                warn,
                listening: (local) =>
                  context.renderer.note(
                    `receiving at ${publicUrl.origin} through ${local.host} — the tunnel must forward there; Ctrl-C to stop`,
                  ),
              })
              return
            }

            const poll = botCan(adapter, "updates", bot, "take updates")
            if (adapter.webhooks && (await adapter.webhooks()).length > 0) {
              throw new CliError(
                "validation_error",
                `this bot gets its updates by webhook, and ${bot.name ?? "the messenger"} gives polling nothing while one ` +
                  `is set — \`${context.words} webhooks list\` shows it`,
              )
            }
            const botId = await botIdOf(context, adapter)
            const cursor = new UpdatesCursor(botFiles(bot.app, context.profile, context.env).updates)
            let at = cursor.read()
            let failures = 0
            const retry = async (reason: string) => {
              failures += 1
              const ms = Math.min(LONGEST_RETRY_MS, FIRST_RETRY_MS * 2 ** (failures - 1))
              context.renderer.warn(`${reason} — trying again in ${Math.round(ms / 1000)} s`)
              await pause(ms, stop.signal)
            }
            context.renderer.note("listening — Ctrl-C to stop")

            while (!stop.signal.aborted) {
              let page: Awaited<ReturnType<typeof poll>>
              try {
                page = await poll(at, { ...(types ? { types } : {}), waitSeconds: WAIT_SECONDS, signal: stop.signal })
              } catch (error) {
                if (stop.signal.aborted) break
                const code = (error as { code?: string }).code
                if (code && FINAL.has(code)) throw error
                await retry(`${bot.name ?? "the messenger"} did not answer (${code ?? "unknown"})`)
                continue
              }
              if (!(await take(botId, page.events))) {
                await retry("the updates were not kept")
                continue
              }
              failures = 0
              if (page.cursor !== undefined && page.cursor !== at) {
                at = page.cursor
                cursor.write(at)
              }
            }
          },
          { unbounded: true },
        )
      } finally {
        if (timer) clearTimeout(timer)
        for (const name of signals) process.off(name, end)
        if (!given) process.stdout.off("error", closed)
        given?.removeEventListener("abort", end)
      }
    })
