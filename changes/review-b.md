### Changed — may break callers

- **`stats tasks show` has no `--chat` any more: name the chat in the query, `-- chat:"Project room"`.** The query
  already took `chat:` by id or name, so the flag only repeated it, and every messenger CLI had to exempt it from
  the shared `filter-flag` lint rule until 2026-12-01. A CLI drops its `stats tasks show --chat` override when it
  adopts this version.
