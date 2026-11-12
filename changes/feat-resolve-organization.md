### Added

- **`decideLink` answers a match whose two people are a company's mailboxes.** `organization: { organization?, name?,
  all? }` with `confirm: false` gives every address of the match's identities to one organization (the one named, else
  one holding an address or the company domain, else one of `name`, else a new company named after the people's
  shared name or the domain; free mail needs a name). A person who is only those addresses becomes the company's and
  is listed as an organization; one who holds more keeps the rest and stays a person. The match closes, `all` closes
  every match on those addresses, and the result names `organization`, `mailboxes`, `people` and `closed`. No
  migration.
