# Project evidence gathering

`gatherProjectEvidence` from `@wirecat/cli-core/services` collects cited evidence for one project from
explicitly selected stored sources: messages, mail, imported documents and meeting transcript cues. It plans and bounds the reads,
deduplicates references across search lanes and returns a reference-only checkpoint to resume from. It
writes nothing: no entity, relationship, fact, task or migration. Interpreting the evidence is the agent's
job; matching it to entities is a later slice.

## Request

```ts
import { gatherProjectEvidence } from "@wirecat/cli-core/services"

const result = await gatherProjectEvidence(
  { evidence: store.contextEvidence, index: store.contextIndex, coverage, fetcher },
  {
    project: { name: "Harbour", key: "HRB", background: "Port expansion bid", aliases: ["NBB"] },
    keywords: ["berth tender", "crane"],
    people: [{ name: "Alice Example", reference: "person:12" }],
    sources,
    linkedChats: [{ provider: "telegram", account: "500", chat: "-1001" }],
    scope: "explicit",
    fetch: "before-read",
  },
)
```

- **Scope.** `sources` are concrete, host-resolved `ContextSource` identities (1–32), the same ones
  [`createContextEvidenceReader`](CONTEXT-EVIDENCE.md) takes. `scope` is required: `explicit`, or
  `all-connected` when the host froze every connected account into `sources`. An omitted scope or an empty
  list is refused before any read. Core never expands scope itself.
- **Lanes.** The project name, its key, each alias, each keyword and each person's name is one lane: 1–16 literal
  words, all of which must match. Lanes are alternatives (OR); the same query given twice is one lane with
  both kinds. At most 16 lanes.
