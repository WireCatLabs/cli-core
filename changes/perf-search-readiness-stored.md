### Changed — may break callers

- **Store version 69: `search conversations` reads each chat's readiness instead of counting it on every search.**
  The counts it reports (messages new, edited or deleted since the build; chunks with current, stale and missing
  vectors) are saved per chat and model in `conversation_readiness` the first time they are counted. Triggers drop a
  chat's row when its messages, revisions or build change, and a model's rows when its vectors
  change, so the next read counts again. Forward-only; `minCompatible` stays 56.
