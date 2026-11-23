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

A tracker that takes writes has a `TrackerWriter` beside its source (`src/tracker/writer.ts`):

| Member | What the adapter does |
|---|---|
| `writes` | which of `create`, `update` and `comment` it takes (`TRACKER_WRITES`) |
| `createIssue(draft, options)` | a new issue from `TrackerIssueFields` with its `title`; answers the whole issue |
| `updateIssue(id, patch, options)` | changes the fields given, `null` clearing one, `labels` replacing the list; answers the whole issue |
| `comment(issue, body, options)` | a comment on the issue, by its tracker id; answers the comment |

Every field is the tracker's own id. `options` carries the write's `operationId` and the keys the owner was already
asked about (`confirmed`). None of them retries: a lost answer throws `outcome_unknown`. An answer with no record (Linear's
`success: false` without an error) is `invalid_response`, and the copy is not told the write was made; an adapter
whose write was made but could not be read back throws with `sent: true`.

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

`addTrackerCommands(program, { app, open, writes? })` mounts `sync`, `issues list|show|search|assign`, and `list` for
`projects`, `teams`, `users` (each with its person), `states` and `labels`; with `writes`, the writer's
`TrackerWriter.writes`, also `issues create`, `update` and `comment` ([Writes](#writes)). Every text field from the
tracker is named in the row's `untrusted`. Each list narrows by its query, as `deals list` does:
`issues list team:<id> assignee:none type:started`, and `archived:include` for archived rows too.

## Writes

`issues create --title <title>`, `issues update <issue>` and `issues comment <issue> --body <text>` run
`createTrackerIssue`, `updateTrackerIssue` and `commentTrackerIssue` (`src/tracker/writes.ts`), over the
`TrackerWrites` the open profile's `TrackerRun.writes(command)` builds: the writer, the app and the profile's levels.

- **References from the copy.** `--team` takes a team's id, key or name; `--state` a state of the issue's team, by id
  or name; `--label` (repeated, replacing the list) a label of the issue's team or of no team, by id or name;
  `--project` a project by id or name; `--assignee` a user by id, name or e-mail; `--parent` and `<issue>` an issue's
  key or id. The issue's team is the one named, else the copy's: an update that moves the issue looks in the new team.
  A name matches in any letter case and only when one row of the account's copy has it, every row read, not one
  page; two are refused with both as `candidates`, none with `tracker.reference`. A new issue without `--team` goes
  to the copy's only team; several teams are refused with the choices, and none says to sync
  (`tracker.team-required`). `--priority` is 0 to 4 or none, urgent, high, medium, low.
- **Clearing.** An empty value clears `--description`, `--assignee`, `--project` and `--parent`, and sets `--priority`
  to 0, none; one empty `--label` clears the labels. A title and a state are never empty; an update with no field is
  refused.
- **Guard and journal.** Each write checks its command path, `issues.create`, `issues.update` or `issues.comment`
  (`TRACKER_WRITE_KEYS`), through the profile's guard (`profileWriteGuard`, shared with the CRM and content writes): a
  `deny` or `readonly` refuses, `ask` asks once at a terminal and needs `--yes` otherwise, and the setup ceiling caps
  every level. No built-in level tightens these three: as `deals.create`, they go ahead unless the profile says
  otherwise.
  The write's journal line carries the answer's `operation_id` (a manifest writer's `serviceApiWriter` adds its own
  line under `api.*`, as content's does); a lost answer is `outcome_unknown` with that id, and the owner
  syncs and looks before writing again, since a tracker does not recognise a repeat. `--dry-run` previews and sends
  nothing.
- **Someone else's issue.** An `--assignee` other than the sign-in's own user also checks `issues.assign-others`
  (`TRACKER_ASSIGN_OTHERS_KEY`), `deny` by default (`TRACKER_WRITE_DEFAULTS`) as `crm.assign-others` is; a profile
  lifts it with `issues.assign-others: allow` or `ask`. The own user is the `tracker:self` a sync keeps, asked of the
  source once when none is kept (`trackerSelfOf`); a tracker that cannot say treats every assignee as somebody else.
  A CLI adds `TRACKER_WRITE_EXTRA_KEYS` to `commandPermissions({ extra })` and `trackerAlsoChecks()` to its
  `alsoChecks`, so `--dry-run` names the key.
- **The answer is stored.** The tracker's answer is saved with `store.tracker.save`, as a sync saves a page, so
  `issues show` and the lists have it at once. A save that fails is `invalid_response` with `sent: true`: sync to store
  it, never write it again. The answer is the issue or comment as the read commands show it, its fields from the
  tracker named in `untrusted` (`issue.title`, `comment.body`). The owner's tasks follow the change at the next sync.

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

`writes` maps each write to a mutation, in the shape the CRM manifest's writes use: `writes.issue.create` and
`.update`, `writes.comment.create`, each a call whose `variables` hold `"{values}"` (and an update's `"{id}"`), and
`fields`, our field to where it goes inside the values (`{ to: "stateId" }`). The tracker answers the written row at
the call's `items`, read by the kind's `map`. `parseTrackerManifest` refuses a write whose operation is a read or is
missing, a call without its slots, a field the kind does not write (`TRACKER_WRITE_FIELDS`), a create of an issue
without `title` or of a comment without `issue` and `body`, a comment update, a `"{since}"` in a write or an `"{id}"` in
a create, and a selection that leaves out a path
the map reads. Where `to` points inside the input type is checked by the fake, against the schema. Linear's:

```ts
const issueRow =
  "id createdAt updatedAt archivedAt identifier title description url priority dueDate completedAt canceledAt " +
  "state { id } team { id } project { id } assignee { id } creator { id } parent { id } labels { nodes { id } }"
writes: {
  issue: {
    create: {
      operation: "issueCreate",
      variables: { input: "{values}" },
      selection: `success issue { ${issueRow} }`,
      items: "issue",
    },
    update: {
      operation: "issueUpdate",
      variables: { id: "{id}", input: "{values}" },
      selection: `success issue { ${issueRow} }`,
      items: "issue",
    },
    fields: {
      title: { to: "title" }, description: { to: "description" }, team: { to: "teamId" }, state: { to: "stateId" },
      assignee: { to: "assigneeId" }, priority: { to: "priority" }, labels: { to: "labelIds" },
      project: { to: "projectId" }, parent: { to: "parentId" },
    },
  },
  comment: {
    create: {
      operation: "commentCreate",
      variables: { input: "{values}" },
      selection: "success comment { id createdAt updatedAt archivedAt body url issue { id } user { id } }",
      items: "comment",
    },
    fields: { issue: { to: "issueId" }, body: { to: "body" } },
  },
}
```

`trackerWriterFromManifest(manifest, { api, write, command })` builds the `TrackerWriter`. `write` is the CLI's
`serviceApiWriter`, the `api` group's own write path, bound to the command the owner ran: it checks the operation's
`api.*` key and the body against the schema too, so `api.issue-create: deny` stops `issues create` as well. The keys
the tracker's command asked about are passed on as confirmed, so the owner is asked once. A field the manifest does
not write is refused before anything is sent (`tracker.write-unsupported`). A value is sent as given; the owner's text
is never filled as a slot.

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
- With `writes`, it answers the mutations: a create adds a row, an update changes the row its `"{id}"` names, each
  answered within the call's selection at its `items`, and an update of an id it does not hold gets the tracker's own
  error. `graphqlFake` refuses variables that break the input schema (an unknown field, a missing required one such as
  Linear's `teamId`), and the fake also refuses a value no write rule names.
- It answers GraphQL operations paged by a cursor only. It answers `self` with the first user, the one every row that
  points at a user names, so a sync over it makes the owner's tasks from its open issues.

The write side has its own kit. `trackerWriteContract(make)` checks a `TrackerWriter`: its `writes`, a create
answering the whole issue in the fields it was given, a one-field update keeping the others, an update clearing the
assignee, project and labels, a comment answered with its body as written (slot-like text included), and a lost answer
being `outcome_unknown` after one request. `fakeTrackerSource` is a writer too (`sent`, `loseNextAnswer`). A writer
from a manifest runs it over the fake, failing a case whose calls the fake refused:

```ts
for (const { name, run } of trackerManifestWriteContract(SOURCE, { api, definitions })) it(name, run)
```
