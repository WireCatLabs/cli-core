import { CliError } from "@wirecat/cli-base"
import * as v from "valibot"
import type { Messenger } from "../../cli/messenger/context.js"
import { checkPoints } from "../../cli/messenger/points.js"
import { CHAT_KINDS } from "../../services/chats.js"
import { momentOf } from "../../services/moment.js"
import { heard, hearForTool, modelWith } from "../../speech/hearing.js"
import { type AnyTool, READ, tool } from "../tool.js"

/** Per chat: unread across many chats at a hundred each would outgrow what a client keeps of one answer. */
const INBOX_LIMIT = 20
const FIRST_LOOK_MS = 24 * 60 * 60 * 1000

export const kindsInput = v.optional(
  v.pipe(v.array(v.picklist(CHAT_KINDS)), v.minLength(1), v.description("only chats of these kinds")),
)

export const inboxTools = (messenger: Messenger): Record<string, AnyTool> => {
  return {
    inbox: tool({
      title: "What is new",
      description:
        "Other people's messages waiting for the owner, grouped by chat, in one call: the unread ones; with " +
        "`since_time` everything after that point; with `new` what arrived since the last `new` call, each message " +
        "once, from saved points this tool keeps apart from the owner's own " +
        `\`${messenger.app.command} inbox --new\`. Marks nothing read. Muted and archived chats are left out unless they ` +
        "mention the owner or reply to them, or `all` is set. Returns { mode, chats: [{ id, title, messages, more }], " +
        "skipped, partial, quiet }, where quiet counts the chats left out. A voice message carries `transcript` once " +
        "heard; `transcribe` hears the rest.",
      input: v.object({
        since_time: v.optional(v.pipe(v.string(), v.description("an ISO 8601 time, or 2h / 1d ago"))),
        new: v.optional(v.pipe(v.boolean(), v.description("what arrived since the last call with new"))),
        kinds: kindsInput,
        all: v.optional(v.pipe(v.boolean(), v.description("muted and archived chats too"))),
        limit: v.optional(
          v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(100), v.description("at most this many per chat")),
        ),
        transcribe: v.optional(
          v.pipe(v.boolean(), v.description("turn voice messages not heard yet into text; can take minutes")),
        ),
        model: v.optional(
          v.pipe(
            v.string(),
            v.minLength(1),
            v.description("which downloaded speech model hears them, with transcribe"),
          ),
        ),
      }),
      annotations: READ,
      served: async (services, args, defaults, connect) => {
        if (args.new && args.since_time !== undefined) {
          throw new CliError("validation_error", "new keeps its own point — not with since_time")
        }
        const limit = args.limit ?? INBOX_LIMIT
        const saved = args.new
          ? checkPoints(messenger.app, {
              command: "mcp-inbox",
              profile: defaults.settings.profile,
              env: defaults.env,
              firstLookMs: FIRST_LOOK_MS,
            })
          : undefined
        const since = args.since_time === undefined ? saved?.first : momentOf(args.since_time, "since_time")
        const inbox = await services.inbox.read({
          ...(since === undefined ? {} : { since }),
          ...(saved === undefined ? {} : { points: saved.chats }),
          ...(args.kinds === undefined ? {} : { kinds: args.kinds }),
          limit,
          all: args.all === true,
        })
        const messages = inbox.chats.flatMap((chat) => chat.messages)
        const hearing = await hearForTool(
          messenger,
          connect,
          messages,
          args.transcribe === true,
          defaults,
          modelWith(args.transcribe, args.model),
        )
        saved?.save(inbox.checked ?? {})
        return {
          ...inbox,
          chats: inbox.chats.map((chat) => ({ ...chat, messages: heard(chat.messages, hearing) })),
          ...(args.transcribe ? { unheard: hearing?.unheard ?? [] } : {}),
          ...(hearing?.problem === undefined ? {} : { transcribeProblem: hearing.problem }),
        }
      },
    }),
  }
}
