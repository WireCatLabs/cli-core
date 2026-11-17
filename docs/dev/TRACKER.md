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
| `self?(context?)` | the sign-in's own user id |

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
  while rows are stored, when it would mark more than half of ten or more stored rows deleted, or when the sign-in
  reported a gap for the kind: a tracker that lost rights lists none of what it can no longer see.
- **Failures.** A kind that fails is named in its result's `error` and the others still sync. A page that says there is
  more but gives no next page fails the kind.
- **`rescan`.** Lists everything again and every id, dropping a round in progress, and lets a held pass through. A
  rescan that stops goes on as one in the next run.

A save merges: a field the read left out keeps its stored value, so a partial selection never erases.

## `store.tracker`

`save`, `removeUnlisted`, `get`, `issueByKey` (`ENG-12`, any case), `list` with issue filters (team, project,
assignee or none, state, state types through the state rows, label, archived), `find` over the word index
`tracker_item_words` (titles, descriptions, comment bodies), `count`, and `people`: the tracker users whose e-mail an
identity linked to a person has, joined when read. Nothing is written to the people graph.

## An issue as the owner's task

`trackerIssueTask(store, account, issue)` and `issues task <issue>` make an issue the owner's task: `source` is
`tracker:issue/<externalId>`, `sourceKind` is `tracker_issue`, and the title is the issue's key only. The task links
to the issue and copies none of its text. The same issue again answers the task it already has.

## Commands

`addTrackerCommands(program, { app, open })` mounts `sync`, `issues list|show|search|task`, and `list` for
`projects`, `teams`, `users` (each with its person), `states` and `labels`. Every text field from the tracker is named
in the row's `untrusted`.

## The contract kit

`trackerSourceContract(make)` checks an adapter: full lists in the domain's shape, every held row listed, a cursor
read again, `ids()` covering the full list, a dead cursor answering reset, a clock off by ten minutes either way, an
archived row still listed, a deleted row leaving `ids()`, a list cut after its first page, and a spent budget ending a
call that pages inside. `fakeTrackerSource` and `exampleTrackerRows` are an in-memory tracker for tests.
