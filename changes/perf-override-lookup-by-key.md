### Fixed

- **`relationships list include:ended` answers in about 0.2 seconds instead of minutes on a store with a busy
  person.** The check for an owner's override of a link looked the override up by the link's target, so a person on
  25,857 deals read every one of those links again for each relationship (325 seconds on a 108,000-link store). It now
  looks it up by the relationship's own key. The same check runs in the deal's people, a thing's relationships and a
  meeting's preparation, so those get faster too.
