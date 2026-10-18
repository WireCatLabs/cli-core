import { CliError } from "@wirecat/cli-base"
import { annotate } from "@wirecat/cli-base/commands"
import { Command } from "commander"
import type { MessageEvent, MessageHit } from "../../domain/models.js"
import type { MessengerAdapter } from "../../ports/messenger.js"
import { renderMessages } from "../../render/messages.js"
import { environmentOf } from "../context.js"
import { REMOTE_READ } from "../effects.js"
import { withoutProviderRefs } from "../provider-refs.js"
import { type Messenger, type MessengerContext, messengerContext } from "./context.js"

/**
 * New messages as they arrive, until Ctrl-C or `--timeout` — both a normal end, exit 0: listening
 * for a minute is a complete answer. One `MessageHit` per line with `--jsonl`; `--json` is refused,
 * because a stream is not one value. Nothing is marked read.
 */
export const watchCommand = (messenger: Messenger): Command =>
  annotate(new Command("watch"), { effects: REMOTE_READ, lifetime: "persistent" })
    .description("print new messages as they arrive, until Ctrl-C or --timeout (either ends it normally)")
    .option("--events", "also edits, deletions, reactions, poll votes and chat events; every line then names its event")
    .action(async function (this: Command) {
      const events = this.opts<{ events?: boolean }>().events === true
      const context = messengerContext(this, messenger)
      if (context.format === "json") {
        throw new CliError("validation_error", "watch is a stream — use --jsonl for one message per line")
      }
      if (context.settings.offline)
        throw new CliError("validation_error", "watch listens live; --offline has nothing to wait for")

      const render = (message: MessageHit) =>
        `${message.chatTitle ?? message.chatId}\n${renderMessages([message], {
          color: context.color,
          verbosity: context.settings.detail,
          senderColors: context.settings.senderColors,
          profile: context.profile,
          provider: messenger.provider,
          locale: messenger.app.locale,
        })}`

      // Without --events the stream is bare messages, as it always was: a reader of it never meets
      // a line of another shape.
      const stop = new AbortController()
      const print = (event: MessageEvent) => {
        if (stop.signal.aborted || (!events && event.event !== "message")) return
        if (context.format === "jsonl") {
          context.streams.data(
            JSON.stringify(withoutProviderRefs(events ? event : (event as { message: MessageHit }).message)),
          )
        } else context.streams.data(describe(event, render))
      }

      await listenUntilStopped(this, context, messenger, print, { stop, pipe: true })
    })

/**
 * Listens until Ctrl-C, SIGTERM, `--timeout` or — with `pipe` — a reader that has gone away.
 * Each ends it normally. Tests hand in `signal` instead of process-wide handlers. An adapter with
 * `feed` runs it beside `watch`, so what the messenger pushes reaches the store (`stored`).
 */
export const listenUntilStopped = async (
  command: Command,
  context: MessengerContext,
  messenger: Messenger,
  onEvent: (event: MessageEvent) => void,
  {
    stop,
    pipe = false,
    catchUp = false,
    onReady = () => context.renderer.note("listening — Ctrl-C to stop"),
    connected,
  }: {
    stop: AbortController
    pipe?: boolean
    catchUp?: boolean
    onReady?: () => void
    /** The open connection, for a listener that also writes — `serve`'s reply rules. */
    connected?: (connection: MessengerAdapter) => void
  },
): Promise<void> => {
  const given = environmentOf(command).signal
  const end = () => stop.abort()
  given?.addEventListener("abort", end, { once: true })
  const signals = given ? [] : (["SIGINT", "SIGTERM"] as const)
  // `on`, not `once`: mtcute closes its storage on the signal and then sends it again, which with no
  // listener left kills the process before its `finally` — a serve's lock outlived it.
  for (const name of signals) process.on(name, end)
  // `tg watch --jsonl | head -1`: once the reader is gone, the next write fails, and that is the end.
  const closed = (error: NodeJS.ErrnoException) => {
    if (error.code === "EPIPE") end()
  }
  if (pipe && !given) process.stdout.on("error", closed)
  const timer =
    context.settings.commandTimeoutMs === undefined ? undefined : setTimeout(end, context.settings.commandTimeoutMs)
  try {
    await context.withMessenger(
      async (connection) => {
        if (!connection.watch) {
          throw new CliError("validation_error", `${messenger.app.command} cannot listen for new messages`)
        }
        connected?.(connection)
        // A feed that ends early is fine — the push is done; one that fails ends the listening too.
        const failing = (error: unknown) => {
          stop.abort()
          throw error
        }
        await Promise.all([
          connection.watch(onEvent, stop.signal, onReady).catch(failing),
          connection.feed?.(() => {}, stop.signal).catch(failing),
        ])
      },
      { listen: true, ...(catchUp ? { catchUp } : {}) },
    )
  } finally {
    if (timer) clearTimeout(timer)
    for (const name of signals) process.off(name, end)
    if (pipe && !given) process.stdout.off("error", closed)
    given?.removeEventListener("abort", end)
  }
}

const describe = (event: MessageEvent, render: (message: MessageHit) => string): string => {
  switch (event.event) {
    case "message":
      return render(event.message)
    case "edit":
      return `edited — ${render(event.message)}`
    case "delete":
      return `deleted in ${event.chatTitle ?? event.chatId ?? "a private chat or small group"}: message ${event.messageId}\n`
    case "reaction": {
      const counts = event.reactions.counts.map(({ reaction, count }) => `${reaction} ${count}`).join(", ")
      return `reactions in ${event.chatTitle ?? event.chatId} on message ${event.messageId}: ${counts || "none"}\n`
    }
    case "vote": {
      const { person, answers } = event.vote
      const choice = answers.length > 0 ? answers.join(", ") : "took it back"
      return `vote in ${event.chatTitle ?? event.chatId} on poll ${event.messageId}: ${person.name ?? person.id} — ${choice}\n`
    }
    case "star":
      return `${event.starred ? "starred" : "unstarred"} in ${event.chatTitle ?? event.chatId}: message ${event.messageId}\n`
    case "chat_event": {
      const { event: action, by, people } = event.change
      const who = people.map((one) => one.name ?? one.id).join(", ")
      return `${action} in ${event.chatTitle ?? event.chatId}${who ? `: ${who}` : ""}${by.id === null ? "" : ` — by ${by.name ?? by.id}`}\n`
    }
  }
}
