### Fixed

- **Tasks found in messages before 0.630 keep their message's first line as their title (store version 65).** Since
  0.630 such a task showed the first line only while its message was in the store, and its title went back to
  `question — msg:…` once the message was deleted. Store version 65 stores that line as the title of every live
  found task still titled `<kind> — <source>`, once, on the next writable open, in batches. A title a person wrote, a
  project task, and a task whose message is missing, deleted or empty keep their title.
