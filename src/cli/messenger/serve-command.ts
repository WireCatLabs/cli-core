import { CliError } from "@wirecat/cli-base"
import { annotate } from "@wirecat/cli-base/commands"
import { Command } from "commander"
import { holdLock, lockPath, releaseLock, takeLock } from "../../background/lock.js"
import type { ChatKind, Message, MessageEvent } from "../../domain/models.js"
import { failureKey } from "../../errors/failures.js"
import type { MessengerAdapter } from "../../ports/messenger.js"
import { senderFacts } from "../../replies/dry-run.js"
import { replyRenderer } from "../../replies/rendering.js"
import { audienceWarnings, readReplies, repliesPathFor } from "../../replies/rules.js"
import { NO_RULES, type Replied, replyTo } from "../../replies/serve.js"
import { repliesStatePathFor } from "../../replies/state.js"
import { levelFor } from "../../sends/permissions.js"
import { newSendId } from "../../sends/send-id.js"
import { onlineDeps } from "../../services/deps.js"
import { servicesFor } from "../../services/index.js"
import { applyTaskRulesOnArrival, openRequestTask } from "../../services/task-rules.js"
import { REMOTE_WRITE } from "../effects.js"
import { itemOf, renderAnswer } from "../envelope.js"
import { recalledAccount } from "./accounts.js"
import { type Messenger, type MessengerContext, messengerContext } from "./context.js"
import { memberFetches } from "./serve-members.js"
import { noticeFor, recordDiagnostics, type ServeNotice } from "./serve-notice.js"
import { serveRelay } from "./serve-relay.js"
import { stemFills } from "./serve-stems.js"
import { listenUntilStopped } from "./watch-command.js"

export { type Lock, lockPath, readLock, servingProfiles } from "../../background/lock.js"

/**
 * Keeps the store current: every new message, edit, deletion and reaction, and on start what arrived
 * while nothing listened. **One per profile**, held by a lock file; a lock whose process is gone is
 * taken over. Started by a person, a service unit or `server start` — never by itself (NEED-9).
 */
export const serveCommand = (messenger: Messenger): Command => {
  const command = annotate(new Command("serve"), { effects: REMOTE_WRITE, lifetime: "persistent" }).description(
    "keep the local store current until stopped — what a systemd or launchd unit runs",
  )

  command.action(async function (this: Command) {
    const relay =
      messenger.connection === "exclusive" && process.platform !== "win32" ? serveRelay(this, messenger) : undefined
    const context = recordDiagnostics(messengerContext(this, relay?.messenger ?? messenger), messenger.app)
    const warn = noticeFor(context, messenger.app)
    const note = noticeFor(context, messenger.app, "info")
    if (context.settings.offline) throw new CliError("validation_error", "serve listens live; --offline cannot")
    const path = lockPath(messenger.app, context.profile, context.env)
    const startedAt = new Date().toISOString()
    const { version } = messenger.app
    const held = takeLock(path, { pid: process.pid, startedAt, version })
    if (held) {
      throw new CliError(
        "validation_error",
        `${messenger.app.command} serve is already running for profile ${context.profile} (PID ${held.pid}, since ${held.startedAt})`,
      )
    }
    let relaying: Promise<void> | undefined
    // `server start` answers on this, not on the lock alone: a lock is written before the connection opens.
    const onReady = () => {
      const listening = { pid: process.pid, startedAt, version, listeningAt: new Date().toISOString() }
      holdLock(path, listening)
      note({
        code: "listening",
        text: `listening for profile ${context.profile}, catching up on what arrived while it was down`,
      })
      if (!relay || relaying) return
      relaying = relay
        .open(path, context.profile)
        .then((address) => {
          if (address) holdLock(path, { ...listening, relay: address })
        })
        .catch((error) => {
          const errorCode = failureKey(error)
          warn({ code: "relay_failed", errorCode, text: `commands cannot run through this serve: ${errorCode}` })
        })
    }

    const counts: Record<string, number> = {}
    const rules = replying(context, messenger, Date.parse(startedAt))
    const tasks = tasking(context, warn)
    const count = (event: MessageEvent) => {
      counts[event.event] = (counts[event.event] ?? 0) + 1
      if (event.event === "message") {
        rules.arrived(event.message)
        tasks.arrived(event.message)
      }
      relay?.arrived(event)
    }
    let connection: MessengerAdapter | undefined
    const members = memberFetches({
      withStore: (work) => context.withStore(work, { name: "serve members" }),
      fetch: (store, account, chatId) =>
        servicesFor({
          ...onlineDeps(messenger, connection as MessengerAdapter, context.guard, {
            profile: context.profile,
            env: context.env,
          }),
          store: async () => store,
          account: async () => account,
        }).chats.fetchMembers(chatId, {}),
      warn,
    })
    const stems = stemFills({
      withStore: (work) => context.withStore((store) => work(store), { name: "serve stems" }),
      warn,
    })
    try {
      await listenUntilStopped(this, context, relay?.messenger ?? messenger, count, {
        stop: new AbortController(),
        catchUp: true,
        onReady,
        connected: (open) => {
          connection = open
          rules.connected(open)
          members.start()
          stems.start()
        },
      })
    } finally {
      await relaying
      await relay?.close()
      rules.stop()
      await members.stop()
      await stems.stop()
      await rules.settled()
      await tasks.settled()
      releaseLock(path)
    }
    // `kept` and the reply counts are keyed by event names and rule ids, never camelCased.
    renderAnswer(
      this,
      context,
      itemOf({
        profile: context.profile,
        started_at: startedAt,
        stopped_at: new Date().toISOString(),
        kept: counts,
        ...rules.summary(),
        ...(members.summary().fetched + members.summary().failed > 0 ? { members: members.summary() } : {}),
        ...(stems.summary().stemmed > 0 ? { stems: stems.summary() } : {}),
        ...tasks.summary(),
      }),
    )
  })

  return command
}

