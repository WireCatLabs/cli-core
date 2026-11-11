### Added

- **Your coding agent can read the text of a picture you choose.** `images read <ref> [--attachment n]` gives one
  picture to Claude Code (`claude -p`, only its Read tool) or Codex (`codex exec --image`) and keeps what it read as the
  attachment's text, so `content:` search finds it. The extractor is `agent:claude` or `agent:codex/<model>`. The saved
  copy is used when there is one, else the messenger's download; nothing else is kept. The agent runs without
  `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` and the agent variables, in a folder holding the picture alone.
- **`models picture-reading show|set never|request [--agent claude|codex] [--model m] [--from-app]`**, the shared
  `picture_reading` setting. `never` is the default and refuses `images read` (`picture-reading.off`); only the owner
  turns it on. `models local-only show` lists it as `picture_reading`. See
  [ai-providers.md, "Pictures read by your coding agent"](../docs/search/ai-providers.md#pictures-read-by-your-coding-agent).

### Fixed

- **`messages show` and search hits name a downloaded file's `local_path`.** An agent reading a hit could not tell
  that a picture was already on this computer, nor where.
