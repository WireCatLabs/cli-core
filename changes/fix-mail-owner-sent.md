### Added

- **A mail source names the IMAP Sent folder.** `MailSource.folders()` may answer `sent`: the folder the server marks
  `\Sent` (RFC 6154), else one by a common name when the server marks none. `mailFolders` then reads `INBOX` and that
  folder for `mode: "imap"`, and `MailAccount.addresses` takes the owner's other addresses on the mailbox, such as
  aliases ([MAIL.md](../docs/dev/MAIL.md#syncmailsource-store-options)).

### Fixed

- **Mail the owner sent from an alias is outgoing, and the alias is the owner's.** Mail in Sent or under Gmail's `Sent`
  label, and mail from one of the owner's addresses, counted as incoming when its From was not the account's address,
  so the people the owner wrote to from an alias had no mail tie and showed as strangers. Now it is outgoing, mail stored
  earlier is marked too, the senders of Sent mail are kept under `mail_own_addresses`, and their identities join the
  owner when the account's own identity is the owner's. An IMAP adapter that answers `sent` gets the same for its Sent
  folder.
