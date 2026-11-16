### Changed — may break callers

- **A CRM CLI passes the sign-in's own user to `CrmRun.user`**, read from its sign-in entry without the network (b24
  and amo: `signInOf(command).userId`). Without it, a CRM that limits its users shows the profile none of the copy's
  deals and leads offline. A copy synced by an older version shows only the profile's own deals until its next `sync`,
  which records who the CRM's administrator is. A source with `self()` and no `isAdmin()` counts nobody as the
  administrator: give it `isAdmin()` so its administrator reads the whole copy again.
- **`owner:me` in `deals list` and `leads list` is the profile's own user** (`CrmRun.user`), and the copy's `self`
  setting only when the CLI passes none.

### Security

- **A profile reads offline only its own part of another profile's copy.** The copy is kept per CRM account, so a
  profile signed in as an ordinary user on the same account as the administrator read every deal the administrator
  synced, and `search all` found them by their contacts' e-mails and phones. Now `deals list|show`, `leads list|show`,
  `pipelines list|show`, `stages list` and `search all` show such a profile only the deals and leads assigned to its
  user: another one's is `not_found`, the reports count only its own, and search never matches another user's deal of
  this account or its contacts. The CRM's administrator, as the last `sync` of that sign-in found, and a CRM that limits
  nobody read the whole copy as before. See "Offline reads of the copy" in `docs/dev/CRM.md`.
