### Changed — may break callers

- **`meetings` commands take the program's `--json [fields]` and `--jsonl`,** not their own on/off flags, so
  `meetings list --json id,title` keeps those fields and `--json --jsonl` together is no longer refused.
- **Lists without `--limit` show the configured `defaults.limit`** (20 unless set), capped at the command's maximum,
  not their own number: `meetings list`, `events list`, `search events`, `search meetings` (also inside
  `meetings batch`), `runs list`, `search runs`, admin reports, rankings evidence, `stats messages counters`,
  `metadata sync` and `tags rebuild` (these two drop from 50 to 20). The MCP tools `meetings_list`, `events_list` and
  `search_meetings` page by the host's configured limit, not 100.
- **Hosts pass `pagingOf`** (exported from `@wirecat/cli-core/cli`) to `addMeetingCommands` and
  `addMeetingSearchCommand`. Changed signatures: `meetingHitSearchRequest(query, flags, limit, signal?)`,
  `prepareMeetingBatch(input, reader, meta, limit)`, `callMeetingTool(store, name, input, { limit, failure? })`,
  `callCalendarTool(…, { accountIds, limit, … })`, `callMeetingSearchTool(search, input, { limit, signal?,
  failure? })`. `flagPaging` in `@wirecat/cli-core/meetings/testing` pages bare test roots.
- **`search events --cursor 0` is refused;** a cursor comes from `page.next_cursor`.
- **`zonedTime` is `typedTime`** and no longer demands a zone.
- **Moderation needs a named profile** and never falls back to `default`; a missing one lists the profiles to name.
- **`factsOf` (mail) is async** and takes a required "written to" lookup.
- **`find` also matches words shorter than three letters,** so `find AI bot` returns fewer, more exact hits.
- **Time errors read** `--x takes an ISO 8601 time, today, yesterday, or 30m, 2h, 1d ago — not "…"` (and `… from
  now` for future times).
- **Needs `@wirecat/cli-base` 0.100.0,** whose query dates take a time without seconds or without an offset.

### Fixed

- **Every time flag takes one grammar:** ISO with or without seconds and zone, a space for `T`, a date alone,
  `today`, `yesterday`, `30m`/`2h`/`7d`. This now holds for `meetings sync`, `search meetings`, `meetings prepare`,
  `meetings scheduled` (CLI and MCP), the media archive (`download`, `jobs install --since-time`,
  `move --before-time`) and `schedule --at-time`. One parser reads every future time.
- **A list query's dates read the computer's zone** for every list (`created_at>"2026-11-14 23:00"` too), and the
  answer names it in `meta.timezone`.
- **The MCP review and catch-up prompts pass `since` as a full instant,** so `2026-11-13T18:00+01:00` and `2h` work.
- **Mail presets count a correspondent from stored outgoing mail too,** so a resumed sync, or an account synced
  without Sent, no longer skips their new mail.
- **`--discover` never fails with "use a longer prefix"** on words the user typed whole, and `search all` keeps its
  messages part.
- **Trigram searches treat ё and е as one letter** (`find`, `chats list title:`, people and contacts search).
- **Mail beside messages, and files beside written notes, are ordered by rank in each source,** not by raw scores
  from different indexes; conversations search too.
- **`changes` reports a message a later fetch brought back after its deletion** as new.
- **Removing an account clears its calendars, mail rules, reminders and proposed actions** instead of failing on a
  foreign key.
