### Changed — may break callers

- **Issues, projects and comments are found by other forms of their words.** `store.tracker.find`, and with it
  `issues search` and the tracker lane of `search all`, matches a query word to a word of the same stem
  («поставки цемента» finds «Поставка цемента», `invoice failing` finds "Invoices fail") and to a word it begins, as
  CRM deals are matched. A word starts others from four letters, not three as before: `bug` no longer finds `bugfix`,
  only `bug` and `bugs`. `--exact` keeps the words as written. See [TRACKER.md](../docs/dev/TRACKER.md#storetracker).
