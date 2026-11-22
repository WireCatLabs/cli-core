### Fixed

- **`messages sync --dry-run` refuses again where it cannot estimate** (#3202), so the entry "`messages sync
  --dry-run` previews and names its permission key where it cannot estimate" does not hold. whatsapp-cli and
  max-cli test and document the refusal: a messenger that pushes its history, or whose ids are ordered by time,
  cannot count what is missing, and a dry run says so with exit 2.
