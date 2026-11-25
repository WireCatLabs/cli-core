### Added

- **Each email has a type of its own, apart from its sender (store version 76).** `Email.mailType` is one of
  `auto_reply`, `security`, `calendar`, `travel`, `event_ticket`, `order`, `shipping`, `bill`, `social_notification`,
  `discussion_list`, `newsletter`, `promotion`, `system_alert`, `account_notice`, `personal` or `other`, worked out
  locally from the stored headers, recipients, attachment types, schema.org markup in a kept HTML body, the sender's bot
  and its organization's sector, and whether the owner wrote to the sender. `Email.reach` (`direct`, `group`,
  `broadcast`) is worked out per email too, and `Email.typeSignal` says what decided the type. They are kept on the
  email and cleared by triggers when what decides them changes; a store's existing mail gets them in batches on the
  first read that filters by them. The words are in the [glossary](../docs/dev/GLOSSARY.md#mail-types).
- **`store.mail.emails` filters by `types` and `reaches`**, and **`store.mail.mailSenders`** lists the senders of
  incoming mail with their mail counted by type and reach: a sender is listed when any of its mail passes the filter,
  so a shop that sends receipts and sales shows under both. Both are experimental.
