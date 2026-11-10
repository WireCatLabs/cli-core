### Added

- **A CRM copy under scope `mine` keeps only its clients' contacts.** After a sync that narrowed the copy or ran with
  `--rescan`, and finished every kind, one transaction removes each contact that no kept deal or lead of the chosen
  users names, and that is no contact of a kept company. The person it made goes too, unless anything else is left on
  them: another identity such as mail, a note, an alias, a mention, the owner's link decision. A contact the owner
  linked or unlinked himself stays. People named after a contact lose an import's `null` / `null #<id>` from their
  name; the owner's person is never renamed. The sync answer gives the counts as `contacts_removed`. Before, a
  narrowed copy kept every contact for good: the CRM's deletion check skips contacts.
- **`store apply`** does the same for the contacts already stored, for the users scope `mine` keeps (`self` and
  `unassigned`) whatever the scope is now: counts only, unless `--yes` under scope `mine`.
- `CrmCopies.removeContacts`.

### Fixed

- **Saving, changing or removing a deal's or lead's link to a person no longer reads every link to a person.**
  Store version 64 recreates version 63's person-kind triggers on deal links and on a deal owner's moves so they look
  a deal's people up by the deal. On a store with 118k person links, removing 635 links took 15 s and now takes
  0.4 s.
