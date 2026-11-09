### Added

- **`relations.syncReported` takes `onOutcome`**, called once per relationship with `{ outcome, key, id }`: `added`,
  `kept`, `restored`, `withdrawn`, `proposed` or `skipped`, the relationship's key (`kind|from|to|role`) and the link
  that answers for it (`null` when proposed or skipped). An import that reports in parts counts each one once per run.
- **A relationship answers `sourceRoles`**: the source's own words for it off the role list
  (`metadata.source_role`). The CRM sync stores them as a list. An older row that holds one word still reads as a list.
- **Person, organization and deal contexts with their business relationships.** `canonicalPersonContext` answers
  for any `person:<uid>` — a CRM contact, a name with no identity, someone two accounts saw — reading every account
  in scope, with a `business` section (organizations, reporting lines both ways, deals and leads, projects,
  categories) and `coverage`. `organizationContext` gives an organization's people, customers, suppliers, partners,
  projects, open deals, invoices, payments and orders, counts of messages, mail and meetings through its people, and
  open tasks. `dealContext` gives a deal's or lead's stages, client, participants, owner, project, money reached by
  project or counterparty, and its people's messages, mail and meetings in its lifetime marked `proposed`;
  `dealBrief` is its compact form. Every relationship says its standing, every section is bounded, and the shared
  entities `person_context`, `organization_context`, `deal_context` and `deal_context.brief` describe them.
  `organizationsInCategory` lists clients, suppliers, partners or employers, derived from relationships.
  `@wirecat/cli-core/crm/testing` exports `acmeScenario`, a synthetic store for these. See
  `docs/dev/BUSINESS-CONTEXT.md`.
- **Stage history, a CRM deal's project, own organizations, orders by supplier, organizations by category.**
  `deals.stages(ref)` lists every stage a deal or lead entered; `deals.setProject(ref, { project, by })` sets its
  project, on a CRM copy too: the project is the store's own field, which the CRM sync never writes.
  `knowledge.ownOrganizations()` lists the owner's companies, his own mark first, else the CRM's;
  `orders.list({ supplier })`; `deals.list({ accounts })` (copies from those CRM accounts, the owner's own always);
  `knowledge.organizations(query, { category, accounts })` keeps one category's, chosen
  in SQL. A context's `coverage` names each CRM account's sync gaps (`crmGapsOf`) and each kind the profile denies
  (`deniedKinds`: no deal or lead row, title or count is answered). A relationship (`knowledge.relations`) answers
  the `account` that reported it and how a source `derived` it.
- **Account groups for memo's group word (WC-ACCT-13).** The default group is `all`: every account, never saved, so
  a run with no group reads everything, as before. A group the owner saves (`account_groups.<name>`) is exactly its
  list, `personal` like any other, and a group never saved does not exist. Groups and the lock are opt-in narrowing
  for agents; the default still reads everything. `search notes` in a group reads memo's own notes beside the group's
  folders, since they are the owner's.
- **`runGroup` and `scopeToGroup`.** memo lifts the first word with `liftProfile`, as every CLI does. `runGroup` takes
  it, or `<PREFIX>_GROUP`; `all` means no restriction, and a word that is no group name is `validation_error`. Under
  `<PREFIX>_GROUP_LOCK` it refuses any other group, `all` included, with `permission_error`; a lock of `all` locks
  nothing. `scopeToGroup` turns a run's `--source` into the group: none becomes `group:<name>`, a bare provider or
  kind keeps the group's accounts of it, and `all` anywhere in the list, an account outside the group or a write's
  `--account` outside it is refused (`validation_error`, or `permission_error` under the lock), naming the entry as
  typed. An empty group fails as `group <name> is empty`; an unknown one is `validation_error` with
  `details.groups`, and `details.suggested` when profiles carry its name. From `@wirecat/cli-core/cli` and
  `@wirecat/cli-core/services`; memo wires them in its own release.
- **Under `<PREFIX>_GROUP_LOCK` a run refuses what does not keep to the group (`permission_error`).** A command
  runs only when it, or a command above it, is marked `groupAware(command)` (`@wirecat/cli-core/cli`); `help`,
  `commands` and the other words that read no account still run. Every reference typed into the run, in an argument
  or an option value (`msg:`, `chat:`, `deal:`, `person:`, `event:`, …), is checked by
  `refuseOutsideGroup(command, { app, env, store? })`: account data that belongs only to accounts outside the group
  is refused, such as a message, a chat, mail, a calendar event, a CRM row, or a person seen only by outside
  accounts. What the owner made, with no account (memo's notes, projects, tasks, invoices, owner deals and
  organizations, memories, facts), passes in every group. A bare id counts too, as `<kind>:<id>`, where the command
  says its kind: `refKinds(command, { id: "organization", "--note": "note" })`, or an argument or `--<kind>` option
  named after a kind (`<organization>`, `--project`). A command that declares no kinds has any other argument value
  refused; `refKinds(command, {})` lets free text through. `store.refs.accounts(ref)` says which accounts a
  reference's thing belongs to (`[]` for the owner's own); an event is its calendars' and meetings' accounts, a
  folder's file is its folder (`notes:<id>`). `inGroupOf(context, group)` (services) is the membership test.
  Group edits are refused under the lock, and `listAccountGroups` lists only the locked group.
