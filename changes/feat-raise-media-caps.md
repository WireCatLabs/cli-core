### Fixed

- **Pictures, calendar files and audio are read about ten times larger.** The owner's ruling of 27.11.2026: raise
  each cap by about ten times, not to the 10 GiB file budget. A picture for picture search or a documents sync is
  read up to 250 MB (was 25 MB, `PICTURE_MAX_BYTES`). An `.ics` file for `events import` and a calendar feed are read
  up to 100 MB (was 10 MB, `ICS_MAX_BYTES`, `FEED_LIMITS`). `decodeChannelsFile` reads an MP3, Ogg or FLAC file whole
  up to 640 MB when no `maxBytes` is given (was 64 MB). Each is held whole in memory
  ([picture search](../docs/search/images.md)).
