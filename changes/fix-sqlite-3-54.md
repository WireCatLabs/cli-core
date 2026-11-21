### Fixed

- **A store upgraded to version 31 under SQLite 3.54 keeps its profiles and account groups as objects.** SQLite
  3.54.1, which Node 24.22.3 ships, drops the JSON type of a subquery's result, so on a store that had Drive folder
  accounts the migration nested each app's profiles and each group as a quoted string. Each inner subquery is now read
  back with `json()`, and a store already upgraded that way reads those values as the objects and lists they hold.
- **A search too long for SQLite to run as one statement answers with its size, not a raw SQLite error.** On SQLite
  3.54 a search of about 60 words failed with "VIEWs and/or subqueries nested too deep", and on any version a search
  of about 250 words joined by OR failed with "too many terms in compound SELECT". Both now answer
  `query.too-large` with `budget: "nodes"` and say to use fewer words. A search of 60 to about 130 words that ran on
  SQLite 3.53 is refused on 3.54.
