# Plan: a task point per chat, then triage and task chains

Status: part 1 is built on branch `feat/task-analysis-marks`; parts 2 to 5 are plans for the owner's review.

## Why

The owner, 2026-11-03: keep, for every chat, the date its messages were last read for tasks, so that whatever other
agents or the owner already read, a pass can pull in all history not yet read for tasks and update every task's
status from it.

## How tasks are found today (origin/main, 2026-11-02)

Two passes write tasks, and neither keeps a per-chat point of its own.

**The rules** (`src/services/task-rules.ts:77`, `applyTaskRules`) open a task for an unanswered question or a
mention and close it when the owner answers. They run from three places:

- `review` (`src/services/inbox.ts:364`) over what the review read. The review window starts at the `--new` point
  (`src/cli/messenger/points.ts:27`), skips chats over `REVIEW_CHATS` (`inbox.ts:114`) and muted ones without
  `--all`, and stops at the chat list's newest message.
- a sync or backfill (`src/cli/messenger/backfill-command.ts:359`, `applyTaskRulesSinceLastPass`,
  `task-rules.ts:274`). It keeps one stop per **account**, as store time (`src/store/sqlite/task-rule-stops.ts:5`),
  and loses messages four ways:
  1. it compares that store-time stop with a count by **sent** time (`task-rules.ts:237`), so history fetched
     after the stop, sent before it, counts as nothing new and is never read (`task-rules.ts:215` says so on
     purpose: "a backfill of old history is not new work");
  2. a chat it skips — a channel, or one quiet for `FIRST_PASS_DAYS` on the first pass — still moves the stop
     (`task-rules.ts:229`);
  3. a chat with more than `STORED_PASS_LIMIT` (1000) new messages has its oldest left unread
     (`task-rules.ts:208`, `:243`), and the stop moves past them anyway (`task-rules.ts:279`);
  4. the stop is one for the account, so one chat's late history cannot be told from another's.
- `serve` on each arriving message, over the 50 before it (`serve-command.ts:327`, `ARRIVAL_WINDOW`,
  `task-rules.ts:176`). An answer more than 50 messages after its question closes nothing.

**The agent** (the follow-ups skill, `skills/follow-ups/SKILL.md:21`) reads `review --new` and writes tasks with
`tasks add`. Its point is the `mcp-review` file, one per profile (`points.ts:35`, `catch-up.ts:5`), which moves when
the review **reads** (`review.ts:128`), not when the agent has finished with what it read. Every agent on the
profile shares it, so one agent's read hides the messages from the next. `inbox` without `--new` reads the
messenger's unread state (`inbox.ts:105`), which the owner's phone clears.

## Part 1 — the task point (built)

- **Storage.** One row per account and chat in `store_settings`, key `task_analysis:<provider>:<account>:<chat>`,
  beside `task_rules_until` (`src/store/sqlite/task-analysis-marks.ts`). No migration; backup, restore and export
  carry it with the store. It holds `from`, `through` and `through_id` (sent time and id of the last message read),
  `by`, and `checked_at` / `checked_through`: at `checked_at` every stored message from `from` through
  `checked_through` had been read.
- **Reading moves nothing.** `tasks review <chat>` reads stored messages after the point (by message id, so two
  messages in the same second are not lost), oldest first, 100 a page (at most 1000), with the chat's open tasks.
  `tasks acknowledge <chat> <message>` moves the point once the reader has written the tasks; it never moves back.
  A crash between the two reads the page again, and `tasks add` gives back the task a message already has, so
  reading twice opens nothing twice.
- **History fetched later is seen.** A message saved or edited after `checked_at` and sent inside the checked
  stretch is counted as `late`. `tasks review <chat> --since-time <from>` reads the stretch again; acknowledging
  a read that started at or before `from` and reached the point clears `late`.
- **Where a chat starts.** A chat never read starts 14 days back (`FIRST_PASS_DAYS`), as the rules' first pass
  does; `--since-time` names another start.
- **Which chats.** `tasks status` lists every chat whose kind the rules read (`RULES_IN`, not channels or Saved
  Messages, owner 2026-10-17), newest first, with the point, `waiting` and `late`.
