### Added

- **A shared mailbox proposes the people who have it again, scored, and still never joins them.** A role address such
  as `info@` or `office@`, and a company's address (one an organization holds, or two people of one source list have),
  now opens a proposal for each pair of its people instead of being skipped; a no-reply address still proposes no one,
  and the owner is still never proposed. The proposal's `score` says what else the two share: 0.1 for the mailbox
  alone, more for one name, a phone or another address only they hold, a chat or a company's domain
  ([ARCHITECTURE.md](../docs/dev/ARCHITECTURE.md)). Proposals already stored stay as they are.

- **`IdentityLinkRow.shared`: `role`, `line` or `null`.** Says that the address behind an `identity_link` proposal is
  a shared mailbox, so a review can show it as one; `null` on proposals made before this release.
