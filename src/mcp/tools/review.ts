import { CliError } from "@wirecat/cli-base"
import * as v from "valibot"
import { catchUpQuery, REVIEW_QUERY, reviewAnswer } from "../../cli/messenger/catch-up-answers.js"
import type { Messenger } from "../../cli/messenger/context.js"
import { checkPoints } from "../../cli/messenger/points.js"
import { REVIEW_DAYS, reviewStart, UNANSWERED_HOURS } from "../../services/inbox.js"
import { type Hearing, heard, hearForTool, modelWith } from "../../speech/hearing.js"
import { type AnyTool, READ, tool } from "../tool.js"
import { kindsInput } from "./inbox.js"

export const reviewTools = (messenger: Messenger): Record<string, AnyTool> => ({
  review: tool({
    title: "Review who owes what",
    description:
      "Every message, the owner's too (outgoing: true), in each chat that changed since a point — for sorting out " +
      `what the owner owes and what others owe. Without a date in \`query\`, the last ${REVIEW_DAYS} days; with \`new\`, ` +
      "what changed since the last call with new, from points this tool keeps apart from the owner's own. Muted and archived " +
      "chats are left out unless they mention the owner, or `all` is set. Items are messages, oldest first, each " +
      "naming its chat. The first next step, review.next, is the query the next review starts from; chats cut short, " +
      "skipped or left out are `missing` entries.",
    input: v.object({
      query: v.optional(
        v.pipe(
          v.string(),
          v.description('where the last review ended and which chat: date>"2026-10-01T09:00:00Z", chat:"Book club"'),
        ),
      ),
      new: v.optional(v.pipe(v.boolean(), v.description("what changed since the last call with new"))),
      kinds: kindsInput,
      unanswered: v.optional(
        v.pipe(
          v.number(),
          v.minValue(0),
          v.description(
            `only questions nobody answered, asked at least this many hours ago (${UNANSWERED_HOURS} is usual)`,
          ),
        ),
      ),
      all: v.optional(v.pipe(v.boolean(), v.description("muted and archived chats too"))),
      transcribe: v.optional(
        v.pipe(v.boolean(), v.description("turn voice messages not heard yet into text; can take minutes")),
      ),
      model: v.optional(
        v.pipe(v.string(), v.minLength(1), v.description("which downloaded speech model hears them, with transcribe")),
      ),
    }),
    annotations: READ,
    output: { entity: "message.summary", list: true },
    served: async (services, args, defaults, connect) => {
      const { since: from, chat } = catchUpQuery(args.query, REVIEW_QUERY, "review")
      if (args.new && (from !== undefined || args.unanswered !== undefined)) {
        // An open question stays open: moving past it would drop it from the next review.
        throw new CliError("validation_error", "new keeps its own point — not with a date or unanswered")
      }
      const saved = args.new
        ? checkPoints(messenger.app, {
            command: "mcp-review",
            profile: defaults.settings.profile,
            env: defaults.env,
            firstLookMs: REVIEW_DAYS * 86_400_000,
          })
        : undefined
      const model = modelWith(args.transcribe, args.model)
      let hearing: Hearing | undefined
      const transcribe = args.transcribe === true
      const found = await services.inbox.review({
        since: from ?? saved?.first ?? reviewStart(),
        ...(saved === undefined ? {} : { points: saved.chats }),
        ...(chat === undefined ? {} : { chat }),
        ...(args.kinds === undefined ? {} : { kinds: args.kinds }),
        ...(args.all ? { all: true } : {}),
        ...(args.unanswered === undefined ? {} : { unansweredAfterHours: args.unanswered }),
        enrich: async (raw) => {
          hearing = await hearForTool(
            messenger,
            connect,
            raw.chats.flatMap((chat) => chat.messages),
            transcribe,
            defaults,
            model,
          )
          return {
            ...raw,
            complete: raw.complete && (hearing?.unheard.length ?? 0) === 0,
            chats: raw.chats.map((chat) => ({ ...chat, messages: heard(chat.messages, hearing) })),
          }
        },
      })
      const answer = reviewAnswer(
        { ...found, complete: found.complete && (hearing?.unheard.length ?? 0) === 0 },
        hearing,
        await services.messages.reader(),
        { transcribe, fresh: saved !== undefined, ...(chat === undefined ? {} : { chat }) },
      )
      saved?.save(found.checked ?? {})
      return answer
    },
  }),
})
