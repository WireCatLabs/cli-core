### Added

- **Organizations from mail domains.** A sender bot or a shared mailbox at a company domain joins that domain's
  organization when people are listed: the one already holding an address there, else a new one, named by the sender
  when the name is a company's, else by the domain. Subdomains count as their registrable domain. A human writing
  from that domain gets a `member-of` link to it and is never merged. Free mail, throwaway mail and sending platforms
  (newsletter hosts and mail services) make no organization. The owner's word holds: a membership the owner removed,
  an organization the owner erased and a bot the owner moved to a person are not grouped again. See
  [ARCHITECTURE.md, "Organizations from mail domains"](../docs/dev/ARCHITECTURE.md).

### Changed — experimental

- **`KIND_RULES` goes to 8.** The first list after the upgrade works out every kind again and groups the senders it
  finds under their organizations. A shared mailbox an organization now holds gains the `organization` kind signal.
