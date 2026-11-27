### Fixed

- **A mail search by `type:` or `reach:` now keeps to its 2 s time limit on a store whose mail is not typed yet.** On
  a store upgraded to version 76 and not synced since, a read-only search worked out the type of every email twice,
  once for its page and once for its total, and each pass started its own 2 s clock: 2.3–2.8 s on 100,000 emails, with
  no "out of time". The total now runs on the time the page left, and is left out when none is left. The types worked
  out in memory are kept while the store is unchanged, so the total and later searches on the same open reuse them:
  about 1.2 s for the first such search on 100,000 emails, under 0.2 s for the next ones.
