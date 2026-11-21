### Fixed

- **SQLite 3.54 (Node 24.22) no longer breaks store version 31, combined search or the admin byte counts.** SQLite
  3.54 stopped passing a subquery's JSON subtype up, so version 31 wrote each app's profiles and each account group as
  a string inside the setting, and a profile or group search then lost them; version 31 now wraps both in `json()`. A
  store that already ran version 31 on SQLite 3.54 is read as if it had not, and its next profile or group save writes
  the setting whole again. The admin statistics' message byte count wraps its attachments the same way.
- **A search SQLite refuses as too large answers `query.too-large`.** On SQLite 3.54 a combined message search of
  about 53 words or more stopped with SQLite's own "nested too deep" error; it now gets the same refusal as a query
  over the node budget, so a caller tells the person to search for less.
