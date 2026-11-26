### Fixed

- **An alias the owner removes stops being the owner's on the next mail sync.** A defined `MailAccount.addresses` is
  now the whole list; a sync without it, and an archive import, drop nothing. The list is kept under
  `mail_own_configured`. One that is gone and has no mail in Sent leaves `mail_own_addresses`; the account's
  mail from it outside Sent is incoming again, and its email identity leaves the owner when the rules joined it. A link
  the owner made stays. `settleOwnMail` now takes the configured list as `configured` in its options, and
  `store.mail.markOwnMail` takes `removed`. No store version. Part of #3321.

### Added

- **Mail sync keeps more of what decides a mail's type** in `emails.headers`, no store version: `auto-replied` (a
  signed `Auto-Submitted: auto-replied`, apart from `auto-submitted`), `list-post` (List-Post naming where to post),
  `schema-types` and `schema-fields` (the schema.org type names and a few values of the HTML, never the HTML), and
  `calendar-method` (`request`, `cancel`, `reply`). The mail types read them: an auto-reply is `auto_reply`, List-Id
  mail with List-Post and no campaign marker is a `discussion_list`, and stored schema types count as `body_html`'s
  do. Mail stored earlier has none of them until mail sync reads it again. From the gaps #3358 listed.
