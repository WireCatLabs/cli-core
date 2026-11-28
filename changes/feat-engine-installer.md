### Added

- **`doctor` lists the engines installed in the shared data folder.** A new `engines` field gives the folder
  (`<WireCat data>/engines`) and each engine in it: its name, version, path and whether this version of cli-core
  loads it (`current`). Nothing installs an engine yet; voice, search by meaning and the document readers move onto
  the installer in later releases, and then install on first use instead of shipping in every install
  ([how engines install](../docs/dev/ARCHITECTURE.md#engines-installed-on-first-use)).
