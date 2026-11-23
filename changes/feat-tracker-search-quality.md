### Changed — may break callers

- **Issues, projects and comments are found by other forms of their words.** `store.tracker.find`, and with it
  `issues search` and the tracker lane of `search all`, matches a query word to a word of the same stem
  («поставки цемента» finds «Поставка цемента», `invoice failing` finds "Invoices fail") and to a word it begins, as
  CRM deals are matched. A word starts others from four letters, not three as before: `bug` no longer finds `bugfix`,
  only `bug` and `bugs`. `--exact` keeps the words as written. One search reads at most 2,000 rows the word index
  offers; when it offered more, the answer has `capped: true` and `hasMore` while the page found any. See
  [TRACKER.md](../docs/dev/TRACKER.md#storetracker).

- **`search all` shows an issue, project or comment two sign-ins hold once.** Two tracker accounts on one workspace
  showed every item twice side by side, so ten results held about five items. For a provider whose entry says
  `globalItemIds: true` (seeded for `linear`), the copies (same provider, kind and id) now fold into the best-placed
  one, whose new `accounts` field names every account that holds it; `account` and `ref`
  are that copy's. A page holds more distinct items, so a caller counting hits per account sees fewer. See
  [TRACKER.md](../docs/dev/TRACKER.md#search-all).

### Fixed

- **A comment is found by meaning together with its issue.** Its embedded text starts with the issue's key and title
  (`ENG-12 Fix login`), so "it works after clearing the cache" is found by what the issue is about. A comment of fewer
  than 16 characters (`LGTM`, `+1`) is no longer embedded, and its words still find it. A retitled or moved issue's
  comments are cut again on save, and `embedTracker` cuts the comments of a store embedded by 0.730–0.732 once, so
  their vectors are made again. A chunk whose text no longer hashes to its hash, as one an older build cut, is never
  embedded: its item is cut again first. Measured in cli-testing
  [performance/search/tracker-meaning](https://github.com/WireCatLabs/cli-testing/tree/main/performance/search/tracker-meaning).
