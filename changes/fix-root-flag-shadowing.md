### Changed — may break callers

- **`store clear --allow-dangerous` and `admin moderate --allow-dangerous` are the owner's alone.** Their MCP tools
  no longer take `allow_dangerous`, as with every other delete that cannot be undone: an agent previews with
  `dry_run`, and the owner runs the command in a terminal.

### Fixed

- **A command's own `--yes` or `--timeout` gets its value.** The root program declares both, and the value went to
  the root alone, so `meetings repair --yes` only previewed, `models consents set --yes` and
  `models search-consents set --yes` changed nothing, and `search-consents set --timeout 2m` stored no wait. Every
  option a command shares with the root now gets the value too, through the command's own parser. A CLI that copied
  the root's values itself can drop that copy.
- **`tasks scan` and the CRM kit's `store apply` take `yes` over MCP.** Both read the root's `--yes`, which a tool
  call cannot pass, so an agent could only preview them.
