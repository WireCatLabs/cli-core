# Project evidence gathering

`gatherProjectEvidence` from `@wirecat/cli-core/services` collects cited evidence for one project from
explicitly selected stored sources: messages, mail and imported documents. It plans and bounds the reads,
deduplicates references across search lanes and returns a reference-only checkpoint to resume from. It
writes nothing: no entity, relationship, fact, task or migration. Interpreting the evidence is the agent's
job; matching it to entities is a later slice.

## Request

```ts
import { gatherProjectEvidence } from "@wirecat/cli-core/services"

const result = await gatherProjectEvidence(
  { evidence: store.contextEvidence, index: store.contextIndex, fetcher },
  {
    project: { name: "Harbour", key: "HRB", background: "Port expansion bid", aliases: ["NBB"] },
    keywords: ["berth tender", "crane"],
    people: [{ name: "Alice Example", reference: "person:12" }],
    sources,
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
- **People.** A person's lane finds what mentions the name. A name is not an identity, and a person's other
  conversations are not project membership: an item found only through person lanes has
  `context: "person-only"`.
- **Window.** `lookbackDays` (default 60, at most 730) before `asOf` (default now), or an explicit
  half-open `after`/`before`; `before` left out is `asOf`, frozen with the run. Windows longer than 90 days are read in 90-day chunks, newest first. Each
  item keeps its `timeKind`: an imported document's `stored-update` time is when it was stored, not when
  its content happened.
- **Fetch.** `fetch: "before-read"` calls the host's `ProjectSourceFetcher` once per source before reading.
  It answers `fetched` or `unsupported` with a history of `complete`, `partial` or `unknown`; a `CliError`
  becomes that source's `failed` state with its code. A failed fetch is coverage, not absence: the store is
  still read.

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
therefore leaves no lane or person unread while another went deep. `stopped` names the budget that ended
the invocation.

## Units, coverage and resume

Every unit reports `state`: `pending`, `partial`, `done`, `unavailable`, `failed` or `read-limited` (one
page is larger than `maxPageBytes`), and `issue` (an error code, or `index-pending` / `index-missing` /
`index-unknown`). `completeness` is always `unknown`: an exhausted search does not prove the archive holds
nothing more.

While any unit can still be read, `checkpoint` is an opaque string. Pass it back with the same request to
continue. It holds the frozen window, per-unit cursors, fetch states, hashes of the references already
returned and cumulative `totals` — no text. A resumed run keeps its window even when `asOf` was "now".
The same `runKey` (default: the request's fingerprint) with a changed project, lanes, people, sources,
scope, window or fetch mode is refused. Budgets may change between invocations.

`items` holds only references new to the run, with a 300-character excerpt and the lanes that found them;
a reference returned earlier and found by another lane later appears in `matchedAgain`.
