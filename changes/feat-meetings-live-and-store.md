### Added

- **`meetings list` and `meetings show` read the service and the store at once.** With a source that has `find` and
  `get`, they ask the service for what may match, keep it as `meetings sync` does, then answer the whole query from
  the store: one list, the store's paging. `--backend archive|server|both`, the words messages search uses, default
  `both`; `--offline` reads the store only. Each item says `found_in` (`archive`, `server`, `both`). A service that
  cannot be asked leaves the store's answer and a `missing` line that says why; a typed `--backend server` refuses.
  The service gets only what it can filter: `started_at` as a window and the fields its `finds` names.
- **`MeetingSource.finds`, `find(window, terms, cursor)` and `get(id)`**, all optional, and
  `MeetingStore.meetingByExternalId`. `saveSourceMeeting` is the one writer `sync` and these reads use.
- **`meeting.provider_id`**, the service's id of the occurrence. `meetings show` takes it besides the store number and
  the `meeting:` ref, and `meetings list provider_id:<id>` filters by it.
- **`meetings create|update|cancel|invitation`** from `createMeetingManagement`, mounted when a host passes
  `management` to `addMeetingCommands`, for the ports it has. The writes are asked first by default
  (`meetings.create`, `meetings.update`, `meetings.cancel`); `--dry-run` answers `applied: false`.
- **`serviceCallsOf`**, one query simplifier for a service's own search: it keeps the fields and operators a service
  declares it reads, leaves out the rest, splits OR into calls up to a cap and sends a NOT only where the service can
  negate it. Messages server search uses it.

### Changed — may break callers

- **`meetings list` and `meetings show` are remote reads** (`{ remote: read, local: read }`, `partial`), and `show`
  takes a string: the store number, the `meeting:` ref or the service's id. A host whose source has no `find`/`get`
  now gets a `missing` line naming that until it adds them; `--backend archive` keeps the old store-only answer.
- **`meeting` and `meeting_details` items carry `provider_id`.** A check against an exact item shape adds it.
- **Messages server search no longer sends a `to:`, `cc:` or `bcc:` person to the server as the sender.** Only
  `from:` narrows the server's call; the store still filters the others.
