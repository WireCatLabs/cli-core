### Added

- **`meetings list` and `meetings show` read the service and the store at once.** With a source that has `find` and
  `get`, they ask the service for what may match, keep it as `meetings sync` does, then answer the whole query from
  the store: one list, the store's paging. `--backend archive|server|both`, the words messages search uses, default
  `both`; `--offline` reads the store only. Each item says `found_in` (`archive`, `server`, `both`). A service that
  cannot be asked leaves the store's answer, a `missing` line that says why and `meta.complete: false` with a
  `meetings.server-*` issue; a typed `--backend server` refuses. The service gets only what it can filter:
  `started_at` as a window and the fields its `finds` names. Both sides read the query's dates in the owner's zone.
- **A live read keeps what sync stored.** An empty field of the service's record keeps the stored value and the
  metadata merges; a record that changes nothing is not written. A meeting that cannot be kept is counted in the
  answer (`meetings.server-failed`), and the call or page cap says so (`meetings.server-capped`).
- **`MeetingSource.finds`, `find(window, terms, cursor)` and `get(id)`**, all optional, and
  `MeetingStore.meetingByExternalId`. `saveSourceMeeting` is the one writer `sync` and these reads use; it takes the
  stored row as `kept`. `MeetingFilter` takes `ids`, `timezone` and `now`.
- **`meeting.provider_id`**, the service's id of the occurrence. `meetings show` takes it besides the store number and
  the `meeting:` ref, and `meetings list provider_id:<id>` filters by it.
- **`meetings create|update|cancel|invitation`** from `createMeetingManagement`, mounted when a host passes
  `management` to `addMeetingCommands`, for the ports it has. The writes ask first by default (`meetings.create`,
  `meetings.update`, `meetings.cancel`) through the host's `askFirst`, `askBeforeWrite` from `@wirecat/cli-core/cli`:
  with nobody to answer they refuse with `confirmation_required`, and `--yes` goes ahead. `--dry-run` answers
  `applied: false`.
- **`serviceCallsOf`** in `src/search/service-query.ts`, one query simplifier for a service's own search: it keeps the
  fields and operators a service declares it reads, leaves out the rest, splits OR into calls up to a cap and sends a
  NOT only where the service can negate it. A branch no call can match is never asked, and a query of more than 64
  OR branches is not complete. Messages server search uses it.

### Changed — may break callers

- **`meetings list` and `meetings show` are remote reads** (`{ remote: read, local: read }`, `partial`), and `show`
  takes a string: the store number, the `meeting:` ref or the service's id. A host whose source has no `find`/`get`
  now gets a `missing` line naming that until it adds them; `--backend archive` keeps the old store-only answer. Under
  `<PREFIX>_READ_ONLY` they still ask the service, as `meetings sync` does.
- **`meetings list` reads dates in the host's `timezone`** (the computer's without it), not in UTC.
- **`meeting` and `meeting_details` items carry `provider_id` and `untrusted`** (`title`, `description`,
  `location`), and `meeting_invitation` carries `untrusted: ["invitation"]`. A check against an exact item shape adds
  them.
- **Messages server search no longer sends a `to:`, `cc:` or `bcc:` person to the server as the sender.** Only
  `from:` narrows the server's call; the store still filters the others.
