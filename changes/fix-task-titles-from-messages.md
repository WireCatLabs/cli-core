### Fixed

- **Tasks found in messages show the message's first line as their title.** A rule stored `question — msg:…` as the
  title, so `tasks list` and the tasks views showed a raw reference. `tasks.details`, `tasks.list` and `tasks.query`
  now give the first line of the source message, up to 120 characters, while the stored title is still that
  placeholder. A deleted, empty or media-only message keeps the stored title. The store still holds no message
  text, and a title the owner wrote is never replaced.
