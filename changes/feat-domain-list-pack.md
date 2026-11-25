### Added

- **The domain-list pack: more organizations get a sector, and the lists update without a release.**
  `domainListsCommand` (experimental) gives a CLI `domain-lists update` and `domain-lists list`. `update` downloads the
  newest pack from WireCat's GitHub release `domain-lists`, each file checked by sha256 the way `models download` checks
  a model, and swaps the pack folder whole. The first pack holds UT1's sector and webmail lists (CC BY-SA 4.0, their
  own files), the FDIC-insured US banks, UT1's malware and cryptojacking hosts, and Stop Forum Spam's toxic domains,
  which each computer fetches from Stop Forum Spam itself because its terms forbid redistribution. Each source carries
  its licence, credit and class: `commercial-ok`, or `non-commercial`, which WireCat may use and a paid service may
  not; `--commercial-only` leaves those out. Sender domains are matched on this computer only, never sent anywhere.
  Two sectors come from the pack, `gaming_gambling` and `adult`. UT1's webmail providers never make an organization.
  Spam and malware lists never set a sector: the lookup reports them apart, for exact host names only, and nothing
  reads them yet. `.github/workflows/domain-lists.yml` builds and publishes the pack weekly.
- **About 23,000 more free-mail providers are never an organization.** Built in from microlink's free-email-domains
  (MIT), less the domains Wikidata calls an organization, such as `sky.com` or `orange.fr`, whose own bills come from
  that domain. An organization already made on a domain that is now free mail stays.

### Changed — experimental

- **A sector from the rules is changed or removed when a newer list no longer gives it.** Rules mark their sector
  `metadata.sector_by = 'rules'`; a sector with any other `sector_by` is the owner's and stays. When the built-in table
  or the pack changes, the next kind pass works out every organization's sector again. An organization's `sector` can
  now also be `gaming_gambling` or `adult`.
