### Added

- **The owner can answer a shared-mailbox proposal with "this is the company's mailbox".** `people.decideLink` with
  `company` (`{}`, `{ organization }` or `{ name }`) gives the address to an organization: the one named, else the one
  that holds the address or its company domain, else one of that name, else a new company named after the domain. The
  proposal is turned down, so the two people are not joined and are not proposed again on that address. Only the
  owner decides it; a proposal that is not about a shared mailbox is refused with `identity.not-shared`
  ([ARCHITECTURE.md](../docs/dev/ARCHITECTURE.md)).

- **`IdentityLinkRow.mailbox` names the shared address**, beside `shared`, so a review can show which mailbox it is.

- **`people.linkProposals({ order: "score" })` lists the highest score first**, proposals with no score last, each
  newest first. Without `order` the list stays newest first.