/**
 * The reply rules, one message at a time in the order they came: two at once would both read the
 * limits before either counted its reply.
 */
const NO_REPLIES = {
  connected: (_open: MessengerAdapter) => {},
  arrived: (_message: Message) => {},
  settled: () => Promise.resolve(),
  stop: () => {},
  summary: () => ({}),
}

const replying = (context: MessengerContext, messenger: Messenger, since: number) => {
  if (messenger.autoReplies === false) return NO_REPLIES
  const controller = new AbortController()
  const { app, provider } = messenger
  const { profile, env, settings, renderer } = context
  let connection: MessengerAdapter | undefined
  let queue = Promise.resolve()
  const sent: Record<string, number> = {}
  const skipped: Record<string, number> = {}
  const tasks: Record<string, number> = {}
  const chats = new Map<string, Promise<{ id: string; kind: ChatKind }>>()
  const owner = recalledAccount(app, provider, profile, env)?.account ?? null
  // A file that does not read is said on each message instead; it must not stop serve.
  try {
    const { rules, audience } = readReplies(repliesPathFor(app, profile, env), provider)
    if (rules.length > 0) for (const warning of audienceWarnings(audience)) renderer.warn(warning)
  } catch {}

  const handle = async (message: Message) => {
    if (connection === undefined || controller.signal.aborted) return
    const open = connection
    const answer: Replied = await replyTo(
      {
        rulesPath: repliesPathFor(app, profile, env),
        statePath: repliesStatePathFor(app, profile, env),
        provider,
        owner: { id: owner },
        since,
        allowed: () => levelFor(settings.permissions ?? {}, "replies.send").level === "allow",
        chatOf: (chat) => {
          if (!chats.has(chat))
            chats.set(
              chat,
              open.resolve(chat).then(({ id, kind, title }) => ({ id, kind, title })),
            )
          return chats.get(chat) as Promise<{ id: string; kind: ChatKind }>
        },
        senderOf: (person) =>
          context.withStore(
            async (store, account) => {
              const { isContact, botOf } = await senderFacts(store, account)
              return { isBot: (await botOf(person)) === true, isContact: isContact(person) }
            },
            { name: "serve replies" },
          ),
        send: (reply) =>
          servicesFor(onlineDeps(messenger, open, context.guard, { profile, env })).messages.send({
            chat: reply.chat,
            text: reply.text,
            sendId: reply.sendId,
            key: "replies.send",
            origin: reply.origin,
            ...(reply.replyTo === undefined ? {} : { replyTo: reply.replyTo }),
          }),
        newSendId: () => open.newSendId?.() ?? newSendId(),
        render: replyRenderer(app, profile, () => messenger.resolveSettings({ profile }, { env }), env, renderer.warn, {
          ai: true,
          signal: controller.signal,
        }),
        openTask: (arrived) =>
          context.withStore((store, account) => openRequestTask(store, account, arrived), { name: "serve replies" }),
      },
      message,
    )
    if (answer.task !== undefined) tasks[answer.task] = (tasks[answer.task] ?? 0) + 1
    if ("sent" in answer) sent[answer.sent] = (sent[answer.sent] ?? 0) + 1
    else if (answer.skip !== NO_RULES) skipped[answer.skip] = (skipped[answer.skip] ?? 0) + 1
  }

  return {
    connected: (open: MessengerAdapter) => {
      connection = open
    },
    arrived: (message: Message) => {
      if (message.outgoing !== false) return
      queue = queue.then(() =>
        handle(message).catch((error) => {
          const errorCode = failureKey(error)
          noticeFor(context, app)({ code: "reply_rule_failed", errorCode, text: `a reply rule failed: ${errorCode}` })
        }),
      )
    },
    settled: () => queue,
    stop: () => controller.abort(),
    summary: () =>
      Object.keys(sent).length + Object.keys(skipped).length + Object.keys(tasks).length === 0
        ? {}
        : { replies: { sent, skipped, ...(Object.keys(tasks).length === 0 ? {} : { tasks }) } },
  }
}

/** The task rules over each message as it arrives, the owner's too — an answer closes a task. In order, one at a time. */
const tasking = (context: MessengerContext, warn: (notice: ServeNotice) => void) => {
  let queue = Promise.resolve()
  const total = { added: 0, closed: 0, review: 0 }
  return {
    arrived: (message: Message) => {
      queue = queue.then(() =>
        context
          .withStore((store, account) => applyTaskRulesOnArrival(store, account, message), { name: "serve tasks" })
          .then(({ added, closed, review }) => {
            total.added += added
            total.closed += closed
            total.review += review
          })
          .catch((error) => {
            const errorCode = failureKey(error)
            warn({ code: "task_rule_failed", errorCode, text: `a task rule failed: ${errorCode}` })
          }),
      )
    },
    settled: () => queue,
    summary: () => (total.added + total.closed === 0 ? {} : { tasks: total }),
  }
}
