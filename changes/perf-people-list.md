### Added

- **`people.counts(query?)` gives how many people each kind holds in one grouped query.** People's filter tabs
  needed one `people.list` call for each kind, and each call took seconds. Now they take one call of about 5 ms on
  113,000 people. It gives the same numbers as `list`'s `counts`.

### Fixed

- **`people.list` costs what the page asks for (store version 62).** Each person's kind, name order, messages and mail
  sent, task count and newest contact are kept on `persons`. Triggers clear them when anything they are made from
  changes, and the next list works out only the cleared people. The list then filters, counts, sorts and pages in SQL.
  It works out ties, signals and contacts only for the rows it returns. On a synthetic store of 113,000 people a first
  page drops from 0.7 s to about 40 ms, a kind tab from about 1 s to 45 ms, and the order by newest contact from 2.4 s
  to about 50 ms. The first list after a sync of 10,000 messages from 2,000 senders takes about 0.15 s
  ([cli-testing `performance/memo/people-list`](https://github.com/WireCatLabs/cli-testing/tree/main/performance/memo/people-list)).
  The answers are the same as before. The first list after the upgrade works out everyone once, which takes as long as
  a list did before. A read-only open with anything left to work out answers from memory, as before.
- **Saving a chat's members leaves the rows of members who stayed alone.** It deleted and wrote again every row, which
  would clear the stored kind of every member on each sync.
- **`people.linkProposals` pages in SQL when it lists everyone's proposals.** It read, parsed and resolved every link
  proposal of every status before it took the page: 213 to 244 ms for 500 of 25,000 proposals, now 18 ms. memo's
  `people review` reads it. A list for one person still reads them all, since merges decide whose a proposal is now.
