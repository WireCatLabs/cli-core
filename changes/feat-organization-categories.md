### Added

- **An organization says what it does: `Organization.sector`.** An organization holding a company mail domain gets
  `bank`, `airline`, `shop`, `news`, `government`, `telecom`, `social`, `delivery` or `financial` from a table of
  domains built into the package from Wikidata (CC0), so no sender is looked up online. It is stored in the
  organization's `metadata.sector`; free mail and sending platforms never give one. The first list after the
  upgrade sets it for the organizations already stored
  ([ARCHITECTURE](../docs/dev/ARCHITECTURE.md#entities-and-source-records)).
