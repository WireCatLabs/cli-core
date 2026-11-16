### Changed — may break callers

- **`CrmRun.user` is required**: the sign-in's own CRM user, read from its sign-in entry without the network (b24 and
  amo: `signInOf(command).userId`), or `null` when the sign-in names none or the CRM limits nobody. Set it in the
  change that bumps this version. With `null`, a CRM that limits its users shows the profile none of the copy's deals
  and leads offline; a copy no sync of this version recorded shows only the profile's own until its next `sync`. Both
  answers say why in a note and carry `complete: false`. A source with `self()` and no `isAdmin()` counts nobody as
  the administrator: give it `isAdmin()` so its administrator reads the whole copy again.
- **`owner:me` in `deals list` and `leads list` is the profile's own user** (`CrmRun.user`), and the copy's `self`
  setting only when the CLI passes none.

### Security

- **A profile reads offline only its own part of another profile's copy.** The copy is kept per CRM account, so a
  profile signed in as an ordinary user on the same account as the administrator read every deal the administrator
  synced, and `search all` found them by their contacts' e-mails and phones. Now `deals list|show`, `leads list|show`,
  `pipelines list|show`, `stages list` and `search all` show such a profile only the deals and leads assigned to its
  user: another one's, or an unassigned one, is `not_found`, and the reports count only its own. `search all` of such a
  profile reads no other CRM account's copy; anyone else's reads each other copy as that copy's owner may, and one with
  no owner not at all. `store status` says its counts are the whole copy's. The CRM's administrator, as the last `sync`
  of that sign-in found, and a CRM that limits nobody read the whole copy as before. See "Offline reads of the copy" in
  `docs/dev/CRM.md`.
