### Added

- **`people.list` rows say how a sender's mail reached the owner.** Each row has `reach` (`direct`, `group`,
  `broadcast` or `null`) and `signals` (`auto-submitted`, `null-return-path`, `no-reply`, `one-click-unsubscribe`,
  `feedback-id`, `bulk-mail`, `discussion-list`, `many-recipients`, `undisclosed-recipients`), worked out for the page
  and not stored ([ARCHITECTURE.md](../docs/dev/ARCHITECTURE.md)). A List-Id three addresses write to is a discussion
  (`group`), one sender under many `+tag` addresses a newsletter. The types `Reach`, `SenderSignal` and `REACHES` are
  exported from `./store`.
- **Mail sync keeps `Auto-Submitted`, one-click `List-Unsubscribe-Post` and `Feedback-ID`** in `emails.headers`,
  each only when a DKIM signature of the From's own domain that Gmail passed covers it, and an empty Return-Path
  ([MAIL.md](../docs/dev/MAIL.md#syncmailsource-store-options)). Mail of an IMAP server without Gmail's stamp keeps
  none of the three. No store version.

### Fixed

- **A sender whose mail a program sends is `automated`, not a stranger.** Most of their mail with a signed
  `Auto-Submitted` (not an auto-reply) or an empty Return-Path makes them `automated` (signals `auto-submitted`,
  `null-return-path`), unless the owner wrote to them. Every stored kind is worked out again on the next list.

### Changed — may break callers

- **`KindSignal` has two more values, `auto-submitted` and `null-return-path`, and `ListedPerson` two more fields,
  `reach` and `signals`.** Code that maps every `KindSignal` or builds a `ListedPerson` by hand adds them.
