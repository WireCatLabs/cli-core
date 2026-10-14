import { CliError } from "@wirecat/cli-base"
import { annotate } from "@wirecat/cli-base/commands"
import { Command } from "commander"
import { fetchInto } from "../../services/archive.js"
import { momentOf } from "../../services/moment.js"
import { FETCH } from "../effects.js"
import { renderItem } from "../messenger/chat-answers.js"
import { stopOnSignal } from "../messenger/patience.js"
import { parseDuration } from "../settings.js"
import { botContext, online } from "./context.js"
import { botCan, botIdOf } from "./messages.js"
import type { BotMessenger } from "./port.js"

const wholeNumber = (value: string): number => {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1)
    throw new CliError("validation_error", `a whole number, 1 or more — got ${value}`)
  return parsed
}

/**
 * `bot store fetch`: a chat's history into the bot's local copy, newest to oldest and resumable, as the
 * personal `messages sync` does. Mounted for a messenger whose Bot API pages back through a chat.
 */
export const botStoreCommand = (bot: BotMessenger, fetching: NonNullable<BotMessenger["fetching"]>): Command => {
  const command = new Command("store").description("the bot's local copy on this machine")
  const fetch = annotate(command.command("fetch"), { effects: FETCH })
    .description("fetch a chat's history into the bot's local copy, newest first; run it again to continue")
    .argument("<chat>", "a chat id, or the title of a chat this bot has seen")
    .option(
      "--limit <n>",
      `at most this many messages in this run; ${fetching.maxPages * fetching.page} if not given`,
      wholeNumber,
    )
    .option("--page-size <n>", `how many messages one request asks for; ${fetching.page} if not given`, wholeNumber)
    .option("--pause <duration>", "pause between pages, to stay under the messenger's limits", fetching.pause)
    .option("--since-time <time>", "stop once it reaches messages older than this: ISO 8601, or 2h / 1d ago")
    .option("--last <n>", "stop once the newest n messages are held", wholeNumber)
  if (fetching.from) fetch.option("--from <link>", fetching.from)
  fetch.action(async function (this: Command, chat: string) {
    const options = this.opts<{
      limit?: number
      pageSize?: number
      pause: string
      sinceTime?: string
      last?: number
      from?: string
    }>()
    if (options.sinceTime !== undefined && options.last !== undefined) {
      throw new CliError("validation_error", "give --since-time or --last, not both: how far back the fetch goes")
    }
    const pauseMs = parseDuration(options.pause, "--pause")
    const sinceMs = options.sinceTime === undefined ? undefined : momentOf(options.sinceTime, "--since-time")
    const context = online(botContext(this, bot), this)
    const ref = context.chatRef(chat)
    const stop = stopOnSignal(this)
    try {
      await context.run(async (events) => {
        const adapter = await context.authenticated({
          events,
          stop: stop.signal,
          history: { pauseMs, ...(options.from === undefined ? {} : { from: options.from }) },
        })
        try {
          const page = botCan(adapter, "historyBefore", bot, "read a chat back")
          const botId = await botIdOf(context, adapter)
          const account = context.copy.accountOf(botId)
          const result = await context.copy.read((store) =>
            fetchInto({
              history: async (window) => {
                const read = await page(ref, window)
                await store.saveMessages(account, ref, read.items, { via: "history" })
                const senders = adapter.senders?.() ?? []
                if (senders.length > 0) await store.savePeople(account, senders)
                return read
              },
              store,
              account,
              fetching,
              limit: options.limit ?? fetching.maxPages * fetching.page,
              pageSize: options.pageSize ?? fetching.page,
              pauseMs,
              ...(sinceMs === undefined ? {} : { sinceMs }),
              ...(options.last === undefined ? {} : { last: options.last }),
              note: context.renderer.note,
              stop: stop.signal,
              onPage: () => {},
            }),
          )
          renderItem(this, context, result)
        } finally {
          await adapter.close()
        }
      })
    } finally {
      stop.release()
    }
  })
  return command
}
