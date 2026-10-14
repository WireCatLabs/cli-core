import * as v from "valibot"
import { itemOf, snakeKeys } from "../../cli/envelope.js"
import type { Messenger } from "../../cli/messenger/context.js"
import { onlineDeps, servicesFor } from "../../services/index.js"
import { momentOf } from "../../services/moment.js"
import { type AnyTool, chatOf, READ, tool, WRITE } from "../tool.js"

/**
 * A group's rules, and the run that acts on them. Over MCP nobody can answer a question per action,
 * so an action whose level in the group's rules is `ask` is planned, not taken.
 */
export const moderationTools = (messenger: Messenger): Record<string, AnyTool> => ({
  chats_rules_show: tool({
    title: "A group's moderation rules",
    description: "The rules `chats_moderate` judges a group by; the defaults, marked not saved, if it has none.",
    input: v.object({ chat: chatOf(messenger) }),
    annotations: READ,
    online: async (adapter, args, { guard, settings, env }) =>
      itemOf(
        snakeKeys(
          await servicesFor(onlineDeps(messenger, adapter, guard, { profile: settings.profile, env })).moderation.rules(
            args.chat,
          ),
        ),
      ),
  }),
  chats_moderate: tool({
    title: "Apply a group's rules",
    description:
      "Judge a group's new messages and members by its rules, and delete or remove where the rules' levels allow; " +
      "an action at level ask is planned for the owner, not taken. Only when the owner asked for this group.",
    input: v.object({
      chat: chatOf(messenger),
      since_time: v.optional(v.pipe(v.string(), v.description("ISO 8601, or 2h / 1d ago; the saved point stays"))),
      dry_run: v.optional(v.pipe(v.boolean(), v.description("judge and plan; do nothing"))),
    }),
    annotations: WRITE,
    permission: "groups",
    online: async (adapter, args, { guard, settings, env }) =>
      itemOf(
        snakeKeys(
          await servicesFor(
            onlineDeps(messenger, adapter, guard, { profile: settings.profile, env }),
          ).moderation.moderate(args.chat, {
            ...(args.since_time === undefined ? {} : { since: momentOf(args.since_time, "since_time") }),
            dryRun: args.dry_run === true,
            allowDangerous: false,
          }),
        ),
      ),
  }),
})
