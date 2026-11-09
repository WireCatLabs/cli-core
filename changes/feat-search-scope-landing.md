### Added

- **`search all` finds a meeting by its title.** A meeting whose title holds the words, each as the start of a word
  as passages are matched, is a hit of its own (`scope: "title"`, `found_by: ["title"]`), within the 3 hits a meeting
  gives. It ranks with the passages that hold the words, the newer meeting first, and before its own passages. A
  question, whose passages need only some of its words, matches a title that holds every one. With `--exact` a title
  must hold each word whole. The title is matched through the folded title the store already keeps, so no store
  version is needed. A query with `from:`, `"a b"~N`, `project:` or `tag:` matches no title.
- **`meetings list` reads an account's meetings newest first through `meetings_by_time`**, stopping at the limit
  instead of sorting every meeting; a meeting with no start still comes last.
- **`saveAddedSource` takes an optional `sourceKey`** (`<namespace>:<id>`, as `google-drive:<fileId>`). A source
  saved again under the same key is the same document: changed text becomes its next revision, so a memory or fact
  citing it gets a "source changed" review from `knowledge.checkSources` instead of a second copy beside it, and the
  same text changes nothing. Different keys stay separate. The answer has a new optional `changed` field: whether
  text was written; a host store that wraps `saveAddedSource` may leave it out. No store migration.

### Changed — may break callers

- **`search all` reads meetings from every meeting account, through their search index, ranked with the other
  sources.** Meetings are one more resource of `searchAll` (`RESOURCES_SEARCHED` ends with `meetings`). Without
  `--source`, every meeting account of the scope of the caller's stored account is read, so a work profile never
  reads personal meetings; `meetingScopes` widens it. A named account of another scope is skipped with its scope.
  With no meeting account to read, a caller that named meetings (`meetingsAsked`, from `--only meetings`) gets a
  `meetings` skip with `not_found`; any other answer says nothing of meetings. `--source zoom:<account>` reads only
  that one, and `--source zoom` or `meetings` reads them all instead of refusing several. The meeting query language
  applies: phrases, OR, NOT, `"a b"~N`, `from:` (who said it), `date:` in `--timezone`, and `--exact`. A field
  meetings lack (`in:`, `chat:`, `filename:`) skips meetings with the reason; a failure of one account (`from:` naming
  two speakers) skips only that account. One meeting gives at most 3 passages, each its own hit, with an excerpt of
  about 240 characters instead of 2000. Search all never builds the index: `meetings` in the answer has
  `indexing: "ready" | "pending"` and `hasMore` per account, and the CLI answer names a pending account in `missing`.
  Meeting hits carry `foundBy` (`found_by`); a hit found only through a garbled spelling says so with
  `match: "corrected"` and `corrections`, and the excerpt is centred on the words the index matched (`searchHits` hits
  carry them as `matchedWords`, with `speakerName`). Each account's index is read 200 rows a page, and a page past the
  store's 4 MB budget is asked again with half the rows, down to one, before the account is skipped.
- **`--max-meetings` (MCP `max_meetings`) is gone from `search all`**, in the messenger, CRM and calendar commands,
  and so are `MEETINGS_UNNAMED`, the `search.meetings` step, `searchAllWithMeetings` (and
  `messages.searchAllWithMeetings`), `SearchAllWithMeetingsRequest` and `RESOURCES_SEARCHED_WITH_MEETINGS`. Call
  `searchAll` (or `messages.searchAll`) with `source`; its answer is `SearchAllFound`, whose `hasMore` is always a
  boolean. `SearchAllItem` is now `SearchAllRecordItem | MeetingSearchItem`. At their next bump of this package:
  tg-cli and max-cli drop `--max-meetings` from `docs/commands.md`, `docs/dev/test-matrix.md` and
  `scripts/test-matrix-untested.ts`; whatsapp-cli from `docs/commands.md` and its test matrix; gcal-cli and
  bitrix24-cli from their `search all` tests and test matrix.
- **`searchAllIncludingMeetings`, `ResourceWithMeetings`, `MeetingSearchCursor`, `MeetingSearchCoverage` and the
  `SearchAllIncludingMeetings*` types are deprecated**, kept until zoom-cli moves to `searchAll`
  ([zoom-cli#344](https://github.com/WireCatLabs/zoom-cli/pull/344)). `searchAllIncludingMeetings` now calls
  `searchAll`: `meetingAccount` becomes `scope.meetings`, `maxMeetings` and `meetingCursor` are ignored, pages are
  `offset`, and its answer never has `meetings`. `allAnswer` takes either answer.
- **`sharedCommandTemplate(app, "search")` keeps the old `search all`** (its summary and description, the `--only`
  and `--source` wording and `--max-meetings`), while the messenger's own `search all` has the new one. cli-memo,
  zoom-cli and drive-cli review their overrides against those exact values. The template moves to the new shape in
  the release that [cli-memo#703](https://github.com/WireCatLabs/cli-memo/pull/703), zoom-cli#344 and drive-cli's
  matching change ship with; then each updates the `search all` entries of its shared contract overrides.
- **`liftMeetingFields` takes the caller's timezone** as a fourth argument for `date:`; without it, the process's.
- **`contacts prepare` and `contacts events` read only the scope of the account asked.** A person merged across a
  personal and a work account brought every fact, note and task into `contacts prepare`, and every scope into
  `contacts events`. Now the facts, the owner's notes and the tasks of projects with no account come only from the
  asked account's scope, personal or work, or from the scopes the caller passes (`scopes`, as `personContext` takes).
  A fact takes its own scope, then its project's. A note shows only when every scope it touches is read: its
  project's, or those of the projects it is about. A note about the person alone is personal. Anything else unscoped
  counts as personal, so a work profile no longer sees the owner's personal notes. `prepare.coverage.tasks`, `.facts`
  and `.notes` name the `scopes` read. `contacts events` reads the same scopes and refuses `scope:` of another one
  with `permission_error` / `selection.out-of-scope`, where it answered that scope's rows before. A chat pinned to the
  other scope no longer shows in this account's events. `personTimeline` takes `scopes` and answers them.
  `store.people.preparation` needs `scopes`, and `store.involvements.forPerson` takes `scopes` (a list) in place of
  `scope`. `contacts context`, `contacts prepare` and calendar preparation also leave out a chat pinned to a scope
  that is not read, even in a readable account: its shared chat, messages and mentions.
  `store.chats.chatScopes(key, chatIds)` answers each chat's scope, its own or else its account's.

### Fixed

- **The links list and the relationships list read a merged person's old rows too.** `notes.links({ from, to })` with
  the current person now lists links written on a uid merged into them, and `listRelations({ about })` marks such a
  relationship `outgoing` or `incoming` by the person it is about, not by the uid written on it.
