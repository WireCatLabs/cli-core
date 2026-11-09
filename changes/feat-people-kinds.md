### Changed — may break callers

- **`store.people.list` lists one kind of person at a time**, `person` by default, instead of hiding everyone with no
  tie. `kind` is `person`, `organization`, `automated`, `unsorted` or `all`; the `all` option and `hidden` are gone,
  and `counts` gives how many each kind holds. The first rule that holds decides the kind, and `kindSignals` names
  it: the owner, people added by hand and task assignees are a `person`; a bot, a no-reply address, a sender most of
  whose mail is in the bulk box, a sender memo scored `bulk_never_replied`, or a name such as «Notifications» or
  «Рассылка» is `automated`; an identity an organization owns, a shared role address (`info@`) or a legal form or
  company word in the name (ООО, LLC, Airlines, Hotel, Team…) is an `organization`; a named person with a tie is a
  `person`; everyone else, with no tie or nothing to show as a name, is `unsorted`.
- `sort` takes `interactions` (the default: most messages and mail from them first), `recent`, `name` or `tasks`.
- Each listed person has `kind`, `kindSignals`, `contact` (the phone, else the email, else `@username`),
  `messagesFrom` and `lastContact`. On a synthetic store of 51,000 people and 1.5 million messages a list takes about
  0.5–0.6 s on a loaded machine and 1.9 s sorted by `recent`; a name search reads only the people it found
  ([cli-testing `performance/people/kinds`](https://github.com/WireCatLabs/cli-testing/tree/main/performance/people/kinds)).
- An unknown `kind` or `sort` is refused. A sender counts as bulk mail from 3 letters on; a role address makes an
  `organization` only when every address of the person is one.
- `displayName` reads a messenger's placeholder for a missing name (`null`, «Без имени», `Deleted Account`) as no
  name, so the username, phone or email shows instead; `nameKey` gives such a name no key, so two deleted
  accounts are never proposed as one person.