- **What a locked run shows of proposals and evidence: `groupGuardOf(store, app, env)` and `lockedRegistry`**
  (services). The guard says whether a reference is `visible` in the locked group (every part of its thing: a
  proposed action is its own account and its target's, a suggested link its two ends), `keep`s the visible references
  of a list and `strip`s outside ones from every `evidence` and `sources` array of an answer, counting them as
  `out_of_scope`; a memory's or fact's own text stays. `lockedRegistry` wraps the proposal registry so a proposal whose
  subject, object or action is outside the group is not listed, shown or decided (`permission_error`), and shown ones
  keep only the group's evidence. `refKinds` takes `action` (`actions confirm 17`) and `proposal` (`review confirm
  17070,link:17,fact:512`), and `store.refs.ends(ref)` gives each part. A key-document suggestion (`key:9`) is its
  link's two ends, so a Drive or mail document of an outside account is refused; a close suggestion (`close:Q-15`) is
  its task's, the owner's, with its evidence stripped; any other proposal prefix is refused. Under the lock `listContextOf` holds only the
  group's accounts, notes folders included.
- **Under `<PREFIX>_GROUP_LOCK`, `listContextOf` holds only the group's accounts**, so every `--source` reader fails
  closed: a list, a bare provider or `all` resolves inside the group, and `search messages`, `search mail` and
  `search notes` without `--source` read the group. A lock naming no saved group is `permission_error`. The lock is
  read from the run's `env` only, never `process.env`: `groupLockOf(app, env)`, `listContextOf(…, env)`,
  `listedAccounts(…, env)`, `env` on `prepareLucene`/`searchLucene`'s messenger, on `searchNotesOf` and on a
  `GroupStore`. A caller that passes no `env` reads without a lock.
- **Group membership for a settings page: `listAccountGroups`, `addGroupMember`, `removeGroupMember`,
  `moveGroupMember`** (services), over `store.accounts.changeAccountGroups`. The list gives each saved group, then
  `all` with every account (reason `all`), each member with every saved entry that names it, its profile names in
  every app, its reason (`setting`) and `also_in`, plus `duplicates` (allowed, shown) and `suggested`: a profile name
  that another app's profile or a saved group shares, for an account not in that group; never applied. A member is
  saved as `provider:account`, so renaming a profile changes nothing. memo's own notes (`notes:internal`) and an
  unsaved running account are listed in no group. A remove takes out every entry that names only that account, and
  refuses one that names others too; a move does that and the add in one write, deciding which entries go inside it;
  a move from `all` is an add. `all`, `bots` and the caller's `reserved` words cannot name a group, and `config set
  account_groups.all` and `.bots` are refused.
- **`deniedKindsOf(permissions, kinds, by, defaults?)`** (`@wirecat/cli-core/cli`, with `deniedKinds`): the kinds
  `search all` leaves out under a CLI's own permission levels, such as memo's, without messenger profile settings.
- **The first CRM sync of an account no saved group lists answers `group_hint`**: ``add it to a work group:
  `memo groups add work <provider>:<account>` `` (memo's command ships with it). Not when a saved group lists the
  account, and not on later syncs. `hint` still carries "run sync again to continue".
- **A CRM sync copies only the owner's deals and leads by default.** The account setting
  `crm.<provider>:<account>.scope` is `mine` (the default) or `all`; `crm.<provider>:<account>.unassigned` lists the
  CRM's numeric user ids whose deals and leads count as nobody's, which `mine` also keeps, as it keeps those with no
  assignee. Both are set with `settings set`, which refuses a malformed `unassigned` entry by name. Contacts and
  companies are copied whole as before. A source opts in with `self()`, its sign-in's own user; the engine applies
  the scope to every page (`CrmScope`: `{ mode: "all" }` or `{ mode: "mine", self, also }`, ids normalised by
  `normalCrmUserId`), so a deal given to another user leaves the copy at the next sync. A narrower scope is applied in
  the store by each row's assignee, with no list from the CRM; a wider one lists deals and leads in full again. The
  sync answer carries `scope` and each kind's `out_of_scope`; a kind that failed on a setting names it (`setting`)
  and the answer offers no retry.
- **`store status` says each deal and lead kind's scope without a sync**: `scope.setting` is the saved
  `crm.<provider>:<account>.scope` (`mine` when never set; `scope.explicit` says whether the owner stored it), and
  `scope.applied` the scope new pages are read under, `{ mode: "all" }` or `{ mode: "mine", users }` (the own user
  and the unassigned ones), `null` before the first sync. `scope.held: true` while a held narrowing keeps stored rows
  outside it. `applied` is `all` under `mine` when the CRM's CLI names no own user (`self()`): its sync copies
  everything.
- **A default `mine` that would mark most of a kind deleted is held** (`crm.narrowing-held`, naming the own user and
  the count, and `held: true` on the kind) until the owner sets the `scope` setting; `--rescan` does not lift it.
  While held, new pages are read under `mine` and the stored rows are kept; a later `scope all` lists every deal
  and lead again. `config set` of a CRM account's `scope`, `self` or `unassigned` stops an agent's run
  (`permission_error`), a guard against a change by mistake rather than a boundary. `self()` must answer a numeric user id
  (`invalid_response` otherwise), and `crmSourceContract` checks that such a source gives every deal and lead an
  assignee.
- **One account's copy belongs to one CRM user.** The first sync of a source with `self()` stores it as
  `crm.<provider>:<account>.self`; a sync signed in as another user is refused (`validation_error`, the setting in
  `details.setting`) until the owner unsets it.
- **`writesWithOf(account, profilesFor)` and `storedProfilesFor(profiles)`** (`./cli`): which CLI and profile change a
  CRM copy on its server, so memo's `deals list`, `leads list` and `pipelines list` can name the writer of each row as
  `writes_with: { tool, account, profile, profiles, why }`. `tool` is the command that registered the row's provider;
  `profile` is set only when exactly one of that CLI's profiles is recorded on the row's account, otherwise it is
  `null` and `profiles` and `why` say what there is to choose. The owner's own row answers `null`. The profiles come
  from the store's record, which every run of a CLI saves, so a profile appears once it has run with that account.
  `profilesOn(profiles, app, key)` is the filter both use.
  `writesWithOf(…, { allowed })` takes the caller's profile or group lock: a profile it forbids is never named, and
  the one it leaves is the answer. A write already refuses a row of another account than its profile's live one
  (`not_found`), so a profile re-pointed to another portal cannot change the old portal's rows.
- **Base stages of deals and of leads, and CRM stages mapped onto them (store version 60).** One editable base set
  per kind; every other pipeline's stage, a CRM's or the owner's own, maps onto one of its stages, suggested by the store and confirmed by the owner, one by one
  or all at once. Store version 60 adds `pipeline_stages.base_stage_id` and `base_confirmed` (columns only;
  `minCompatible` stays 56). `baseStagesCommand(app, { open, output, accounts })` from `./cli` builds the `stages`
  group for memo: `show <kind>` (the columns, with open rows and mapped CRM stages each, and `unsorted`), `create`,
  `rename`, `move` and `remove` of a base stage, `list` (every stage outside the base sets with `base_stage`, `confirmed` and the CRM's own `external_id`, which a CRM CLI's move matches first; `account` and `external_id` `null` for an own pipeline; query
  `kind:`, `pipeline:`, `confirmed:`), `set <stage> <base-stage>` and `confirm --pipeline <p> | --all`. `accounts`
  narrows reads and confirms to the CRM accounts a run may see, such as a group lock's. Deal and lead rows gain
  `base_stage {ref, name}`, `null` until confirmed. A new set is named in the owner's first language (Russian while
  `owner_languages` is unset, Spanish, else English); the seeded `Leads` becomes the lead set with capitalised names. An
  agent's `stages set` records a suggestion; `confirm` and the set's edits refuse an agent (`stage.owner-only`). On a
  read-only store `stages show` reads the set its first use would make without writing it. A CRM CLI's `deals move <ref> stage:<id>` (and `leads move`) moves
  to the one stage of the card's pipeline mapped to that base stage, and refuses several (`stage.choice-required`,
  with `candidates`) or none (`stage.unmapped`) before anything is written. `store.baseStages` holds the same
  operations.

### Changed — may break callers

- `DealsStore` gains `stages` and `setProject`, and `OrganizationsStore` (so `KnowledgeStore`) gains
  `ownOrganizations`: a hand-written store or fake implementing them must add these.
- **`listContextOf` returns a `GroupContext`**, a `ListContext` with `membership`, and `group:all` names every
  account in a `--source` list.
- **The sync of an account whose source names its own user narrows to `mine` on its first run after the upgrade**,
  unless that would mark more than half of a kind deleted (then it is held until the owner sets the scope):
  other users' deals and leads are marked deleted in the local copy. They leave lists and search, but their earlier
  copy stays in the store file. `settings set crm.<provider>:<account>.scope all` brings them back.
- **An id list that is empty is held whatever the copy's size**: a small copy is no longer emptied by it without
  `--rescan`.
- **`CrmCopies.scope`, `ownUser`, `saveOwnUser` and `removeOutOfScope` are new required members**, and
  `CrmSyncReport.scope` and `CrmSyncResult.outOfScope` are new required fields: a hand-made store object or a strict
  reader of the answer needs them.

### Fixed

- **A relationship the owner confirmed counts as `kept` when a source reports it again.** It counted nowhere.
- **A reported relationship no longer duplicates the owner's link for the role its source named.** When the owner
  confirmed or overrode a no-role link whose `metadata.source_role` (one word or a list) holds a role, and a source
  later reports that role on the same pair, `relations.syncReported` adds no second link: the owner's stays the answer.
- **`relations.syncReported` withdraws only the links its own writer wrote**: those whose `links.source` is the
  call's `source`. A CRM sync (`crm`) and an import on one account no longer withdraw each other's links.
- **A role only withdrawn links hold can be removed.** `knowledge.removeRole` no longer counts them as uses.
- **A link `relations.syncReported` writes carries the caller's author** (`by.kind`), not always `rule`, and a link
  it still reports unchanged is not written again, so a sync no longer queues its people for involvement every page.
