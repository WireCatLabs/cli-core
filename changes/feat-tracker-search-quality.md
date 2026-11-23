### Changed — may break callers

- **Issues, projects and comments are found by other forms of their words.** `store.tracker.find`, and with it
  `issues search` and the tracker lane of `search all`, matches a query word to a word of the same stem
  («поставки цемента» finds «Поставка цемента», `invoice failing` finds "Invoices fail") and to a word it begins, as
  CRM deals are matched. A word starts others from four letters, not three as before: `bug` no longer finds `bugfix`,
  only `bug` and `bugs`. `--exact` keeps the words as written. See [TRACKER.md](../docs/dev/TRACKER.md#storetracker).

### Fixed

- **A comment is found by meaning together with its issue.** Its embedded text starts with the issue's key and title
  (`ENG-12 Fix login`), so "it works after clearing the cache" is found by what the issue is about. A comment of fewer
  than 16 characters (`LGTM`, `+1`) is no longer embedded, and its words still find it. A retitled or moved issue's
  comments are cut again on save, and `embedTracker` cuts the comments of a store embedded by 0.730–0.732 once, so
  their vectors are made again. Measured in cli-testing
  [performance/search/tracker-meaning](https://github.com/WireCatLabs/cli-testing/tree/main/performance/search/tracker-meaning).
