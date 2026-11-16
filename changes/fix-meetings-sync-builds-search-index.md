### Fixed

- **`search all` finds the words of meeting transcripts after `meetings sync`.** It reads meetings only from their
  search index, and nothing but `search meetings` built that index, so a synced call's transcript was never found
  and the answer named the account under `missing`. `meetings sync` and `meetings import` now index what they saved
  before they answer, through the store's optional `indexSearch`; a failure to index is a warning in the report. A
  sync its budget stopped leaves the index to the next run. `refreshMeetingIndex` moved to `@wirecat/cli-core/meetings`
  and is still exported from the services.
