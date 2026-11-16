### Added

- **Fault cases in `documentSourceContract` and `crmSourceContract`**, opt-in through the fixture's new `faults`; a case
  whose hook is absent passes without running. Documents: a child that answers 403 or 404 (the error code, and a sync
  that imports the rest and names the refused file), a clock ten minutes off either way, a second profile on the same
  token, an interrupted sync that goes on instead of over, and a slow provider under the MCP's 45 s deadline. With
  `faults.sync`, the CLI's own sync wiring runs these against `syncDocuments`. CRM: `get` gives `null` for a 403 or
  404, the skew and same-token checks, a full list cut after one page and resumed in a new run, and a source that
  pages inside one call ending it with the budget's own error once the budget is spent. `fakeDocumentSource().deny` and `fakeCrmSource().deny` fake the refusals.
