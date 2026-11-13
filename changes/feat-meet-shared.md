### Added

- **`@wirecat/cli-core/google`**, what every Google API client shares: `googleError` turns a refusal into a
  `CliError` by Google's reasons, with the codes and reasons gcal uses (`api.disabled`, `oauth.scope-missing`,
  `provider.usage-limit`…) and never Google's own message; `service` names the API in messages. Calendar's
  organizer-only refusal is the generic `access.denied` here; gcal keeps its own. `googlePages` reads every
  `pageToken` page and refuses a repeated token or more than 1,000 pages with `invalid_response`.
- **A meeting's Drive documents** (`MeetingSave.documents`, `MeetingSource.documents`): a meeting tool names the
  transcript, recording and notes files the service saved, by Drive file id. The store links them whichever arrives
  first, Drive's import or the meeting, from any Drive profile, with no store migration. A file the service stops
  listing stays linked. `meetings show` lists them as `documents[]`: `file_id`, `role`, `title` and `document`, the
  stored `document:<id>` once Drive has the file, else `null`.
- **A `search all` document hit names its meeting** (`meeting`, `meeting:<account>/<id>`) when it is a meeting's
  transcript, recording or notes and the search read the meeting's account. A listed transcript is shown once with its
  meeting, as a `driveFileId` one is.
- **`google-meet` among the known providers** (meetings, from the `meet` tool).

### Fixed

- **A meeting transcript's Drive file** (`TranscriptInput.driveFileId`): a new version now replaces only the link the
  previous version of the same transcript source named. Before, it dropped every other transcript link of the
  meeting, so two sources in one save kept one link. A version naming a file the meeting tool listed keeps that
  file's role and title.

### Changed — may break callers

- **`MeetingTranscriptDocumentStore` has a new method, `documentMeetings`**: the meeting each document is a
  transcript, recording or notes of. The store implements it; a caller's own implementation of the interface adds it.
