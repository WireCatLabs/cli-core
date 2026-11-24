### Added

- **A documents sync lists several folders at once on a source that sets `parallelListings`** (a whole number up to
  8). A source whose one listing takes seconds (Yandex Disk) can set it, for example to 4, so a sync of many folders
  can take less time. Each listing takes its own request from the run's budget, and the walk files the same
  documents, though the order they are saved in may differ. A call cut short or a failed listing loses nothing: the
  folder stays on the saved walk and is listed again in the next sync. Unset, a sync lists one folder at a time as
  before.
