import { CliError } from "@wirecat/cli-base"
import { annotate } from "@wirecat/cli-base/commands"
import { Command } from "commander"
import type { MessageHit } from "../../domain/models.js"
import { renderMessages } from "../../render/messages.js"
import { CHAT_KINDS } from "../../services/chats.js"
import { kindsOf } from "../../services/inbox.js"
import { modelWith } from "../../speech/hearing.js"
import { ownerOnlyOption, REMOTE_READ } from "../effects.js"
import { renderAnswer } from "../envelope.js"
import { queryHelp } from "../list-query.js"
import { positiveCount } from "../paging.js"
import { MARK_READ_OPTION, markShown, marksRead, NO_MARK_READ_OPTION, pointsOf } from "./catch-up.js"
import { catchUpQuery, INBOX_QUERY, inboxAnswer } from "./catch-up-answers.js"
import { type Messenger, messengerContext } from "./context.js"
import { hearForCommand, MODEL_OPTION, spokenItems, TRANSCRIBE_OPTION } from "./hearing-command.js"
import { viewOf } from "./message-items.js"
import { checkPoints } from "./points.js"

const FIRST_LOOK_MS = 24 * 60 * 60 * 1000

export const PARTIAL_NOTE =
  "the messenger did not list every chat, and did not say how many it left out; one may have more"

/**
 * Two questions, one command — max-cli's `inbox` (its `NEED-171`).
 *
 * **Plain `inbox` — what is unread**, as the messenger counts it. For a person.
 *
 * **`--new` — what arrived since the last check.** For a scheduled run: the point it starts from is
 * kept per chat and moved only by a run that printed, so each message shows once, and a run that
 * fails shows it again rather than never (max-cli `NEED-162`). `lastCheckAt`, the first check, stays
 * put: it is where a chat never read yet starts, so a chat skipped by one run is not lost.
 * `date>2h` is a one-off look from a time of your choosing and leaves the points where they were.
 */
export const inboxCommand = (messenger: Messenger): Command =>
  annotate(new Command("inbox"), {
    effects: REMOTE_READ,
    output: { entity: "message", view: "summary" },
    query: INBOX_QUERY,
  })
    .description("other people's unread messages in every chat; --new for what arrived since the last check")
    .addHelpText("after", queryHelp(INBOX_QUERY))
    .argument("[query...]", "from when: date>2h, date>2026-10-01; the saved point stays put")
    .option("--new", "what arrived since the last check, each message once — for scheduled runs")
    .option("--limit <n>", "at most this many per chat, the newest", positiveCount("--limit"))
    .option("--all", "muted and archived chats too — left out unless they mention you or reply to you")
    .option("--kind <kinds>", `only chats of these kinds, comma-separated: ${CHAT_KINDS.join(", ")}`)
    .option(...TRANSCRIBE_OPTION)
    .option(...MODEL_OPTION)
    .addOption(ownerOnlyOption(...MARK_READ_OPTION))
    .addOption(ownerOnlyOption(...NO_MARK_READ_OPTION))
    .action(async function (this: Command, query: string[]) {
      const {
        new: fresh,
        all,
        kind,
        transcribe,
        model,
        markRead,
      } = this.opts<{
        new?: boolean
        all?: boolean
        kind?: string
        transcribe?: boolean
        model?: string
        markRead?: boolean
      }>()
      const hearWith = modelWith(transcribe, model)
      const context = messengerContext(this, messenger)
      const { app } = messenger
      const { settings, renderer, format, env } = context
      const kinds = kind === undefined ? undefined : kindsOf(kind)
      const { since } = catchUpQuery(query, INBOX_QUERY, "inbox")
      if (fresh && since !== undefined)
        throw new CliError("validation_error", "--new keeps its own point — not with a date in the query")
      const saved =
        fresh && since === undefined
          ? checkPoints(app, {
              command: pointsOf(this, "inbox"),
              profile: settings.profile,
              env,
              firstLookMs: FIRST_LOOK_MS,
            })
          : undefined
      const from = since ?? saved?.first
      const points = saved?.chats
      const marking = marksRead(markRead, settings, this)
      const { inbox, hearing, marked, reader } = await context.withServices(async (services, connect) => {
        const inbox = await services.inbox.read({
          ...(from === undefined ? {} : { since: from }),
          ...(points === undefined ? {} : { points }),
          ...(kinds === undefined ? {} : { kinds }),
          limit: settings.limit,
          all: all === true,
        })
        const reader = await services.messages.reader()
        const read: MessageHit[] = inbox.chats.flatMap((chat) =>
          chat.messages.map((message) => ({ ...message, chatTitle: chat.title })),
        )
        const hearing = await hearForCommand(context, messenger, read, transcribe === true, hearWith, connect)
        const marked = marking ? await markShown(services, inbox.chats, renderer.warn) : undefined
        return { inbox, hearing, marked, reader }
      })

      if (marked !== undefined) renderer.note(`marked ${marked.length} chat(s) read up to the newest message shown`)
      if (inbox.partial && format === "pretty") renderer.warn(PARTIAL_NOTE)
      const answer = inboxAnswer(inbox, hearing, reader, transcribe === true)
      renderAnswer(this, context, answer, () => {
        if (answer.items.length === 0) {
          renderer.note(inbox.mode === "unread" ? "nothing unread" : `nothing new since ${inbox.since}`)
          return ""
        }
        const read = inbox.chats
          .flatMap((chat) => chat.messages.map((message) => ({ ...message, chatTitle: chat.title })))
          .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp))
        return renderMessages(spokenItems(read, hearing), viewOf(context, messenger))
      })

      saved?.save(inbox.checked ?? {})
    })
