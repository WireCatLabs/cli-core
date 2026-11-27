### Fixed

- **A CRM sync whose contacts and companies come from its deals now goes on under a small request budget.** Such a
  source (`linked: true`, as attio) reads each contact and company a deal names on its own, about two requests each,
  50 to a page. A run given fewer requests than a page needs, such as `sync --max-pages 20`, stopped before the page
  ended and saved nothing, so every later run started the same page again. It now saves what it read and the next run
  goes on from there.

### Added

- **`CrmBudgetSpent`**, what `CrmCallContext.spend` throws once the budget is spent. A source that reads one record at
  a time may catch it and hand back what it read before the stop.
