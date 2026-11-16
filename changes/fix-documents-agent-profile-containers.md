### Added

- **The documents engine records which account a CLI's profile is.** `documentIngestion` takes the CLI's `command`
  and answers `registerProfile(name, principal)`, and `syncDocuments` calls it with its new `profile` option once the
  signed-in account is checked. A search hit from a documents CLI then names the CLI and the profile (`notion`,
  `work`), not `notes` and a store id. drive did this on its own; every documents CLI now gets it by passing both.

### Fixed

- **An agent's `relationships add` on a shared documents CLI is saved.** It is written as an unconfirmed suggestion
  for the owner, with the agent and its reason in the provenance. The store used to refuse it, so nothing was written
  although the error said it would be saved unconfirmed. The owner decides it in the same commands: adding the same
  relationship confirms it, and removing it rejects it.
- **A folder in a documents account stays out of search.** A Drive folder, a Notion workspace or a Notion database
  is a catalog entry, not a document: word search, the newest-first read memo's digest makes, meaning search and
  embedding now leave it out, as document lists already did. It used to show up with an empty excerpt, and
  `documents show` could not open it.
