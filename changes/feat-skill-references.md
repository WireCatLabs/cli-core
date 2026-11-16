### Added

- **A CLI's skill can keep a short SKILL.md and the rest in files beside it, and every route delivers them.** With
  cli-base 0.106.0, `skill install`, the refresh of an old installed copy and Hermes's copy write the whole skill
  folder, `skill show <name>` prints a part by its file name (`tg skill show search`), and the MCP servers (the
  personal, the bot and the app server) serve each part at `<command>://skill/<path>` beside `<command>://skill`.
  An agent carries SKILL.md in every turn after it opens it, the parts only when it reads one.
- **`validateSkill` checks the files a skill links, and can limit its size.** Each relative Markdown link's target is
  checked like SKILL.md (its links and command paths), with problems prefixed by its file name; `maxBytes` fails a
  larger SKILL.md.
