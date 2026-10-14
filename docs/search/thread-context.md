# Reply-chain context

The shared CLI and MCP factories support stored thread context. Consumer CLIs need the package version
containing it. `messages context --thread` follows a hit's parents and chosen replies through the stored
conversation graph. `search messages --thread` attaches the same result to each hit as `thread`.
Messages are oldest first; `chain` names parents nearest first. The hit alone carries `anchor: true`.
Use a `msg:` locator to identify a message across rebuilds. Conversation ids are not stable references.
A locator from another account is refused by `messages context`: select that profile first.

Graph context is local. It opens no messenger connection, loads no model and performs no build, write or
mark-read action. Plain `messages context` and search `--context` remain the separate time-based view.
Search may request both views; `context` retains time neighbours and `thread` contains graph context.

Defaults per context: 8 links from the hit in either direction, 50 messages, 65,536 bytes of whole
message/link JSON, and 24 hours either side of the hit. Set `--thread-hops`, `--thread-messages`,
`--thread-bytes` and `--thread-within`. Maximums are 50 hops, 500 messages, 1 MiB, 30 days; zero hops gives
only the hit. Account, chat and native-topic boundaries are never crossed. The byte cap covers whole message/link
data; the bounded metadata envelope is additional. An oversized hit returns no message data and
`stopped: ["bytes"]` rather than clipping its text.

The result has `ref`, `chat`, `message`, `mode`, `items`, `links`, `chain`, `stale`, `stopped` and
`bounds`, and the graph snapshot's `builtAt` (null without a build). Every returned link has `messageId`, `parentId`, `source`, `kind`, `confidence`, `method`,
`version`, `createdAt`, `chosen` and `stale`. Confidence is the provider/rule/agent's weight, not a calibrated
probability. A null parent is an agent's explicit conversation start. Pretty output prints link evidence
beside the messages. JSONL for thread context emits one context record; search JSONL emits hits with their
thread field. Diagnostics go only to stderr.

Changes, edits and deletions are checked at read time. Stale edges are visible as evidence but never followed;
deleted text is never returned. Revisions in the same millisecond as the build are conservatively stale.
The reader checks only the bounded component, not the whole chat. `stale: false` does not certify that all
new replies have reached the graph. The build time identifies the snapshot; `conversations status` checks
whole-chat freshness separately. Outdated rules are marked stale. Rebuild explicitly to use fresh grouping.
A hit added since the build uses a labelled `not_linked` time fallback.

`stopped` can contain `hops`, `messages`, `bytes`, `time`, `thread`, `links`, `cycle` or `aborted`.
Message and link reads are capped too; excessive or invalid candidate links can stop with fewer returned
messages than the limit. An answer with a stop reason is partial, and an empty answer does not prove no
reply existed. The reader never silently changes the bounds or crosses a stale edge to fill the answer.

When no graph exists, `mode: "time"` and `fallback: "not_built"` say the answer is bounded local time
context. A hit not included in the snapshot says `not_linked` and is marked stale. A missing/deleted hit says `not_stored`. The same byte/message/time/topic caps hold for these fallbacks. The before/after
options set the cheap time window only; they do not set graph depth.

MCP `messages_context` and `search_messages` accept `thread`, `thread_hops`, `thread_messages`,
`thread_bytes`, `thread_within`. Context accepts a locator in `chat` without `message` when `thread` is true.
These are ordinary message reads, available on readonly profiles. Message search still scopes every hit
and its graph by that hit's qualified account locator, including explicit cross-account local searches.
Thread bounds are independent of `--sync-first` network bounds.
