### Security

- **`schedule exec` runs only a schedule file in the tool's own schedules folder, and an MCP server no longer offers
  it.** The file's real path is compared, so a link or `..` that leads elsewhere is refused (`schedule.outside-folder`).
  A timer installed by `schedule agent` or `schedule command` already names a file there, with or without its seal, so
  installed schedules keep running. An agent runs a saved schedule with `schedule run <name>`.
- **`templates preview --file` is the owner's option.** An MCP server no longer offers it; an agent previews the
  template that applies. `templates edit`, `templates reset`, `models consents set --yes` and
  `models search-consents set --yes` refuse an MCP run as they refuse an agent's shell, whatever its environment holds.
- **`messages download --output-dir` refuses credential folders, the CLI's own folders and the message store**, as
  `attachments extract --output-dir` does, for one message, `--all` and `--offline`. A file named after its message
  stays inside the chosen folder whatever the message id holds.
- **`documents history document:<n>` answers only for a document of the selected profile's account.** A ref of
  another account's document is `document.not-imported`, like a source id that is not in the profile's local copy.
