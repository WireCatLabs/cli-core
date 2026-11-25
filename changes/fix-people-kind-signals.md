### Fixed

- **`people.list` finds no-reply and notification senders by any part of the address.** `noreply-12345@`,
  `service-noreply@` and `bank.no-reply@` are no-reply addresses now, and `notify@`, `alerts@` or `bank-notifications@`
  make a sender `automated` (signal `notification-address`), so banks and service alerts no longer show under
  strangers. `bounce` counts only as a whole part (`bounce-8812@`), so `bouncer.joe@` stays a person. Someone the owner
  answers in a private chat stays a `person`. Every stored kind is worked out again on the next list.
- **The people scan never proposes a bot, an automated sender or an organization as the same person by name.** One
  newsletter that sends from many `+tag` addresses under one name no longer fills the review with pairs. The next scan
  deletes the open `name` proposals that name such a sender, and is a full pass once.