- **Linked chats.** `linkedChats` (at most 16) are the chats the host confirmed as the project's: a
  `member-of` link from `chat:<provider>/<account>/<chat>` to the project, with `confirmed` set. Choosing
  confirmed links is the host's job; Core checks only each entry's shape (`provider`, `account`, `chat`) and refuses
  one chat given twice. Each chat is read whole, newest first, through the selected source of its own account (a
  `mail` source for `provider: "email"`, a `message` source otherwise), even when the chat is hidden from search.
  It is its own lane: `kinds: ["linked-chat"]`, `query: null`, `chat: <reference>`, numbered after the word lanes.
  An item found only that way has `context: "linked-chat"`, a 300-character excerpt from the start and no
  `around` (its neighbours are the lane's own items). A chat whose account is not in `sources` is never read and
  never falls back to another account: the result's `linkedChats` lists every entry with `ref`, `source` and
  `lane` (both null when unread), `state`: `in-scope`, `out-of-scope` (its account is outside `sources`) or
  `unavailable` (the chat is not stored), `items` (new items its lane returned in this invocation) and `capped`
  (it reached its per-chat limit and has more to read; see Budgets and order).
- **People.** A person's lane finds what mentions the name. A name is not an identity, and a person's other
  conversations are not project membership: an item found only through person lanes has
  `context: "person-only"`. A reference several lanes find keeps the strongest context: `project`, then
  `linked-chat`, then `sender`, then `person-only`.
- **Senders.** A person given with `senders: [{ provider, id }]` (1–16 of their stored identities; an email
  identity's id is its address) and a `reference` gets a lane of its own: `kinds: ["sender"]`, `query: null`,
  `people: [<reference>]`, `senders`, numbered after the word lanes and counted in the 16. It reads every message
  or mail one of those identities wrote in the window, in chats open to search, through each selected source of
  the identity's provider only: a Telegram identity is never looked for in MAX, and an account outside `sources`
  is never read. Its `name`, when given too, is still a word lane; without senders `name` is required. An item
  found only that way has `context: "sender"`, a 300-character excerpt from the start and `around` like any
  message hit: the person wrote it, it need not name the project.
- **Window.** `lookbackDays` (default 60, at most 730) before `asOf` (default now), or an explicit
  half-open `after`/`before`; `before` left out is `asOf`, frozen with the run. Windows longer than 90 days are read in 90-day chunks, newest first. Each
  item keeps its `timeKind`: an imported document's `stored-update` time is when it was stored, not when
  its content happened.
- **Fetch.** `fetch: "before-read"` needs the host's `coverage` and `fetcher` (`ProjectChatFetcher`). Before the
  first read of a run (never on a resume) it asks `coverage` what the store holds of each linked chat in `sources`,
  and calls `fetcher.fetch({ account, chatId, after, before, until, signal, onProgress })` for each chat it does not hold for
  the window: not `complete`, and not up to date with no gaps back past `after`. One at a time, inside one budget
  for all of them, `budgets.maxFetchMs` (default 3 minutes, at most 30); `signal` aborts when it runs out. The
  answer is `complete`, `partial` or `failed` with an optional `reason`. A chat cut by the budget is `partial`
  (`fetch-budget`), a chat not started before it ran out `skipped`, and a `CliError` is `failed` with its code. The
  result's `fetch` lists each chat tried; the reads that follow, and the `linkedChats` coverage, see what it saved.
  A failed fetch is coverage, not absence: the store is still read. The read budgets start after the fetch.
  `onFetchProgress` on the ports hears each chat's pages (counts only), for a heartbeat.

- **Stored project.** `gatherStoredProject(store, input)` is the whole `projects evidence` over a store: the
  project's name, key and aliases, confirmed person members and confirmed linked chats, in the sources the host
  resolved; `projectsCommand(messenger)` from `@wirecat/cli-core/cli` mounts it as `projects evidence` in a
  messenger CLI, with `--sync-first` syncing through the profile's own connection.

- **Index.** New mail and imported documents wait in a queue before the word index holds them, and the
  context reader reads only the index. With `index: "update"` (the default) the service first runs the host's
  `ContextIndex` (`store.contextIndex`): the same fills a mail search and the notes search run. `index: "as-is"`
  skips it. The result's `index` says `updated` (with counts), `as-is`, `unavailable` (the host gave no port) or
  `failed` (with the error code, such as a read-only store); reads go on either way, and a source still behind
  shows `index-pending` on its units. A message is indexed when it is saved. The fill is a local write to the
  index, never to the records, and is not bounded by the read budgets.

- **Around a hit.** With the host's `neighbours` port (`storedNeighbours(store)`; `storedMessageNeighbours(store.messages)`
  for chat messages only), each message or mail hit carries `around` — for mail, the emails before and after it in
  its thread, with sender and subject: up to `around.before` and `around.after` (default 2 each, at most 5) stored messages next
  to it in its chat, as 200-character excerpts with their references. They are context for reading the hit, not
  matches: they never join `items`, and `found` says whether a neighbour is a hit itself. Their bytes count
  against `maxReadBytes` (`usage.aroundBytes`); when it runs out, a hit has `aroundIssue: "read-bytes"`.
  A document hit needs no port: its `around` is the paragraphs (split at blank lines) before and after the first
  one that names a word of any of the request's lanes, in document order, whichever lane found the document, as
  200-character excerpts. The hit's own paragraph is included with `found: true`; every entry carries the document's
  reference. `moreMatches` counts the paragraphs after it that also name a lane word, shown in `around` or not. It
  is worked out from the text already read: no extra read and no extra charged bytes.

Hosts can reuse the pure `documentPassage(text, query, { before, after })` helper from `./services`
when reviewing an already-read document. It returns the same 200-character paragraph excerpts and
`found` marker without store, network or model access. The host retains reference/account binding,
input-window validation, read limits and the decision to omit context in a brief view. A word match
is a location hint, not evidence that the document supports a finding.

## Who wrote the evidence

`people` answers "who is involved in this project": everyone who wrote a message or email among this invocation's
`items`, counted from the stored sender identity, never from names in the text. Identities the store links to one
person are one entry, `person: "person:<id>"` with the person's `name`, and list every `identities` entry
(`provider`, `account` it was read through, `id`) seen in the run; an identity linked to no person is an entry of its own
with `person: null` and its stored name. `items` counts the items each wrote, and `contexts` splits that count by
item `context`. The owner's own messages are left out: they say nothing about who else is involved. Documents,
meeting cues, records with no stored sender and the `around` neighbours are not counted. Sorted by items, most first,
at most 20 entries; `peopleOmitted` says how many more there were. Each invocation counts only its own new items: across resumed
invocations the caller adds the counts up. Items themselves carry no sender, so the result stays the size it was.

## Other names in the evidence

`findEvidenceMentions(store.knowledge, result, { exclude: "project:<id>" })` reads the project, tag and topic
vocabularies and names every entry whose name, key or alias stands as whole words in the returned excerpts and
their neighbours. Each match cites the reference it was found in (`in: "hit"` or `"around"`) and says whether the
term belongs to more than one entry (`ambiguous`). It is evidence to review, never membership: a meeting about
the project can name three others. A vocabulary too large for its read budget is listed in `coverage.skipped`
instead of failing the run. It writes nothing.

## Budgets and order

`budgets` are per invocation: `maxReads` (default 48, or one read per lane × source × chunk when that is more, up
to 512, so one round always finishes), `maxReadBytes` (2 MiB), `maxPageBytes` (64 KiB),
`maxElapsedMs` (60 s) and `maxItems` (100 new items). Each read is a fresh single-source scoped reader, so
authorization and response validation are the context reader's own.

Reads go in rounds: the first page of every lane × source × chunk unit before any second page. A cut budget
therefore leaves no lane or person unread while another went deep. A linked chat has one unit per chunk, on its
own account's source, with the same 20-record page and `maxPageBytes`; its units come after every word and sender
lane's in each round, so a word lane labels a shared hit first. Each linked chat returns at most
`max(20, floor(maxItems / (open linked chats + 1)))` new items per invocation: an even share of `maxItems` for every
linked chat that still has an open unit when the invocation starts, plus one for the word and sender lanes together
while any of them has an open unit, never less than one page. With the default 100 items and the word lanes open that
is 50 for one chat, 33 for two and 20 from four chats up. A chat that finished in an earlier invocation takes no
share, and once the word and sender lanes are done too, a chat left alone gets the whole 100. A chat that reaches it is not read further in this
invocation: its entry in `linkedChats` has `capped: true`, the run is not complete, and the checkpoint continues it
with a fresh share. So one busy chat cannot fill a run while the other chats and the word lanes wait for the cursor.
`stopped` names the budget that ended the invocation; it stays `null` when only linked chats were capped.

## Units, coverage and resume

A page holds the records that fit `maxPageBytes` together. A record larger than that is read alone, once per run however many lanes
match it, with up to 256 KiB of the remaining `maxReadBytes`. A record above 256 KiB is not read: `oversized` lists its `ref`,
`bytes`, the lanes that matched it and its source, and the unit moves past it. Open it by reference instead.

Every unit reports `state`: `pending`, `partial`, `done`, `unavailable`, `failed` or `read-limited` (the
budget ran out before a large record's own read; a resume reads it), and `issue` (an error code, or `index-pending` / `index-missing` /
`index-unknown`). `completeness` is always `unknown`: an exhausted search does not prove the archive holds
nothing more.

While any unit can still be read, `checkpoint` is an opaque string. Pass it back with the same request to
continue. It holds the frozen window, per-unit cursors, fetch states, hashes of the references already
returned and cumulative `totals` — no text. A resumed run keeps its window even when `asOf` was "now".
The same `runKey` (default: the request's fingerprint) with a changed project, lanes, people, sources,
scope, window or fetch mode is refused. A changed set of linked chats is refused first, with "the project's
linked chats changed; start again without --cursor". Budgets may change between invocations. A run without
linked chats or senders keeps the fingerprint and checkpoint it had before either existed, so those checkpoints still
resume.

`items` holds only references new to the run, with a 300-character excerpt and the lanes that found them;
a reference returned earlier and found by another lane later appears in `matchedAgain`.

## Staging findings for review

Every item carries `fingerprint`: a hash of its reference, title, full stored text and revision.
`store.contextRecords.read(ref)` reads the same record by reference, so `contextEvidenceFingerprint(record)` is
the item's fingerprint for as long as the text is unchanged.

`store.evidenceFindings` stages an agent's cited facts and follow-ups about one project, from message, mail and
document references, and reviews them. It is a sibling of [reviewed meeting findings](MEETING-FINDINGS.md) and
shares their rules and code: 1–16 findings, a stable batch key (the same key and input returns the same batch;
other input under that key is refused), facts of an existing type, tasks with an explicit or inferred commitment,
dates and assignees only with supporting references, and a receipt that reuses earlier decisions on unchanged
candidates and refuses to accept one rejected before. What differs:

- **Evidence.** Each reference must name a stored message, email or document whose current fingerprint matches;
  otherwise the batch is stale (`evidence-findings.stale`) at staging. A review that accepts findings rechecks
  only the accepted ones: their project, assignee and evidence must be unchanged, while another finding's changed
  text no longer blocks them. A batch staged by an earlier version still needs all of it unchanged. Rejecting a whole
  stale batch still works, so it does not stay open forever. There is no
  membership check: the project must exist, and whether the evidence belongs to it is what the reviewer decides.
- **One project per batch**, held as the proposal's target, so `list({ project })` reads one project's batches.
- **Who decides.** `review(id, { fingerprint, accept, by })` takes `by: "owner"` (the default) or
  `{ bot, model?, reason }` — an agent the host lets decide for the owner. The receipt records the decision and
  its reason, and the proposal's decider is the agent. Created facts and tasks are attributed to the authoring
  agent either way and stay editable through the usual fact and task commands.

Generic proposal approval, rejection and staging refuse this kind (`evidence-findings.dedicated-review`).
