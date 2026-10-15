# Refresh before searching

Search reads the local store, and where the messenger's server can search, asks it too (`--backend`,
[query language](query-language.md#поиск-на-сервере-мессенджера)). Add `--sync-first` to `search messages`, `stats messages show` or
`search conversations` to fetch new messages before reading it. No message is marked read.

The refresh uses the active profile's archive fetch. `--chat` and required `chat:` filters select the chats;
otherwise it starts with the most recently active stored chats. Defaults are 5 chats, 30 seconds and 500
messages in total. Change them with `--max-chats`, `--sync-time` and `--max-messages` (maximums 100 chats,
5 minutes, 10,000 messages). The time budget stops between requests; the current request is awaited under
its existing request/command timeout. There is no detached fetch after the answer.

Each chat stops at its previously newest stored message, or at the start of history if nothing was stored.
This is a recent refresh, not a repair of old gaps and not proof that the whole history is held.

JSON adds `refreshed: { chats, messages, failed, complete }`: `chats` lists attempted chat ids and `messages`
counts messages returned in fetched pages, including already held messages. Failures name only an account,
chat and stable reason, never provider error text. `complete` says the selected refresh finished within the
bounds. Chat/message/time bounds or failures keep the local answer and set `coverage.state` to `stale`.
Diagnostics go to stderr. JSONL still streams hit rows; refresh diagnostics go to stderr.

Cross-account local search still works. A refresh only uses the active account's connection; other selected
accounts are reported as `account_not_connected`. Offline operation reports `offline`. MAX's pushed-history
mode reports `pushed_history`: keep its server running to ingest new messages. This option does not invent a
second network path. Provider errors use `fetch_failed`; exhausted time/cancellation uses
`time_or_abort_bound`, and exhausted message bounds use `message_bound`.

`search conversations --sync-first` fetches messages but does not rebuild the graph or embed them. Add the
existing `--catch-up` for that separate local work. With both flags, `refreshed` retains the existing graph
report and `networkRefreshed` reports the network step. Fresh messages can still leave the graph stale until
it is rebuilt. Saved searches do not save network consent: add `--sync-first` explicitly on each run.

CLI refresh permission is `messages.sync-first`. MCP exposes `sync_first`, `max_chats`, `sync_time` and
`max_messages` only when that key resolves to `allow`; readonly/deny/ask hides the arguments and rejects
attempts, while ordinary local reads remain available. The same service executes CLI and MCP refreshes.

**Server search is a different step.** `--sync-first` reads each chat's newest history into the store;
`--backend both|server` asks the messenger's own search for matches anywhere in time
([query language: «Поиск на сервере мессенджера»](query-language.md#поиск-на-сервере-мессенджера)).
Both write only to the store and mark nothing read. With both flags the refresh runs first, then the
server step, then one local search. The server step has its own key, `messages.server-search`, its own
5-second bound and its own `server` block; it never changes `coverage`.
