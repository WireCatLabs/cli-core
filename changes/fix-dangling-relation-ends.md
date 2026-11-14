### Fixed

- **A project's status no longer crashes on a link whose chat was deleted.** `knowledge.relations` leaves out a link
  whose start or end no longer exists, such as a `member-of` link from a chat the store has since removed. Before,
  it returned the link with `from: null`, and `projectStatus` failed on it, so memo's `review agenda` and the morning
  digest stopped with `command.crashed`.
