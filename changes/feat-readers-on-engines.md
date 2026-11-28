### Changed — may break callers

- **The PDF, web-page and HTML readers and the PNG charts install on first use.** `unpdf`, `defuddle`, `linkedom` and
  `@resvg/resvg-js` left `dependencies`: the first PDF or HTML read, or the first PNG chart, installs them into the
  WireCat data folder (about 3 MB for the readers), quietly, and every later run loads them from there. An install of
  cli-core takes 30 MB less disk (178 MB to 149 MB, Linux x64). Offline, before the first install, such a file is
  `engine-missing` with a `reason` and a `retry`, and is read on a later run; `chartPng` answers the `engine-missing`
  state instead of a PNG, and `stats charts --output x.png` still prints the chart, marked incomplete
  (`engine.missing`). A caller that imported one of these packages itself now installs it itself. `doctor`'s
  `readers` says `on first use` for them until they are installed
  ([how engines install](../docs/dev/ARCHITECTURE.md#engines-installed-on-first-use)).
