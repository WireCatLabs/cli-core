### Fixed

- **A documents CLI that adds a folder by path shows that path in `folders add`'s example and in `search`'s hint.**
  Both said `FOLDER_ID`, which ydisk refuses: its `folders add` takes a Disk path such as `/Documents`. The CLI sets
  `text.folderToAdd` in its `DocumentWords`; without it both keep `FOLDER_ID`.
