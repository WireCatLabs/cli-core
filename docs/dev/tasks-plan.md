# Plan — tasks: categories, claiming, ids, and no duplicates

For the user: the tasks pages on the docs site (`content/docs/tasks.md` and `tasks-architecture.mdx` in
cli-docs). This file is the design and the build order.

Status: **approved 2026-10-14 (owner).** The owner's words, cli-private journal `2026-10-11-channel-report.md`:

- ASK-246 — tasks, notes and tags live in cli-core and stay in tg and max ("we cant go without them and keep
  messenger cli efficient"); only `search mail` leaves them (NEED-1087 A, cli-core#1121).
- ASK-247 — "agent syncs with api, gets new messages and records tasks for all unanswered chats that really need
  attention or finds stuff that should be done so it's not lost … the next message in same chat shouldn't
  create another task". `sync` runs the task rules (NEED-1089 A).
- ASK-248 — many tasks per chat are normal; "dont suggest too simple and limiting options like 1 task per
  person"; tasks like [beads](https://github.com/gastownhall/beads); categories; "find similar tasks in the same
  chat and do some dedup automatically and if unsure - report back to user".
- ASK-251 — this file's comparison chain, approved ("ok let's do this", 2026-10-14).

## Goal

After a `sync`, an agent finds a task for each thing that needs the owner — an unanswered question, a request, a
promise — each linked to every message that belongs to it, with no second task for the same thing. A chat holds
as many tasks as it has things to do. When the tool is sure two tasks are one, it merges them in a way that can
be undone; when it is not sure, it asks.

## Current state

Anchors on `origin/main` b654ee2a, 2026-10-14.

1. **One table holds every task** (`tasks`, `src/store/sqlite/schema.ts:1181`): tasks found in messages (types
   `question`, `request`, `mention`, `promise`, `src/tasks/model.ts`) and project tasks (`bug`, `feature`,
   `chore`, `src/store/sqlite/work-tasks.ts:14`). Fields: title, `title_folded`, description, priority 0–4,
   parent, status `open|done|dismissed`, `due_at`, `next_check_at`, `verdict` (useful / not useful), `source`
   (one message locator), assignments (assignee, reviewer, watcher) and an event history (`task_events`).
2. **Every task has a key: the project key and a per-project counter** taken in the same write
   (`UPDATE projects SET tasks_count = tasks_count + 1 … RETURNING`, `work-tasks.ts:267`): `HRB-12`. A task found
   in a message goes to its account's inbox project, whose key is `IN` + 8 hex of the account's hash
   (`src/store/sqlite/tasks.ts:42`), so its key reads `IN1A2B3C4D-17`; the task package also keeps a UUID
   (`package_id`).
3. **More messages can be linked to a task** — `tasks link <task> msg:…` writes `links` rows — and two tasks can
   be related: `blocked-by`, `follow-up-of`, `related-to` (`src/store/sqlite/task-relations.ts:10`); a `task:`
   target records a relation (0.274.0).
4. **Duplicates: the chain runs on creation (step 5, store version 15).** `tasks add` refuses a likely or maybe
   candidate and takes `--into` or `--new`; a rule-made task opens and its candidates go to `task_pairs` as
   `review` (`src/store/sqlite/task-pairs.ts`); `tasks duplicates`, `merge`, `unmerge`, `duplicates reject` /
   `unsure` decide. A message attached or merged into a task is linked as `evidence`, and a rule opens no second
   task for it (`findBySource(…, { linked: true })`). The chain on a message linked to an existing task — built
   2026-10-16, no store change (§ 8).
5. **Rules run in `review` and `serve`, not in `sync`** (`src/services/inbox.ts:359`,
   `src/cli/messenger/serve-command.ts:232`). `applyTaskRulesToStored(store, account, since)` (0.274.0) runs
   them over what is stored, from a stop point.
6. **Store version 13 (step 2) added** a category (default list `DEFAULT_TASK_CATEGORIES`,
   `src/domain/task-categories.ts`), tags on tasks, keys per type, the claim lease (`tasks claim`, `release`,
   `agenda --claimed`) and the relation kinds `duplicate-of` and `discovered-from`. A relation joins only
   owner-project tasks (`liveTask`, `src/store/sqlite/task-relations.ts`), except `duplicate-of`, which joins two
   live tasks of one project or account. Step 6 added the owner's category list in the store, MCP `tasks_claim` /
   `tasks_release` / `tasks_categories`, and `agenda --category --tag`.
7. **What the comparison can reuse:** the text normalizer and the Snowball stemmers (Russian, English, Spanish;
   `src/search/stem.ts`) behind message and note search; FTS5 tables per domain (`message_words` /
   `message_stems`, `note_words` / `note_stems`); `identities` for "the same person"; one write lock per
   transaction (`BEGIN IMMEDIATE`, `src/store/sqlite/transaction.ts`).

## What we take from beads, and what not

Read in `gastownhall/beads` 9c4b3d8 (2026-10-14; the same code as `steveyegge/beads`, storage now Dolt).

| beads | Here |
|---|---|
| Hash ids `bd-a3f8`, longer as the database grows (`internal/idgen/hash.go`) | Not needed: one store per machine, one writer at a time. Readable keys instead (§ Ids). |
| Labels for everything that is not a field (`docs/core-concepts/labels.md`) | Yes: one **category** from a fixed list, plus free labels. |
| Edge types incl. `duplicates`, `supersedes`, `discovered-from` | `duplicate-of` and `discovered-from` join the relation kinds. |
| `bd ready` — open, unblocked work | `tasks agenda` already does it for messages; adds `--category`, `--label`. |
| `bd update --claim` — atomic claim | `tasks claim` (§ Claiming). |
| `external_ref` + `source_system` | Already better here: every task links to its messages. |
| `bd duplicates` merges exact copies only; `bd find-duplicates` scores word overlap (Jaccard + cosine), optionally asks a model, and only reports | Not enough: chat text is never an exact copy, and nothing checks **before** creating. § Duplicates is a check at creation plus a review list. |

## Ids

- **Project tasks keep their key** (`HRB-12`).
- **Tasks found in messages get a readable key per type** in place of the inbox key: `Q-15` question, `REQ-22`
  request, `M-7` mention, `PR-4` promise. The number comes from a counter row per type, taken in the same
  `BEGIN IMMEDIATE` write as the insert, as project keys are. Tasks made before keep their `IN…-n` key; the UUID
  and both keys resolve as `task:<…>`.
- **A key never changes.** The category is a field, not part of the key, so correcting a category breaks no
  reference quoted in a chat or a note.
- Why not hashes: they solve many writers on many copies that merge later (beads over git). This store has one
  writer at a time on one machine. If stores ever sync between devices, keys gain a device prefix; that is a
  later decision.

## Categories and labels

- **One list per store**, edited with `config set task_categories.<name> "<meaning> | <words>"` (a word may say its
  language, `es:vuelo`; otherwise its script picks Russian or English), removed with `config unset
  task_categories.<name>`, back to the default with `config unset task_categories`. It is a `store_settings` row,
  not a profile setting: the rules run in tg, max, memo and `sync` and must agree, and a profile's config schema
  refuses unknown sections. `other` cannot be removed. Default list: `money`, `documents`, `meeting`, `delivery`,
  `access`, `personal`, `other`.
- **An agent must name a category** (`tasks add --category money`); an unknown one is refused with the list, so
  "finance", "payments" and "деньги" never coexist. `tasks categories` prints the list with meanings.
- **A rule picks the category** by matching the source message's stems against each category's trigger stems;
  most hits wins, no hit is `other`. An agent reviewing after `sync` corrects it.
- **Every correction is an event** (`task_events`, kind `category`), so a learned classifier can replace the
  trigger words later — naive Bayes over stems, local, no model download — only if the words prove weak.
- **Labels are tags.** `taggings` is polymorphic (`taggable_type`, `schema.ts:1489`); a task becomes one more
  taggable type, so `tags` commands and filters work on tasks with no new concept. For filtering only; matching
  ignores them.

## Claiming

Two agents, or an agent and the owner, must not work one task at once.

- **The holder is one agent session** (owner, NEED-1119): `--holder <name>`, else `WIRECAT_HOLDER`, else
  `claude-code:<CLAUDE_CODE_SESSION_ID>` (Claude Code sets it in every process it starts), else the agent's name
  from `AI_AGENT`, else `owner`. No other agent's session variable is known yet — Codex 0.162.0 sets none found;
  such an agent falls back to its name, or passes `--holder`. A web agent with no environment passes its chat id.
- `tasks claim <task> [--for 30m]` — one statement, inside `BEGIN IMMEDIATE`:
  `UPDATE tasks SET claimed_by = ?, claimed_until = ? WHERE id = ? AND status = 'open' AND (claimed_by IS NULL
  OR claimed_until < ? OR claimed_by = ?) RETURNING id`. No row back means someone else holds it: the error names
  who and until when. Claiming again extends one's own claim. SQLite lets one writer in at a time across
  processes, so this is atomic between tg, max, memo and agents on the machine.
- The claim is a lease: it expires (default 30 minutes), so a crashed agent never holds a task forever.
  `tasks release <task>` gives back one's own claim; the owner may release any. Closing a task releases it.
- `tasks agenda` shows each task's holder and hides tasks claimed by someone else unless `--claimed` asks for them.

## Duplicates — the comparison chain

Runs on every new task, and on every new message linked to a task. All in cli-core, on SQLite; no embeddings,
no model call.

### 1. Normalize the new task

- Title and description through the search normalizer (lower case, no diacritics, `ё` → `е`, digit groups joined:
  `15 000` → `15000`), then the Snowball stemmer per script, minus stop words → a **stem set**.
- Also the **character trigrams** of the normalized title (all three-letter windows), which catch typos and
  forms a stemmer misses.
- The **signature**, by patterns: amount and currency (a number beside `₽`, `руб`, `€`, `$`, `usd` …), due date
  (dates and phrases like `до пятницы`, `by Friday`), and the person (`person:<id>` of the source message's
  sender, through `identities`). An agent may pass them explicitly (`--amount`, `--due`, `--person`).

Stems and the normalized text are written to two new FTS5 tables, `task_words` and `task_stems`, built like
`note_words` / `note_stems` and kept by the same writes.

### 2. Certain matches — attach without scoring

Only one: the **same rule on the same message** — a unique index on (source, rule). Nothing new is created.

A reply and the same title were certain in the first draft; the test set (§ Test set) found them wrong 6 times
in 11 — a reply that adds a new request, another person's "+1", the same title for a different job. A reply is
now a weighted field (§ 4), and the same title is just a high text score.

### 3. Candidates — a union of cheap lookups

- `SELECT task_id FROM task_stems WHERE task_stems MATCH '<stems joined by OR>' ORDER BY bm25(task_stems) LIMIT 20`
- the same person; the same category; the same reply chain — plain indexed queries.

Only tasks open, or closed in the last 14 days. The union is at most about 40 tasks. **"Same chat" alone never
makes a candidate**: a chat holds many unrelated tasks, and one request can arrive in a group and in a private
chat. One lookup alone is never the gate either — Graphiti lost exact duplicates by taking candidates from one
search with a cut-off (getzep/graphiti#1734).

### 4. Compare field by field

| Field | Comparison | Levels |
|---|---|---|
| Text | Jaccard = shared ÷ all distinct, on stem sets (title + description) and on title trigrams; the higher counts | ≥ 0.6 · 0.3–0.6 · < 0.3 |
| Person | `person:<id>` | same · different · unknown |
| Amount | value and currency | equal · different · missing |
| Category | name | same · different |
| Due date | days apart | ≤ 2 · more · missing |
| Reply chain | the source messages reply to one another | yes · no |
| Time | days between the tasks | ≤ 3 · 4–14 · more |

### 5. Add up the weights (Fellegi–Sunter)

Each level carries a weight `log2(m / u)`: `m` how often true duplicates show that level, `u` how often unrelated
tasks do. A level duplicates usually share pushes the sum up, one they rarely share pushes it down. Starting
weights, set by hand and tuned on the test set (§ Test set) before they are trusted:

| Level | First draft | After the test set |
|---|---|---|
| Text ≥ 0.6 / 0.3–0.6 / < 0.3 | +4 / +2 / −2 | +5 / +5 / −2 |
| Person same / different / unknown | +3 / −3 / 0 | +1 / −3 / 0 |
| Amount equal / different / missing | +3 / −4 / 0 | +6 / −4 / 0 |
| Category same / different | +1 / −1 | +1 / −1 |
| Due ≤ 2 days / more / missing | +1 / −1 / 0 | +4 / −1 / 0 |
| Reply chain | +6 | +6 |
| Time ≤ 3 / 4–14 / > 14 days | +1 / 0 / −1 | +2 / −2 / −3 |

Levels no duplicate in the set showed (a different person, amount or category) would count to −5 or −6 from zero
observations; they keep the first draft's values.

Bands: **≥ 10 likely, 5–9 maybe, < 5 different.** On the set (cli-testing#60) "maybe or likely" finds 90% of
duplicates at 58% precision and refuses 21% of new tasks; "likely" alone is 85% precise, 43% recall. **No
threshold gives a band that merges safely**: the zero-wrong-merge point is ≥ 16 and catches 4%. The look-alikes
that stay — a gift for mum or for dad, the same amount, two days apart — differ in the meaning of one word, which
no field here sees. So "likely" only orders the list; nothing merges on a score. Weights and bands live in one
module with the reason for each number; nothing else hard-codes them.

### 6. Decide

| Band | Created by an agent | Created by a rule |
|---|---|---|
| Certain (§ 2) | — | nothing new |
| Likely | listed first; the agent must choose (below) | to the review list; the reviewing agent decides |
| Maybe | `tasks add` refuses and lists up to 5 candidates with score and reasons ("same person, same amount, 2 of 5 stems shared"); the agent repeats with `--into <task>` or `--new` | to the review list; the reviewing agent decides |
| Different | created | created |

- Refusing, not warning: an agent skips a warning; it cannot skip an exit code. Asking the creating agent costs
  no extra model call — it is already the judge (Mem0 decides add / update / nothing the same way,
  arXiv 2504.19413).
- **Who reviews (owner, NEED-1103 A):** the agent that goes through tasks after `sync` decides each pair a rule
  left in "likely" or "maybe" — it reads the meaning the fields miss — and passes the owner only the pairs it is
  unsure about (`tasks duplicates --unsure`). Its merges can be undone like any other.
- **The review list:** `tasks duplicates` lists pairs a rule left in "likely" or "maybe", newest first, with reasons.
  `tasks merge <dup> --into <task>` links every message of the duplicate to the task, closes the duplicate
  `dismissed` with a `duplicate-of` relation, and records the decision; `tasks duplicates reject <dup> <task>`
  records "not the same" so the pair is not offered again.
- **A merge can be undone:** `tasks unmerge <dup>` reopens it and removes the relation; links stay where they are
  until moved. A merge is never a delete (Zendesk's permanent merge is the trap).

### 7. Learn from answers

Every merge, rejection, `--into` and `--new` after a candidate list is a labelled pair. With enough of them,
`m` and `u` per level are recounted from the pairs — the Splink estimate by counting, no training step — and
the bands move. A score never merges on its own: the test set shows the fields cannot tell some look-alikes
apart. If real answers show "likely" pairs are almost always accepted, merging them is the owner's call.

### 8. A message linked to a task — built 2026-10-16

- **The comparison reads the messages a task stands on**: its source message and its 5 newest linked messages
  (`links` to a message of kind `related-to`, `evidence` or `created-from`; not `answered-by`, the owner's own
  answer). Each is a view: the task's title and description plus that one message. Two tasks score as their best
  pair of views, taken whole — text, person, amount and due date come from the same message, never mixed. The
  title-and-description view stays, so a message can raise a score and never lower it. A message's amount and due
  date count only when the task's own text has none; its "tomorrow" is read from when it was sent. The time field
  stays the tasks' creation dates.
- Messages are read from the store at compare time (`src/store/sqlite/task-candidates.ts`); a task stores no
  message text, and `task_stems` still holds only title and description. Linked messages are read for the subject
  and the chosen candidates only, not for the 2000-task window. A reply to a linked message finds the task through
  the reply lookup.
- **After a link the check runs again** for that task (`reviewDuplicates`): `tasks link` / MCP `tasks_link` with a
  `msg:` target, `tasks add --into`, and `tasks merge` (which links the duplicate's messages to the task that stays).
  New likely or maybe pairs go to `tasks duplicates`, with the newer task as the would-be duplicate; the answer's
  `review` counts them. The link always stands, nothing merges on a score, and a closed task is not checked. No
  rule links a message to an existing task (a rule only skips a message already attached), so rules add no trigger.
- The source message's text was not read before, so a rule's task — whose title is a placeholder — compared on no
  words at all. Reading it brings the store in line with the test set, whose tasks always carry their message.
- Measured ([cli-testing](https://github.com/WireCatLabs/cli-testing/tree/main/performance/tasks/duplicates),
  `linked.mjs`): the set replayed with an agent that answers every refusal right, before and after — the same
  numbers (maybe or likely 65 / 45, 59% precision, 92% recall; likely 30 / 6, 83%, 42%), and the check after a link
  sent no new pair. In the set each task already carries its whole message, so a linked one adds nothing the first
  did not; the gain is for tasks whose own text lacks what a later message says (store tests).

## Rules on `sync`

`sync` runs `applyTaskRulesToStored` over the chats it stored into, from a stop point per account kept in the
store, then the chain above for each task the rules would open. The answer says how many tasks were opened,
attached and sent to review.

Built 2026-10-15 (`applyTaskRulesSinceLastPass`): the stop point is a `store_settings` row per account, the first
pass reads only chats with a message in the last 14 days (a store holding years of chats opens no task for an old
question), and the answer carries `tasks: {added, closed, review}` — `review` counts the opened tasks whose
candidates went to the review list (step 5). Nothing is attached automatically beyond the same rule on the same
message.

## Test set

Before the weights decide anything: a synthetic set in cli-testing (`performance/tasks/duplicates/`) —
pairs that are one task written differently (word forms, typos, amounts as `15 000` and `15000`, Russian and
English), pairs that look alike and are not (same person, other job; same words, other amount), and many tasks
in one chat. It reports wrong merges and missed duplicates per band, and the weights move until wrong merges in
"same" are zero. A run on the owner's store reports totals only there; per-pair rows go to cli-private.

Measured: [cli-testing#60](https://github.com/WireCatLabs/cli-testing/pull/60),
`performance/tasks/duplicates/` — 251 synthetic Russian/English tasks, 80 duplicate pairs, real FTS5 `bm25()`,
cli-core 0.277.0's stemmer; weights tuned on one half, tested on the other. Limits: the same author wrote the data
and the scorer; duplicates across languages are weak (2 of 5 scored "different"); no real data yet. It also
found two gaps step 3 needs: `normalize()` does not join digit groups (`15 000`), and search has no stop words.

## Build order

1. **Test set** in cli-testing, with the scoring module stubbed to the starting weights.
2. **Fields:** category, labels, keys per type, `claimed_by` / `claimed_until` with `tasks claim` / `release` and
   `agenda --claimed`, relation kinds `duplicate-of` and `discovered-from` — store version 13.
3. **`task_words` / `task_stems`**, the normalizer + signature extraction, digit groups joined, a stop-word list.
4. **Scoring module** (candidates, comparison, weights, bands), tuned on the test set.
5. **`tasks add` check** (`--into`, `--new`), rules through the chain, `tasks duplicates`, `merge`, `unmerge`;
   relations between message tasks — built (store version 15, `task_pairs`). The check on a message linked to a
   task (§ 8) — built, no store change.
6. **`agenda --category --tag`**, the MCP tools `tasks_claim` / `tasks_release`, and the category list in the
   store (`config set task_categories.*`) — built.
7. **Rules on `sync`.**
8. Then tg and max move their cli-core pin together with cli-core#1121 (`search mail` leaves them).

## Not doing

- Embeddings or a model call to compare tasks. If the test set shows the text field is too weak, a local
  embedding is the next step, measured against this one.
- One task per chat or per person.
- Deleting duplicates.
- Hash ids, until stores sync between devices.

## Open

- The default category list — the owner adds or renames.
- Whether a message that matches a task closed in the last 14 days reopens it or opens a new one linked
  `follow-up-of`.