- **Accounts.** The key holds provider and account; a profile names one, so no pass reads another account's point.
- **Agents.** One point per chat, shared by every agent and the owner, with `by` recording who moved it last
  (open decision 1). In read-only mode (a timer's agent) `tasks acknowledge` still runs, like `tasks scan --yes`.
- **MCP.** `tasks status` and `tasks review` are read tools, `tasks acknowledge` a write tool, as for every
  shared command.
- **The skill.** The follow-ups skill works chat by chat from `tasks status`: review, write, acknowledge.

Known limits of part 1:

- A message stored inside the stretch between a `tasks review` and its `tasks acknowledge` is not counted as late.
  The window is the agent's working time on one chat.
- A read again that takes several pages clears `late` only when one acknowledge covers the whole stretch. With
  `--since-time` a page is 1000 messages; a longer stretch gives no acknowledge step and `late` stays until part 2.
- `waiting` counts by sent time after the point, while `tasks review` reads after the point's message id: a message
  sent in the same millisecond as the point is read but not counted.
- `tasks status` computes every chat before it applies `--limit`, and a chat whose `late` never clears reads every
  change since its `checked_at`. Fine for hundreds of chats; for the desktop's per-profile call, part 3 adds a
  `waiting:>0` filter and counts `late` in SQL.

## Part 2 — the rules and the fetch on the same point (next)

1. **The rules pass per chat.** `applyTaskRulesSinceLastPass` keeps a point per chat under the analyser name
   `rules` (same table, key gains the analyser), moves it only over what it read, and never from a skipped chat.
   It reads every page, not the newest 1000, and passes each chat's open tasks' source messages with the new ones,
   so an answer far from its question still closes it. `task_rules_until` stays until no build reads it; its
   removal goes to `CLEANUP.md`.
2. **Gaps.** `tasks review` says when the store lacks messages after the point (the chat's `lastMessageAt` is newer
   than the newest stored message, or `sync_ranges` shows a hole) and gives `messages sync <chat>` as its next step.
   It does not fetch itself: one fetch path, with its history limits, stays in `messages sync` and `backfill`.
3. **Re-read in pages.** The point records an open re-read (`rereading_from`, `rereading_through`) so a read again
   can take many pages and still clear `late` at the end.

## Part 3 — what the desktop shows

The desktop runs `tasks status --json` per profile (it never picks one: it shows every profile, as it does now).

- On the Tasks page, a line per profile: "Messages read for tasks up to 02.11 14:10 — 37 waiting in 5 chats".
- In a chat's row (messenger tool details): "Read for tasks up to 02.11" or "Not read for tasks yet", and a
  "History arrived later: 12 messages" note when `late` is above 0.
- A button "Find tasks now" starts the owner's chosen agent with the follow-ups skill on that profile (the
  schedule's own command, not a new one in the desktop). Rule 1: the desktop reads the CLI's answer and never
  computes points itself.

## Part 4 — an AI pass over the tasks (idea, no code)

What the owner asked: an agent that regularly suggests actions, re-ranks and proposes due dates, because "half the
messages are high priority".

Why priority inflates: each task is judged alone, at the moment it is opened, by a reader who sees one message.
Every message looks urgent in isolation, and nothing lowers a priority later.

Proposal, in the order to build:

1. **Rank, then label.** The pass reads all open tasks of the owner at once and orders them; the label comes from
   the place in the order, not from the message. A fixed share per band: critical at most 5 %, high at most
   15 %, medium 40 %, low the rest. `priority_score` (0 to 1, store version 41) already orders a board column, so a
   rank maps onto it without a migration.
2. **Decay.** A task nobody touched for N days moves down a step unless its due date is near; a due date that
   passes moves it up. Computed at read time from `updated_at` and `due_at`, so nothing is written on a schedule.
3. **Evidence for each change.** The pass writes a proposal (`proposed_actions`, already used by projects) with a
   one-line reason, not the priority itself. The owner accepts or rejects on the desktop; until the owner turns on
   "apply without asking", nothing changes silently.
4. **Learn from the owner.** Each accepted or rejected proposal and each manual priority change is a `task_events`
   row already. The pass reads the last 50 as examples for the next run (few-shot), so it adapts to what this
   owner calls urgent without training.
5. **Due dates.** Proposed only when a message names a time ("by Friday") or the task type has a usual one (a
   question a day, a promise the date said); never invented.
6. **Suggested actions.** For each top task one next step: reply (a draft), chase (for `assigned`), close (with
   certainty, which waits on the owner below the threshold, as now), or split.

Where it runs: a second skill (`triage`) in cli-core, on a timer like follow-ups, after it. No new CLI command in
the first step: `tasks list`, `tasks update --priority`, `tasks close --certainty` and proposals exist.

Recommendation: build 1, 2 and 3 first; 4 when there are 50 owner decisions to learn from.

## Part 5 — task chains (idea, no code)

What the owner asked: when a task reaches a status, do something to other tasks.

Relations that already exist: `blocked-by`, `follow-up-of`, `duplicate-of`, `parent`. Every status change is a
`task_events` row.

Proposal:

1. **Built-in effects of the existing links**, no configuration:
   - when a task is done, each task `blocked-by` it loses the block and gets "unblocked" in the agenda;
   - when a parent closes, open children are listed for the owner (not closed silently);
   - when every child is done, the parent is proposed for closing.
2. **Owner rules**, after 1 proves useful: `when <task or tag or category> becomes <status> then <action> <target>`,
   with actions limited to the store (set status, set due date relative to now, add a tag, open a task from a
   template, notify). Stored as rows, applied in the same transaction as the status change, and each applied
   effect is a `task_events` row with the rule that caused it, so it can be undone.
3. **Guards.** A rule never fires a second time for the same event (the event id is the key); a chain stops after
   5 hops, and a cycle is refused when the rule is saved.

Recommendation: 1 only, then decide on 2 from what the owner does by hand after a week.

## Owner decisions

1. **One point per chat for all agents** (owner, 2026-11-03), with `by` recording who moved it last.
2. **Reading old history opens tasks only with a flag** (owner, 2026-11-03: "only if using a flag"). `tasks add`
   refuses a message the chat's point already passed (`task.already-read`) unless given `--open-new`; built.
3. **`tasks review` reads only the store** (owner, 2026-11-03); missing history is fetched by `messages sync`, which
   part 2.2 names as the next step.
4. **The words `review` and `acknowledge` stay** (owner, 2026-11-03).
