# Trackers

`src/tracker/`, exported as `@wirecat/cli-core/tracker` and `/tracker/testing`. A tracker CLI (Linear first) writes its
sign-in and one adapter, a `TrackerSource`; the copy in the shared store, the sync, the commands and the contract kit
are shared, as for [CRMs](CRM.md) and [mail](MAIL.md). The tables are in the [schema](../storage/schema.md); this page
covers what runs over them.

## The domain

Seven kinds, in the order a sync reads them: `team`, `user`, `state`, `label`, `project`, `issue`, `comment`
(`TRACKER_KINDS`, `src/domain/tracker.ts`). Each record carries the tracker's `externalId`, its `createdAt`,
`updatedAt` and `archivedAt` in epoch milliseconds, and refers to other rows by their tracker ids: an issue's `state`,
`team`, `project`, `assignee`, `labels` and `parent`, a comment's `issue`. A state has one of six types
(`STATE_TYPES`): `triage`, `backlog`, `unstarted`, `started`, `completed`, `canceled`, so "open work" reads the same
whatever each team named its states.

## The port

| Member | What the adapter does |
|---|---|
| `traits.kinds` | the kinds this tracker has, in `TRACKER_KINDS` order |
| `changes(kind, cursor, page?, context?)` | what changed since `cursor`, a page at a time; `cursor: null` lists everything. A tracker without a change feed reads by its modified time less an overlap and gives that time back as the last page's `cursor`. A dead cursor answers `{ reset: true }` |
| `ids(kind, page?, context?)` | every id the tracker holds of the kind, archived ones too, a page at a time |
| `self?(context?)` | the sign-in's own user id, which decides whose issues become the owner's tasks |

Archived rows are listed, with `archivedAt`, and the copy keeps them marked. A row deleted outright is found only by
`ids()`. A source that pages inside one call asks `context.spend()` before each further request, and names what the
sign-in could not read with `context.gap()`.

## `syncTracker(source, store, account, options)`

