### Added

- **`@wirecat/cli-core/google`**, what every Google API client shares: `googleError` turns a refusal into a
  `CliError` by Google's reasons, with the codes and reasons gcal uses (`api.disabled`, `oauth.scope-missing`,
  `provider.usage-limit`…) and never Google's own message; `service` names the API in messages. `googlePages` reads
  every `pageToken` page and refuses a repeated token or more than 1,000 pages with `invalid_response`.
- **A meeting's Drive documents** (`MeetingSave.documents`, `MeetingSource.documents`): a meeting tool names the
  transcript, recording and notes files the service saved, by Drive file id. The store links them whichever arrives
  first, Drive's import or the meeting, from any Drive profile, with no store migration. A file the service stops
  listing stays linked. `meetings show` lists them as `documents[]`: `file_id`, `role`, `title` and `document`, the
  stored `document:<id>` once Drive has the file, else `null`.
- **A `search all` document hit names its meeting** (`meeting`, `meeting:<account>/<id>`) when it is a meeting's
  transcript, recording or notes; a listed transcript is shown once with its meeting, as a `driveFileId` one is.
- **`meet`, the Google Meet tool**, in the WireCat tools of the first screen, and `google-meet` among the known
  providers (meetings).
