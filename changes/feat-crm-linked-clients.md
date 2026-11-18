### Added

- **A source manifest's `linked: true` on contacts or companies copies only the ones a deal names**, each read by its
  `get`, as bitrix24-cli's sync does; the rest stay in the service and are read live. Their ids are the deals' links,
  so one no deal names any more leaves the copy at the next full round. Attio's contacts and companies grow from the
  owner's mail, and a full copy held thousands nobody sells to.

### Fixed

- **An optional kind the service answers with 404 is a gap too**, not only a 403. Attio's Deals object is off until an
  admin turns it on, and its records query answers 404: the sync failed instead of naming the gap.
