### Changed — may break callers

- **`contacts unlink` needs `--from`, the person the identity leaves.** `tg`, `max` and `wa contacts unlink <person>
  --from person:<uid>|person:me` (and `services.people.unlink(person, { by, from })`) take the identity off that person
  only. Without `--from` the command is refused with `validation_error`, reason `person.from-required`, and the message
  names who holds the identity and the command to run with their `--from`. An identity on someone else is refused with
  `identity.held-elsewhere`, as memo's `people unlink` is, and nothing moves.
