### Fixed

- **A generated `api` command no longer demands a required parameter that the spec gives a default.** Notion's
  page-markdown calls stopped with `required option '--notion-version <value>' not specified`, though its spec says
  `Notion-Version` defaults to `2026-03-11`. Such a flag is now optional, shows its default in `--help`, and the call
  sends the default when the flag is left out; a value given on the command line wins. A required parameter with no
  default is still required. This covers the Bot API group too.