For each kind: the changes since the kind's cursor, page by page, each page saved with the cursor after it
(`tracker:<kind>` in the account's sync state). Then, once `passEvery` (a day) has passed since the last complete one,
an id pass that marks deleted each stored row the list lacks and that was not saved since the pass began. A pass that
stops keeps its ids and the page it reached.

- **Budget.** The engine takes one request from `options.budget` before each call. A run that stops answers
  `state: "partial"` and `stopped`; the kinds it finished are skipped by the next run until every kind has had its
  round, so a budget smaller than the number of kinds still moves on.
- **Held passes.** A pass is held (`pass: "held"`, with the reason in `held`) and marks nothing when the list is empty
  while rows are stored, or when it would mark more than half of ten or more stored rows deleted: a tracker that lost
  rights lists none of what it can no longer see. `--rescan` lets those through. A pass after the sign-in reported a
  gap for the kind is held even then: what it could not read is not gone.
- **Failures.** A kind that fails is named in its result's `error` and the others still sync. A page that says there is
  more but gives no next page fails the kind.
- **The owner's tasks.** After the kinds, a sync whose tracker has `self` and issues brings the owner's tasks in line
  with the copy (`syncTrackerTasks`, below) and answers what it did in `tasks`. The user's id is read once and kept as
  `tracker:self` in the account's sync state and never read again, so a tracker CLI must key the account by the user
  it signs in as (its sign-in check names the user, as linear-cli's `viewer`), not by the workspace. Without `self`,
  or in a cancelled run, the answer has no `tasks`.
  When the budget is spent before the id is read, or the id or a task cannot be read or written, the tasks are left as
  they were and `tasks.skipped` says why; the copy is saved either way.
- **`rescan`.** Lists everything again and every id, dropping a round in progress, and lets a held pass through unless a gap held it. A
  rescan that stops goes on as one in the next run.

A save merges: a field the read left out keeps its stored value, so a partial selection never erases.

## `store.tracker`

`save`, `removeUnlisted`, `get`, `issueByKey` (`ENG-12`, any case), `list` with issue filters (team, project,
assignee or none, state, state types through the state rows, label, archived), `find` over the word index
`tracker_item_words` (titles, descriptions, comment bodies), `count`, and `people`: the tracker users whose e-mail an
identity linked to a person has, joined when read. Nothing is written to the people graph.

## An issue as the owner's task

A task from an issue has `source` `tracker:issue/<externalId>`, `sourceKind` `tracker_issue`, kind `request`, and the
issue's key and title as its title (`ENG-12 Fix login`). The same issue never makes a second task.

- **Assigned to the owner.** `syncTrackerTasks(store, account, self)`, run by every sync, makes each live, unarchived
  issue assigned to `self` whose state type is open work (`triage`, `backlog`, `unstarted`, `started`) a task of origin
  `rule`. memo and Desktop list it with the other tasks; nothing is written to the tracker.
- **Picked by hand.** `trackerIssueTask(store, account, issue)` and `issues assign <issue>` make any issue the owner's
  task, whoever holds it (origin `owner`). An issue the sync already made a task of answers that task, opened again
  when closed. That task is the owner's pick from then on (`tracker:owner-picks` in sync state): the issue going to
  someone else no longer closes it.
- **The title is stored**, not resolved when read: lists, the board, search and filters read the task's stored title
  and its folded copy, as they do for a task found in a message. Each sync writes the issue's current key and title
  over it when they changed.
- **Closing.** A sync closes the task when its issue is completed (`done`), canceled, archived or deleted
  (`dismissed`), and a task of origin `rule` also when the issue is assigned to someone else or to no one. The reason
  says which, such as `the issue was completed in linear`. Tasks of any other `sourceKind` are never touched.
- **Reopening.** A task the sync closed, with one of those reasons, opens again when its issue's state is open work
  again (and, for origin `rule`, assigned to `self` again), in the status it had before; a state the copy does not
  hold yet reopens nothing. A task the owner closed stays closed, as a dismissed one does.
- **The owner's reopen.** Any status change of the owner after the sync's own close (its bot, `rule`; an agent's
  close is not the sync's) is the owner's call. It holds against the issue going to someone else or to no one for
  good. Against any other close it holds until a sync sees nothing closing the task (the issue open work and the
  owner's); the issue's next close then closes the task again. The sync keeps those ends in
  `tracker:owner-reopens-released`. To know them it reads the status events of every open task from an issue on
  each sync: one local query a task.
- **Limits.** The sync reads the tasks in the account's inbox: a task the owner moved into a project keeps its title
  and state. The issue's title wins over a title the owner gave the task.

## Commands

`addTrackerCommands(program, { app, open })` mounts `sync`, `issues list|show|search|assign`, and `list` for
`projects`, `teams`, `users` (each with its person), `states` and `labels`. Every text field from the tracker is named
in the row's `untrusted`. Each list narrows by its query, as `deals list` does:
`issues list team:<id> assignee:none type:started`, and `archived:include` for archived rows too.

## A tracker described as data

`trackerSourceFromManifest(manifest, { api, call, hooks? })` builds a `TrackerSource` from the generated API manifest
and a `TrackerManifest`, as `crmSourceFromManifest` does for a CRM. Each kind names a `list` call, a `changes` call
whose `variables` hold `"{since}"` (the cursor less `overlapMs`, ten minutes by default), an `ids` call that selects
only the id, and a `map` from our fields to paths in a row, in the CRM manifest's rule language. A selected object
the tracker answers `null` (`project: null`) is none, so the stored link is cleared.

Over GraphQL a call's `selection` replaces the operation's default one, so a tracker reads `state { id }` or
`labels { nodes { id } }`. `parseTrackerManifest` refuses a map path the selection leaves out, before any request:
a field missing from the request would read as "the tracker cleared it". The variables travel as the request body;
the selection rides on the request as `selection`, which the `api` group's GraphQL executor sends.

`self: { call, path }` names the signed-in user. `hooks.after` corrects a record; `hooks.extend` adds methods.

A `wirecat.config.ts` with `category: "tracker"` needs its `source`; `spec.kind: "graphql"` names an introspection
result.

## The contract kit

`trackerSourceContract(make)` checks an adapter: full lists in the domain's shape, every held row listed, a cursor
read again, `ids()` covering the full list, a dead cursor answering reset, a clock off by ten minutes either way, an
archived row still listed, a deleted row leaving `ids()`, a list cut after its first page, a spent budget ending a
call that pages inside, and `self()`, when the tracker has it, naming one of its users. `fakeTrackerSource` and
`exampleTrackerRows` are an in-memory tracker for tests.

A source built from a manifest runs the contract with no code for the service, as a CLI made from `wirecat.config.ts`
does in its generated test:

```ts
for (const { name, run } of trackerManifestContract(SOURCE, { api, definitions })) it(name, run)
```

- `trackerManifestFake(manifest, { api, definitions })` is cli-base's strict `graphqlFake` with a tracker behind it:
  three rows of each kind, sampled within every selection the kind's calls send. The values the map reads are written
  where it reads them: ids `issue-1`, a fixed seeded time, a state type from `STATE_TYPES`, an enum's own value. A
  field that points at another kind (`state.id`, `assignee.id`, `labels.nodes` with `each`) holds that kind's first
  row.
- It answers each call within its selection, two rows a page by the operation's cursor. A change read keeps the rows
  whose `updatedAt` is at or after the value at its `"{since}"` (after it, for `gt`), oldest first. An operation that
  takes `includeArchived` hides archived rows unless the call sets it.
- The only filter it applies is that since, and it must sit at `<the map's updatedAt path>.gte` or `.gt` inside
  `filter`. Every call is refused when the since sits elsewhere (`createdAt.gte`, `updatedAt.lt`), when a list or id
  call sends a `filter` (sync would mark the rows it leaves out deleted), and when a change call's `filter` holds
  anything beside the since. Any other variable the fake cannot interpret, such as users' `includeDisabled: true`,
  is trusted: it only picks which call of the manifest is answered, and the fake answers as if the tracker applied it.
- A call whose fixed variables match no call of the manifest, a cursor the fake never gave and an unreadable since are
  refused and listed in `fake.refusals`, beside `graphqlFake`'s own (an unknown variable, a field the type lacks).
  `touch`, `archive` and `remove` change a row on the tracker's side. Building the fake fails for a kind with
  `changes` whose `updatedAt` the map does not read from a path.
- `trackerManifestFixture` adds the source over it, the ids it holds per kind (`held`), a dead cursor (`"not a
  time"`, which the source answers with `reset` itself, without a call: the case checks the source, never the fake or
  the tracker's own refusal of a stale cursor), and the faults
  on the issue kind, else the last kind with `changes`: `skewed` and `change`, `archive` when the map reads
  `archivedAt`, and `remove`. `trackerManifestContract` runs `trackerSourceContract` over it and fails a case whose
  calls the fake refused, with the refusals as its message.
- It answers GraphQL operations paged by a cursor only. It answers `self` with the first user, the one every row that
  points at a user names, so a sync over it makes the owner's tasks from its open issues.
