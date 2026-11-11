import * as v from "valibot"
import { chat } from "./chat.js"
import { id, text, time } from "./fields.js"

export const botProfile = v.strictObject({
  name: text,
  token: text,
  bot: v.optional(text),
  id: v.optional(id),
  problem: v.optional(text),
})

export const botSeenChat = v.strictObject({
  ...v.partial(v.omit(chat, ["ref", "provider", "account", "description", "invite_link", "settings", "members"]))
    .entries,
  id,
  parent_chat_id: v.optional(v.nullable(id)),
  muted_until: v.optional(v.nullable(time)),
  first_seen_at: v.optional(time),
  last_seen_at: v.optional(time),
})

export const botAdmin = v.strictObject({
  id,
  name: v.nullable(text),
  username: v.nullable(text),
  role: v.picklist(["owner", "admin"]),
  rights: v.array(v.picklist(["read", "members", "admins", "info", "pin", "link", "post", "edit", "delete"])),
  title: v.nullable(text),
})

export const botMenuEntry = v.strictObject({ name: text, description: v.nullable(text) })
export const topicIcon = v.strictObject({ emoji: text })
export const botWebhook = v.strictObject({ url: text, types: v.optional(v.array(text)) })

export const scheduledJob = v.strictObject({
  name: text,
  kind: v.picklist(["command", "agent"]),
  when: text,
  /** Kept without its timer: `schedule run` runs it, `schedule resume` puts it back on its timer. */
  paused: v.optional(v.literal(true)),
  /** When a finished run shows a desktop notice: `always`, `failures` or `never`; the default is shown, not left out. */
  notify: v.optional(v.picklist(["always", "failures", "never"])),
  /** Where a run's result is sent after it: `telegram-bot:<profile>/<chat>` or `email:<profile>/<address>`. */
  deliver_to: v.optional(v.array(text)),
  last: v.nullable(
    v.strictObject({
      at: time,
      exit_code: v.number(),
      output: text,
      trace_id: v.optional(text),
      reason: v.optional(text),
      error_code: v.optional(text),
      failing_since: v.optional(time),
      failures: v.optional(v.number()),
      cost_usd: v.optional(v.number()),
      input_hash: v.optional(text),
      /** The last time a run did not start, and why: the day's cost cap, too little new mail, or the same input. */
      skipped: v.optional(
        v.strictObject({
          at: time,
          why: text,
          /** A dotted id for `why`, so a client can translate it: `cost.day-cap`, `mail.none-new`, `mail.below-threshold`,
           * `mail.same-input`. */
          reason: v.optional(v.pipe(text, v.regex(/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/))),
        }),
      ),
      /** How the run's result went along each route; `reason` a dotted id, `error` the sending CLI's code and reason id. */
      deliveries: v.optional(
        v.array(
          v.strictObject({
            to: text,
            ok: v.boolean(),
            reason: v.optional(v.pipe(text, v.regex(/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/))),
            error: v.optional(text),
          }),
        ),
      ),
    }),
  ),
  /** Agent schedules: the agent it starts, as `schedule agents list` names it; null for a program no agent here runs. */
  harness: v.optional(v.nullable(text)),
  /** Agent schedules: whether the agent reports what a run cost; when it does not, the cost fields are null. */
  reports_cost: v.optional(v.boolean()),
  /** Agent schedules: what today's runs cost, in US dollars; null when the agent reports no cost (unknown, not 0). */
  spent_today_usd: v.optional(v.nullable(v.number())),
  /** Agent schedules: the cap on one run (`--max-cost`), null when none or when the agent reports no cost. */
  max_cost_usd: v.optional(v.nullable(v.number())),
  /**
   * Agent schedules: the daily cap in force, the schedule's `--max-cost-per-day` or the config's; 0 for none; null when
   * the agent reports no cost, so no cap can stop it.
   */
  max_cost_per_day_usd: v.optional(v.nullable(v.number())),
})

/** One agent `schedule agents list` answers: an id `schedule agent` takes, and whether its program is on PATH. */
export const scheduleHarness = v.strictObject({
  id: text,
  name: text,
  /** The program names it is found by on PATH, the first found wins. */
  programs: v.array(text),
  /** It reports what a run costs, so `--max-cost` and `--max-cost-per-day` hold. */
  reports_cost: v.boolean(),
  /**
   * The agent itself holds a run to the CLI's commands or folders (claude, codex). False: it approves every command in
   * its one-shot mode, and only the read-only variable keeps it from sending.
   */
  restricted: v.boolean(),
  /** Why an agent that is not restricted is not: a schedule refuses it (`agent.unrestricted`), and a client greys it. */
  restricted_reason: v.nullable(text),
  installed: v.boolean(),
  /** Where its program is, or null when it is not on PATH. */
  path: v.nullable(text),
})

export const botTemplate = v.strictObject({
  name: v.nullable(text),
  status: v.nullable(text),
  language: v.nullable(text),
  category: v.nullable(text),
})

export const callRecord = v.strictObject({
  id,
  chat_id: v.nullable(id),
  caller_id: v.nullable(id),
  direction: v.picklist(["incoming", "outgoing"]),
  outcome: v.picklist(["answered", "missed", "declined"]),
  kind: v.picklist(["audio", "video"]),
  at: time,
  duration_seconds: v.nullable(v.number()),
})

export const stickerInventory = v.strictObject({
  id,
  title: v.optional(text),
  count: v.optional(v.number()),
  link: v.optional(v.nullable(text)),
  set_id: v.optional(v.nullable(id)),
  emoji: v.optional(v.array(text)),
  url: v.optional(v.nullable(text)),
})
