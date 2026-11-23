### Added

- **One shared `mirrors` command group for a file mirror.** `fileMirrorsCommand` gives a file CLI `mirrors add`,
  `list`, `status`, `preview`, `sync`, `watch`, `update`, `remove`, `versions list|restore` and
  `conflicts list|show|resolve` over `syncFileMirrors`. It is yandex-disk-cli's group, with the service, its remote
  word, how `add` finds a folder, the write guard and the keys each write checks given by the app, so notion-cli
  mounts the same commands and ydisk can move onto them with no change in what it does or keeps on disk. See
  [the file mirror](../docs/dev/DOCUMENTS.md#plain-files-both-ways).
