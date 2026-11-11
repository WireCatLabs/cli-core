### Added

- **`participants_count` in the query language.** `participants_count<10` matches messages in chats of fewer than ten
  people, as the messenger last reported the size; a chat whose size was never reported matches no value. So
  `stats messages show 'kind:private OR (kind:group participants_count<10)'` counts personal conversations and leaves
  big groups out.
